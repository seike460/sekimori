import { context, propagation, type SpanContext, SpanKind, trace } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractFromKinesisRecord,
  injectKinesisPayload,
  injectKinesisRecord,
  KINESIS_MAX_RECORD_BYTES,
  SekimoriError,
  withKinesisRecord,
} from "../src/index.js";
import { asMalformed, type OtelHarness, setupOtel, spanNamed } from "./otel-setup.js";

const harness: OtelHarness = setupOtel("w3c");
const tracer = trace.getTracer("test");
afterAll(() => harness.teardown());
beforeEach(() => harness.reset());

const STREAM_ARN = "arn:aws:kinesis:ap-northeast-1:123456789012:stream/events";

function put(payload: Record<string, unknown> = {}) {
  let producer!: SpanContext;
  let injected!: ReturnType<typeof injectKinesisPayload>;
  tracer.startActiveSpan("put", (span) => {
    producer = span.spanContext();
    injected = injectKinesisPayload(payload);
    span.end();
  });
  return { producer, injected };
}

function toRecord(payload: Record<string, unknown>) {
  return {
    eventSourceARN: STREAM_ARN,
    kinesis: { data: Buffer.from(JSON.stringify(payload), "utf8").toString("base64") },
  };
}

describe("injectKinesisPayload / extractFromKinesisRecord", () => {
  it("round-trips the W3C carrier through the payload envelope", () => {
    const { producer, injected } = put({ kind: "order" });
    expect(injected.kind).toBe("order");
    expect(injected.traceparent).toBe(`00-${producer.traceId}-${producer.spanId}-01`);

    const extracted = extractFromKinesisRecord(toRecord(injected));
    expect(extracted.source).toBe("record-data");
    expect(extracted.spanContext?.spanId).toBe(producer.spanId);
  });

  it("does not overwrite caller keys", () => {
    const own = "00-11111111111111111111111111111111-2222222222222222-01";
    const { injected } = put({ traceparent: own });
    expect(injected.traceparent).toBe(own);
  });

  it("accepts interface-typed payloads (not only Record aliases)", () => {
    interface Order {
      id: string;
    }
    const payload: Order = { id: "o-1" };
    let injected!: ReturnType<typeof injectKinesisPayload<Order>>;
    tracer.startActiveSpan("put", (span) => {
      injected = injectKinesisPayload(payload);
      span.end();
    });
    expect(injected.id).toBe("o-1");
    expect(injected.traceparent).toMatch(/^00-/);
  });

  it("injectKinesisRecord rewrites Data bytes", () => {
    let sender!: SpanContext;
    let record!: ReturnType<typeof injectKinesisRecord>;
    tracer.startActiveSpan("put2", (span) => {
      sender = span.spanContext();
      record = injectKinesisRecord({
        Data: new TextEncoder().encode(JSON.stringify({ a: 1 })),
      });
      span.end();
    });
    const decoded = JSON.parse(Buffer.from(record.Data!).toString("utf8"));
    expect(decoded.a).toBe(1);
    expect(decoded.traceparent).toBe(`00-${sender.traceId}-${sender.spanId}-01`);
  });

  it("leaves Data bytes untouched when w3c:false or the payload is not JSON", () => {
    const json = new TextEncoder().encode(JSON.stringify({ a: 1 }));
    const noW3c = injectKinesisRecord({ Data: json }, { w3c: false });
    expect(noW3c.Data).toBe(json); // 再 serialize しない（byte 同一性）

    const binary = new TextEncoder().encode("not json");
    const passthrough = injectKinesisRecord({ Data: binary });
    expect(passthrough.Data).toBe(binary);

    const none = injectKinesisRecord({});
    expect(none.Data).toBeUndefined();
  });

  it("rewrites Data when a stale x-amzn-trace-id is replaced by traceparent (R9-A: key count unchanged)", () => {
    // key 数比較だと「stale xray を消して traceparent を足す」差し替え（2 → 2 keys）を
    // no-op と誤認する — 内容比較で Data が書き換わることを固定する。
    let record!: ReturnType<typeof injectKinesisRecord>;
    let sender!: SpanContext;
    tracer.startActiveSpan("put-stale", (span) => {
      sender = span.spanContext();
      record = injectKinesisRecord({
        Data: new TextEncoder().encode(
          JSON.stringify({
            data: 1,
            "x-amzn-trace-id":
              "Root=1-6999999999999999999999999999;Parent=0000000000000001;Sampled=1",
          }),
        ),
      });
      span.end();
    });
    const decoded = JSON.parse(Buffer.from(record.Data!).toString("utf8"));
    expect(decoded.data).toBe(1);
    expect(decoded["x-amzn-trace-id"]).toBeUndefined();
    expect(decoded.traceparent).toBe(`00-${sender.traceId}-${sender.spanId}-01`);
  });

  it("surfaces context validation errors instead of returning the original record", () => {
    const data = new TextEncoder().encode(JSON.stringify({ a: 1 }));
    expect(() =>
      injectKinesisRecord(
        { Data: data },
        // @ts-expect-error runtime guard の検証
        { context: {} },
      ),
    ).toThrow(SekimoriError);
  });

  it("surfaces propagator failures instead of returning the original record", () => {
    const spy = vi.spyOn(propagation, "inject").mockImplementation(() => {
      throw new Error("propagator boom");
    });
    try {
      expect(() =>
        injectKinesisRecord({ Data: new TextEncoder().encode(JSON.stringify({ a: 1 })) }),
      ).toThrow("propagator boom");
    } finally {
      spy.mockRestore();
    }
  });

  it("returns none for non-JSON data", () => {
    expect(
      extractFromKinesisRecord({
        kinesis: { data: Buffer.from("not json").toString("base64") },
      }).source,
    ).toBe("none");
  });
});

