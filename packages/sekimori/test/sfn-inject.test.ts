import { context, type SpanContext, trace } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  extractFromStateInput,
  injectStartExecution,
  parseXrayTraceHeader,
  SFN_TRACE_FIELD,
} from "../src/index.js";
import { type OtelHarness, setupOtel } from "./otel-setup.js";

const harness: OtelHarness = setupOtel("w3c");
const tracer = trace.getTracer("test");
afterAll(() => harness.teardown());
beforeEach(() => harness.reset());

function start(input: Parameters<typeof injectStartExecution>[0] = {}) {
  let producer!: SpanContext;
  let injected!: ReturnType<typeof injectStartExecution>;
  tracer.startActiveSpan("start-execution", (span) => {
    producer = span.spanContext();
    injected = injectStartExecution(input);
    span.end();
  });
  return { producer, injected };
}

describe("injectStartExecution", () => {
  it("writes traceHeader (X-Ray format) and _trace (W3C) into the input JSON", () => {
    const { producer, injected } = start({ input: JSON.stringify({ orderId: "o-1" }) });
    expect(parseXrayTraceHeader(injected.traceHeader)).toMatchObject({
      traceId: producer.traceId,
      spanId: producer.spanId,
    });
    const parsed = JSON.parse(injected.input!);
    expect(parsed.orderId).toBe("o-1");
    expect(parsed[SFN_TRACE_FIELD].traceparent).toContain(producer.traceId);
    expect(parsed[SFN_TRACE_FIELD]["x-amzn-trace-id"]).toBeUndefined();
  });

  it("merges carrier keys into an existing _trace object, preserving non-carrier keys (R8-A)", () => {
    const { producer, injected } = start({
      input: JSON.stringify({ [SFN_TRACE_FIELD]: { custom: "x" }, orderId: "o-1" }),
    });
    const parsed = JSON.parse(injected.input!) as Record<string, unknown>;
    const field = parsed[SFN_TRACE_FIELD] as Record<string, unknown>;
    expect(field.custom).toBe("x");
    expect(field.traceparent).toContain(producer.traceId);
    expect(parsed.orderId).toBe("o-1");
  });

  it("does not overwrite a non-object _trace (primitive stays untouched)", () => {
    const input = JSON.stringify({ [SFN_TRACE_FIELD]: "user-string", v: 1 });
    const { injected } = start({ input });
    expect(injected.input).toBe(input);
  });

  it("keeps a caller-supplied _trace and traceHeader", () => {
    const own = { traceparent: "00-11111111111111111111111111111111-2222222222222222-01" };
    const { injected } = start({
      input: JSON.stringify({ [SFN_TRACE_FIELD]: own }),
      traceHeader: "Root=1-00000000-000000000000000000000001;Parent=0000000000000001;Sampled=1",
    });
    expect(JSON.parse(injected.input!)[SFN_TRACE_FIELD]).toEqual(own);
    expect(injected.traceHeader).toContain("Root=1-00000000");
  });

  it("still sets traceHeader when input is not JSON", () => {
    const { injected } = start({ input: "not json" });
    expect(injected.input).toBe("not json");
    expect(injected.traceHeader).toBeDefined();
  });

  it("is a no-op without an active span", () => {
    const out = injectStartExecution({ input: "{}" });
    expect(out.traceHeader).toBeUndefined();
    expect(out.input).toBe("{}");
  });
});

describe("Round-9 hardening", () => {
  it("rejects inputs over the 256 KiB StartExecution limit instead of letting AWS reject them (R9-A)", async () => {
    const { SekimoriError } = await import("../src/index.js");
    expect(() =>
      injectStartExecution({ input: JSON.stringify({ d: "x".repeat(300 * 1024) }) }),
    ).toThrow(SekimoriError);
  });
});

describe("suppression (R11-A)", () => {
  it("writes no traceHeader and keeps input untouched when the context is suppressed", () => {
    tracer.startActiveSpan("sfn-sup", (span) => {
      const injected = injectStartExecution(
        { input: JSON.stringify({ a: 1 }) },
        { context: suppressTracing(context.active()) },
      );
      span.end();
      expect(injected.traceHeader).toBeUndefined();
      expect(injected.input).toBe(JSON.stringify({ a: 1 }));
    });
  });
});

