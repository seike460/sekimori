import type { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { linkedFromRows, queryTransactionSearch } from "./transaction-search.js";
import {
  flattenDocs,
  spanIdFromTraceparent,
  xrayDocContextSource,
  xrayDocLinked,
  xrayDocTraceLinked,
  xrayParentIdFromHeader,
  xrayTraceIdFromHeader,
  xrayTraceIdFromTraceparent,
} from "./xray-doc.js";

describe("linkedFromRows (Transaction Search)", () => {
  const emitter = { name: "emit", traceId: "t1", spanId: "e1" };

  it("is linked when the consumer link0 matches an emitter spanId", () => {
    const r = linkedFromRows([
      emitter,
      { name: "process q", traceId: "t1", spanId: "c1", link0: "e1", parentSpanId: "i1" },
    ]);
    expect(r.linked).toBe(true);
    expect(r.sameTrace).toBe(true);
  });

  it("is linked when link0 matches the producer spanId from the emitter response", () => {
    // emitter row がまだ index されていなくても、response の traceparent から
    // 取れる spanId と一致すれば linked（indexing race 対策）。
    const r = linkedFromRows(
      [{ name: "process q", traceId: "t1", spanId: "c1", link0: "p9", parentSpanId: "i1" }],
      "p9",
    );
    expect(r.linked).toBe(true);
  });

  it("is linked when the consumer parentSpanId matches an emitter spanId", () => {
    const r = linkedFromRows([
      emitter,
      { name: "process q", traceId: "t9", spanId: "c1", link0: "", parentSpanId: "e1" },
    ]);
    expect(r.linked).toBe(true);
    expect(r.sameTrace).toBe(false);
  });

  it("is NOT linked on same-trace membership alone (R3-C-1)", () => {
    // invocation span は _X_AMZN_TRACE_ID 経由で常に emitter の trace に載るため、
    // traceId 一致だけでは link の証拠にならない。
    const r = linkedFromRows([
      emitter,
      { name: "process q", traceId: "t1", spanId: "c1", link0: "", parentSpanId: "i1" },
    ]);
    expect(r.linked).toBe(false);
    expect(r.sameTrace).toBe(true);
  });

  it("is NOT linked when parentSpanId points at a span without probe_id (own invocation)", () => {
    // consumer invocation span は probe_id を持たず rows に出ないため、
    // parentSpanId == invocation span は emitterIds に入らず一致しない。
    const r = linkedFromRows([
      emitter,
      { name: "process q", traceId: "t1", spanId: "c1", link0: "", parentSpanId: "inv1" },
    ]);
    expect(r.linked).toBe(false);
  });

  it('does not link on empty fields ("" === "" false positive)', () => {
    const r = linkedFromRows([
      { name: "emit", traceId: "", spanId: "" },
      { name: "process q", traceId: "", spanId: "c1", link0: "", parentSpanId: "" },
    ]);
    expect(r.linked).toBe(false);
    expect(r.sameTrace).toBe(false);
  });

  it("finds a linked consumer row even when an earlier process row is unrelated", () => {
    // process span は複数 index され得る — 先頭 row だけを見て諦めない。
    const r = linkedFromRows([
      emitter,
      { name: "process q", traceId: "t7", spanId: "c0", link0: "", parentSpanId: "x1" },
      { name: "process q", traceId: "t1", spanId: "c1", link0: "e1", parentSpanId: "i1" },
    ]);
    expect(r.linked).toBe(true);
    expect(r.consumer?.spanId).toBe("c1");
  });

  it("reports linkFieldsPresent=false when no consumer row carries a link field", () => {
    const r = linkedFromRows([
      emitter,
      { name: "process q", traceId: "t1", spanId: "c1", link0: "", parentSpanId: "i1" },
    ]);
    expect(r.linkFieldsPresent).toBe(false);
  });
});

describe("xrayDocLinked / xrayDocTraceLinked (X-Ray fallback)", () => {
  const emitterTraceId = "1-aaaa-bbbb";
  const producerSpanId = "e1";

  it("is linked when a link id matches the producer span id", () => {
    expect(xrayDocLinked({ name: "process q", links: [{ id: "e1" }] }, producerSpanId)).toBe(true);
  });

  it("is linked when a link id AND trace_id both match the producer", () => {
    expect(
      xrayDocLinked(
        { name: "process q", links: [{ id: "e1", trace_id: emitterTraceId }] },
        producerSpanId,
      ),
    ).toBe(true);
  });

  it("is NOT linked when a link trace_id matches but the span id differs", () => {
    // emitter trace 内の別 span（AWS 中継 node 等）への link は dead link になり得るため
    // linked とはしない。弱い証拠として xrayDocTraceLinked が拾う。
    const doc = { name: "process q", links: [{ id: "dead", trace_id: emitterTraceId }] };
    expect(xrayDocLinked(doc, producerSpanId)).toBe(false);
    expect(xrayDocTraceLinked(doc, emitterTraceId)).toBe(true);
  });

  it("is linked when parent_id matches the producer span id", () => {
    expect(xrayDocLinked({ name: "process q", parent_id: "e1" }, producerSpanId)).toBe(true);
  });

  it("is NOT linked when parent_id only points at the own invocation span", () => {
    // emitter trace 内の全 doc id と比較すると consumer invocation span が必ず一致し
    // link 無しでも linked=true になる — parent 判定は producerSpanId に限る。
    expect(
      xrayDocLinked(
        { name: "process q", trace_id: emitterTraceId, parent_id: "inv1" },
        producerSpanId,
      ),
    ).toBe(false);
  });

  it("is NOT linked on same trace_id alone", () => {
    expect(
      xrayDocLinked({ name: "process q", trace_id: emitterTraceId, parent_id: "i1" }, "e1"),
    ).toBe(false);
  });

  it("does not link when ids are undefined (undefined === undefined)", () => {
    // links エントリに id が無く、producerSpanId も不明 — undefined 一致にしない。
    expect(xrayDocLinked({ name: "process q", links: [{}] }, undefined)).toBe(false);
    expect(xrayDocTraceLinked({ name: "process q", links: [{}] }, undefined)).toBe(false);
  });
});

describe("trace id conversion", () => {
  it("converts a W3C traceparent to an X-Ray trace id", () => {
    expect(
      xrayTraceIdFromTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"),
    ).toBe("1-4bf92f35-77b34da6a3ce929d0e0e4736");
  });

  it("converts an X-Ray header Root to a trace id", () => {
    expect(
      xrayTraceIdFromHeader(
        "Root=1-5759e988-bd862e3fe1be46a994272793;Parent=53995c3f42cd8ad8;Sampled=1",
      ),
    ).toBe("1-5759e988-bd862e3fe1be46a994272793");
  });

  it("extracts the producer spanId from a traceparent", () => {
    expect(spanIdFromTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")).toBe(
      "00f067aa0ba902b7",
    );
  });

  it("extracts the producer spanId from an X-Ray header Parent field (R11-C)", () => {
    // `traceparent` が欠落/非 `00` version のとき `Parent=` が同じ相関値を持つ。
    expect(
      xrayParentIdFromHeader(
        "Root=1-5759e988-bd862e3fe1be46a994272793;Parent=53995c3f42cd8ad8;Sampled=1",
      ),
    ).toBe("53995c3f42cd8ad8");
    expect(xrayParentIdFromHeader("Root=1-5759e988-bd862e3fe1be46a994272793")).toBeUndefined();
    expect(xrayParentIdFromHeader(undefined)).toBeUndefined();
  });

  it("returns undefined for malformed input", () => {
    expect(xrayTraceIdFromTraceparent("garbage")).toBeUndefined();
    expect(xrayTraceIdFromHeader(undefined)).toBeUndefined();
    expect(spanIdFromTraceparent("garbage")).toBeUndefined();
  });
});

describe("flattenDocs", () => {
  it("walks subsegments depth-first", () => {
    const flat = flattenDocs([
      { id: "a", subsegments: [{ id: "b", subsegments: [{ id: "c" }] }, { id: "d" }] },
      { id: "e" },
    ]);
    expect(flat.map((d) => d.id)).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("linkSpanIds / carrier attribution (R7-C)", () => {
  it("scans every link in the raw links field, not only links.0", () => {
    // producer への link が先頭要素でなくても linked 判定できる。
    const r = linkedFromRows([
      { name: "emit", traceId: "t1", spanId: "e1" },
      {
        name: "process q",
        traceId: "t1",
        spanId: "c1",
        links: JSON.stringify([
          { spanId: "other-span", traceId: "t9" },
          { spanId: "e1", traceId: "t1" },
        ]),
      },
    ]);
    expect(r.linked).toBe(true);
  });

  it("falls back to link0 when links is not parseable JSON", () => {
    const r = linkedFromRows([
      { name: "emit", traceId: "t1", spanId: "e1" },
      { name: "process q", traceId: "t1", spanId: "c1", link0: "e1", links: "not-json" },
    ]);
    expect(r.linked).toBe(true);
  });

  it("reports the carrier source from the consumer row", () => {
    const r = linkedFromRows([
      { name: "emit", traceId: "t1", spanId: "e1" },
      {
        name: "process q",
        traceId: "t1",
        spanId: "c1",
        link0: "e1",
        ctx_source: "message-attributes",
      },
    ]);
    expect(r.contextSource).toBe("message-attributes");
  });

  it("reports contextSource undefined when the row lacks it", () => {
    const r = linkedFromRows([
      { name: "emit", traceId: "t1", spanId: "e1" },
      { name: "process q", traceId: "t1", spanId: "c1", link0: "e1" },
    ]);
    expect(r.contextSource).toBeUndefined();
  });
});

describe("xrayDocContextSource", () => {
  it("reads sekimori.context.source from annotations or metadata", () => {
    expect(
      xrayDocContextSource({ annotations: { "sekimori.context.source": "body-detail" } }),
    ).toBe("body-detail");
    expect(
      xrayDocContextSource({
        metadata: { "sekimori.context.source": { StringValue: "aws-trace-header" } },
      }),
    ).toBe("aws-trace-header");
    expect(xrayDocContextSource({})).toBeUndefined();
    expect(xrayDocContextSource(undefined)).toBeUndefined();
  });
});

describe("queryTransactionSearch", () => {
  afterEach(() => vi.useRealTimers());

  /**
   * StartQuery / GetQueryResults を input 形で見分ける fake client。
   * send は overload 群なので最小形を名前付きキャストで包む。
   */
  function fakeLogs(results: Record<string, string>[][]): CloudWatchLogsClient {
    let call = 0;
    const toFields = (row: Record<string, string>) =>
      Object.entries(row).map(([field, value]) => ({ field, value }));
    return {
      send: vi.fn(async (cmd: { input: Record<string, unknown> }) =>
        cmd.input.logGroupName !== undefined
          ? { queryId: "q1" }
          : { status: "Complete", results: (results[call++] ?? []).map(toFields) },
      ),
    } as unknown as CloudWatchLogsClient;
  }

  it("returns as soon as a consumer row links to producerSpanId, without waiting for the emitter row (R8-C)", async () => {
    vi.useFakeTimers();
    // consumer row のみ — emitter row はまだ index されていないが link は確定済み。
    const logs = fakeLogs([[{ name: "process q", traceId: "t1", spanId: "c1", link0: "p9" }]]);
    const pending = queryTransactionSearch(logs, "probe-1", "p9", Date.now() + 60_000);
    await vi.advanceTimersByTimeAsync(31_000);
    const rows = await pending;
    expect(rows?.[0]?.name).toBe("process q");
    // Start + GetQueryResults の 2 回だけ — producer row を待つ再 poll はしない。
    expect(logs.send).toHaveBeenCalledTimes(2);
  });

  it("keeps polling when no consumer row links to the producer yet", async () => {
    vi.useFakeTimers();
    const logs = fakeLogs([
      [{ name: "process q", traceId: "t1", spanId: "c1", link0: "" }],
      [
        { name: "process q", traceId: "t1", spanId: "c1", link0: "p9" },
        { name: "emit", traceId: "t1", spanId: "e1" },
      ],
    ]);
    const pending = queryTransactionSearch(logs, "probe-1", "p9", Date.now() + 120_000);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(logs.send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(31_000);
    const rows = await pending;
    expect(rows).toHaveLength(2);
    expect(logs.send).toHaveBeenCalledTimes(4);
  });
});