describe("withKinesisRecord", () => {
  it("names the span from the stream only — enhanced fan-out consumer path is cut", async () => {
    const { injected } = put();
    const fanOutArn =
      "arn:aws:kinesis:ap-northeast-1:123456789012:stream/events/consumer/myapp:1720000000.0";
    await tracer.startActiveSpan("invocation", async (inv) => {
      await withKinesisRecord(
        { ...toRecord(injected), eventSourceARN: fanOutArn },
        () => undefined,
      );
      inv.end();
    });
    const consumer = spanNamed(harness.spans(), "process events");
    expect(consumer.attributes["aws.kinesis.stream_name"]).toBe("events");
  });

  it("rejects null records with a named error", async () => {
    const { SekimoriError } = await import("../src/index.js");
    // @ts-expect-error runtime guard の検証
    await expect(withKinesisRecord(null, () => undefined)).rejects.toThrow(SekimoriError);
  });

  it("opens `process <stream>` CONSUMER span linked to the producer", async () => {
    const { producer, injected } = put({ kind: "order" });
    await tracer.startActiveSpan("invocation", async (inv) => {
      await withKinesisRecord(toRecord(injected), () => undefined);
      inv.end();
    });
    const consumer = spanNamed(harness.spans(), "process events");
    expect(consumer.kind).toBe(SpanKind.CONSUMER);
    expect(consumer.links.map((l) => l.context.spanId)).toEqual([producer.spanId]);
    expect(consumer.attributes).toMatchObject({
      "messaging.system": "aws_kinesis",
      "aws.kinesis.stream_name": "events",
      "sekimori.context.source": "record-data",
    });
  });
});

describe("suppression (R11-A)", () => {
  it("writes no carrier keys when the context is suppressed", () => {
    tracer.startActiveSpan("kin-sup", (span) => {
      const injected = injectKinesisPayload(
        { kind: "order" },
        { context: suppressTracing(context.active()) },
      );
      span.end();
      expect(injected).toEqual({ kind: "order" });
    });
  });
});