describe("Round-12 hardening (pinned traceparent conflict)", () => {
  const PIN_A = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
  const XRAY_A = "Root=1-aaaaaaaa-aaaaaaaaaaaaaaaaaaaaaaaa;Parent=bbbbbbbbbbbbbbbb;Sampled=1";
  const XRAY_C = "Root=1-cccccccc-cccccccccccccccccccccccc;Parent=dddddddddddddddd;Sampled=1";

  it("suppresses traceHeader and keeps the caller's xray field on a _trace pin conflict", () => {
    tracer.startActiveSpan("sfn-pin-conflict", (span) => {
      const injected = injectStartExecution({
        input: JSON.stringify({
          [SFN_TRACE_FIELD]: { traceparent: PIN_A, "x-amzn-trace-id": XRAY_A },
        }),
      });
      span.end();
      const record = JSON.parse(injected.input ?? "{}") as Record<string, unknown>;
      const field = record[SFN_TRACE_FIELD] as Record<string, string>;
      expect(field.traceparent).toBe(PIN_A);
      expect(field["x-amzn-trace-id"]).toBe(XRAY_A);
      expect(injected.traceHeader).toBeUndefined();
    });
  });

  it("honors a root-level pin (state-input-flattened slot) instead of shadowing it", () => {
    // input 直下の pin も carrier slot — `_trace` に fresh な span pair を書くと
    // extract が `_trace` を先に読み root pin が shadow される。衝突時は
    // traceHeader も抑止し、`_trace` は（carrier が空なら）新設しない。
    tracer.startActiveSpan("sfn-root-pin", (span) => {
      const injected = injectStartExecution({
        input: JSON.stringify({ orderId: "o-1", traceparent: PIN_A }),
      });
      span.end();
      const record = JSON.parse(injected.input ?? "{}") as Record<string, unknown>;
      expect(record.traceparent).toBe(PIN_A);
      expect(record[SFN_TRACE_FIELD]).toBeUndefined();
      expect(injected.traceHeader).toBeUndefined();
    });
  });

  it("removes a stale _trace xray field that would shadow a root pin", () => {
    // `_trace` の stale な x-amzn-trace-id を残すと extract が `_trace` を先に読んで
    // root pin を shadow する — root pin 衝突時は _trace の xray slot を消す。
    tracer.startActiveSpan("sfn-root-pin-xray", (span) => {
      const injected = injectStartExecution({
        input: JSON.stringify({
          traceparent: PIN_A,
          [SFN_TRACE_FIELD]: { "x-amzn-trace-id": XRAY_C, custom: "keep" },
        }),
      });
      span.end();
      const record = JSON.parse(injected.input ?? "{}") as Record<
        string,
        Record<string, string> | string
      >;
      expect(record.traceparent).toBe(PIN_A);
      expect(record[SFN_TRACE_FIELD]).toEqual({ custom: "keep" });
      expect(injected.traceHeader).toBeUndefined();
    });
  });

  it("w3c:false scrubs input-derived W3C slots at the input root (R13)", () => {
    // input 直下の traceparent は `state-input-flattened` slot — `w3c: false` では
    // 他の carrier slot と同じく入力由来の W3C slot を stale として消す。
    tracer.startActiveSpan("sfn-w3cfalse-root", (span) => {
      const injected = injectStartExecution(
        { input: JSON.stringify({ traceparent: PIN_A, orderId: "o-1" }) },
        { w3c: false },
      );
      span.end();
      const record = JSON.parse(injected.input ?? "{}") as Record<string, unknown>;
      expect(record.traceparent).toBeUndefined();
      expect(record.orderId).toBe("o-1");
      // w3c モードの propagator では carrier に W3C しか無いため `_trace` は新設されず、
      // native channel の traceHeader が唯一の fresh context になる。
      expect(injected.traceHeader).toBeDefined();
    });
  });

  it("drops a stale root-level x-amzn-trace-id when a fresh traceHeader is written (R13)", () => {
    // extract は `_trace` が hit しない場合 input 直下（state-input-flattened）を読む —
    // 入力由来の stale xray field が残ると fresh な traceHeader と食い違う。
    tracer.startActiveSpan("sfn-root-xray", (span) => {
      const injected = injectStartExecution({
        input: JSON.stringify({ "x-amzn-trace-id": XRAY_C, orderId: "o-1" }),
      });
      span.end();
      const record = JSON.parse(injected.input ?? "{}") as Record<string, unknown>;
      expect(record["x-amzn-trace-id"]).toBeUndefined();
      expect(record[SFN_TRACE_FIELD]).toBeDefined();
      expect(injected.traceHeader).toBeDefined();
    });
  });

  it("removes a stale _trace xray field that disagrees with the _trace pin (R19)", () => {
    // `_trace` pin（trace A）と別 trace（C）の xray field が残ると xray を優先する
    // 読み手が pin に勝つ — pin の trace に照合して消す。pin と同じ trace の値は残す。
    tracer.startActiveSpan("sfn-pin-stale-xray", (span) => {
      const injected = injectStartExecution({
        input: JSON.stringify({
          [SFN_TRACE_FIELD]: { traceparent: PIN_A, "x-amzn-trace-id": XRAY_C },
        }),
      });
      span.end();
      const field = (JSON.parse(injected.input ?? "{}") as Record<string, unknown>)[
        SFN_TRACE_FIELD
      ] as Record<string, string>;
      expect(field.traceparent).toBe(PIN_A);
      expect(field["x-amzn-trace-id"]).toBeUndefined();
    });
  });

  it("removes a stale root x-amzn-trace-id that disagrees with a root pin (R19)", () => {
    tracer.startActiveSpan("sfn-root-pin-stale-xray", (span) => {
      const injected = injectStartExecution({
        input: JSON.stringify({ traceparent: PIN_A, "x-amzn-trace-id": XRAY_C }),
      });
      span.end();
      const record = JSON.parse(injected.input ?? "{}") as Record<string, unknown>;
      expect(record.traceparent).toBe(PIN_A);
      expect(record["x-amzn-trace-id"]).toBeUndefined();
    });
  });

  it("honors a root pin over an embedded detail carrier on extract (R20)", () => {
    // inject/pin 対象の slot は `_trace` と root — detail-first だと embedded
    // carrier が root pin を shadow して pin 保護が無効になる（EB→SFN の
    // event envelope に root pin が同居した形）。
    const extracted = extractFromStateInput({
      detail: {
        traceparent: "00-cccccccccccccccccccccccccccccccc-dddddddddddddddd-01",
      },
      traceparent: PIN_A,
    });
    expect(extracted.source).toBe("state-input-flattened");
    expect(extracted.spanContext?.traceId).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("honors a _trace carrier over an embedded detail carrier on extract (R20)", () => {
    const extracted = extractFromStateInput({
      detail: {
        traceparent: "00-cccccccccccccccccccccccccccccccc-dddddddddddddddd-01",
      },
      [SFN_TRACE_FIELD]: { traceparent: PIN_A },
    });
    expect(extracted.source).toBe("state-input");
    expect(extracted.spanContext?.traceId).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });
});