describe("Round-12 hardening", () => {
  const PIN_A = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
  const XRAY_A = "Root=1-aaaaaaaa-aaaaaaaaaaaaaaaaaaaaaaaa;Parent=bbbbbbbbbbbbbbbb;Sampled=1";

  it("keeps the caller's xray field on a payload pin conflict", () => {
    tracer.startActiveSpan("kin-pin-conflict", (span) => {
      const injected = injectKinesisPayload({
        orderId: "o-1",
        traceparent: PIN_A,
        "x-amzn-trace-id": XRAY_A,
      });
      span.end();
      expect(injected.traceparent).toBe(PIN_A);
      expect(injected["x-amzn-trace-id"]).toBe(XRAY_A);
    });
  });

  it("propagates extractor errors instead of degrading to 'none'", () => {
    // JSON.parse 失敗だけを飲み込む — propagator の throw をここで飲むと
    // extract が silent に `none` へ落ちる。
    const spy = vi.spyOn(propagation, "extract").mockImplementation(() => {
      throw new Error("propagator boom");
    });
    try {
      const data = Buffer.from(JSON.stringify({ a: 1 }), "utf8").toString("base64");
      expect(() => extractFromKinesisRecord({ kinesis: { data } })).toThrow("propagator boom");
    } finally {
      spy.mockRestore();
    }
  });

  it("reads a carrier nested in detail — EventBridge→Kinesis envelope (R16)", () => {
    // EB→Kinesis では event 全体が record data になる — carrier は detail に
    // ネストされる（SQS の body.detail / SNS の Message.detail と同じ構造）。
    const extracted = extractFromKinesisRecord(
      toRecord({
        version: "0",
        id: "evt-1",
        source: "app.orders",
        "detail-type": "OrderCreated",
        detail: { orderId: "o-1", traceparent: PIN_A },
      }),
    );
    expect(extracted.source).toBe("body-detail");
    expect(extracted.spanContext?.traceId).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("merges detail-only baggage with a root-level span context (R16)", () => {
    // detail が baggage だけを載せ、root に traceparent がある組み合わせ —
    // 先に読んだ detail の baggage を捨てない。
    const extracted = extractFromKinesisRecord(
      toRecord({ detail: { baggage: "tenant=t-1" }, traceparent: PIN_A }),
    );
    expect(extracted.source).toBe("record-data");
    expect(extracted.spanContext?.traceId).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(propagation.getBaggage(extracted.context)?.getEntry("tenant")?.value).toBe("t-1");
  });

  it("prefers the root carrier over an embedded detail carrier — inject slot wins (R20)", () => {
    // inject/pin 対象は root — detail-first だと inject した carrier や root pin が
    // embedded carrier に shadow される（SQS attrs / SNS attrs / SFN _trace と同じく
    // inject slot が最高優先）。
    const extracted = extractFromKinesisRecord(
      toRecord({
        detail: {
          traceparent: "00-cccccccccccccccccccccccccccccccc-dddddddddddddddd-01",
        },
        traceparent: PIN_A,
      }),
    );
    expect(extracted.source).toBe("record-data");
    expect(extracted.spanContext?.traceId).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("reads the freshly injected root carrier even when detail embeds another (R20)", () => {
    const { producer, injected } = put({ detail: { traceparent: PIN_A } });
    const extracted = extractFromKinesisRecord(toRecord(injected));
    expect(extracted.source).toBe("record-data");
    expect(extracted.spanContext?.traceId).toBe(producer.traceId);
  });

  it("rejects Data that would exceed the 1 MiB record limit after injection (R17)", () => {
    // carrier 追加で per-record 上限（1 MiB）を超えると AWS は不透明な
    // InvalidArgumentException で拒否する — EventBridge / SFN と同じく
    // 名指しの SekimoriError で事前に止める。
    const payload = { blob: "x".repeat(KINESIS_MAX_RECORD_BYTES) };
    const data = new TextEncoder().encode(JSON.stringify(payload));
    tracer.startActiveSpan("kin-limit", (span) => {
      expect(() => injectKinesisRecord({ Data: data })).toThrow(SekimoriError);
      span.end();
    });
  });

  it("rejects non-plain-object payloads instead of silently dropping them (R18)", () => {
    // Map / Set / Date / class instance は spread で `{}` や enumerable field
    // だけの複製になり、carrier だけの payload が送られる silent loss。
    expect(() => injectKinesisPayload(new Map([["orderId", "o-1"]]))).toThrow(SekimoriError);
    expect(() => injectKinesisPayload(new Date())).toThrow(SekimoriError);
  });

  it("removes a stale x-amzn-trace-id that disagrees with the payload pin (R19)", () => {
    // pin（trace A）と別 trace（C）の xray field が残ると xray を優先する読み手が
    // pin に勝つ — pin の trace に照合して消す。pin と同じ trace の値は残す。
    const XRAY_C = "Root=1-cccccccc-cccccccccccccccccccccccc;Parent=dddddddddddddddd;Sampled=1";
    tracer.startActiveSpan("kin-pin-stale-xray", (span) => {
      const injected = injectKinesisPayload({
        orderId: "o-1",
        traceparent: PIN_A,
        "x-amzn-trace-id": XRAY_C,
      });
      span.end();
      expect(injected.traceparent).toBe(PIN_A);
      expect(injected["x-amzn-trace-id"]).toBeUndefined();
    });
  });
});

describe("malformed data の防御境界（回帰: decode が catch の外に出ていた）", () => {
  it.each([null, 123, {}, true])("extract: kinesis.data=%j は throw せず source:none", (data) => {
    const record = asMalformed({ eventSourceARN: STREAM_ARN, kinesis: { data } });
    expect(extractFromKinesisRecord(record).source).toBe("none");
  });

  it("extract: base64 だが JSON でない data も source:none", () => {
    const record = {
      eventSourceARN: STREAM_ARN,
      kinesis: { data: Buffer.from("not json", "utf8").toString("base64") },
    };
    expect(extractFromKinesisRecord(record).source).toBe("none");
  });

  it.each([123, {}, true])("inject: Data=%j は throw せず変更なしで返す", (data) => {
    const input = { Data: data };
    expect(injectKinesisRecord(asMalformed(input))).toEqual(input);
  });
});
