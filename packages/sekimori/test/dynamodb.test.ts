import { context, type SpanContext, SpanKind, trace } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  DYNAMODB_TRACE_ATTRIBUTE,
  extractFromDynamoDbRecord,
  injectDynamoDbItem,
  SekimoriError,
  withDynamoDbRecord,
} from "../src/index.js";
import { type OtelHarness, setupOtel, spanNamed } from "./otel-setup.js";

const harness: OtelHarness = setupOtel("w3c");
const tracer = trace.getTracer("test");
afterAll(() => harness.teardown());
beforeEach(() => harness.reset());

const STREAM_ARN = "arn:aws:dynamodb:ap-northeast-1:123456789012:table/orders/stream/2026";

/** plain object の `_trace` を Streams の AttributeValue 形に写す。 */
function toStreamRecord(item: Record<string, unknown>) {
  const trace = item[DYNAMODB_TRACE_ATTRIBUTE] as Record<string, string> | undefined;
  return {
    eventSourceARN: STREAM_ARN,
    dynamodb: {
      NewImage: {
        pk: { S: "o-1" },
        ...(trace
          ? {
              [DYNAMODB_TRACE_ATTRIBUTE]: {
                M: Object.fromEntries(Object.entries(trace).map(([k, v]) => [k, { S: v }])),
              },
            }
          : {}),
      },
    },
  };
}

function put(item: Record<string, unknown> = {}) {
  let producer!: SpanContext;
  let injected!: ReturnType<typeof injectDynamoDbItem>;
  tracer.startActiveSpan("put", (span) => {
    producer = span.spanContext();
    injected = injectDynamoDbItem(item);
    span.end();
  });
  return { producer, injected };
}

describe("injectDynamoDbItem / extractFromDynamoDbRecord", () => {
  it("accepts interface-typed items (not only Record aliases)", () => {
    interface Order {
      pk: string;
    }
    const item: Order = { pk: "o-1" };
    let injected!: ReturnType<typeof injectDynamoDbItem<Order>>;
    tracer.startActiveSpan("put", (span) => {
      injected = injectDynamoDbItem(item);
      span.end();
    });
    expect(injected.pk).toBe("o-1");
    expect(injected[DYNAMODB_TRACE_ATTRIBUTE]).toBeDefined();
  });

  it("round-trips the W3C carrier through the _trace attribute", () => {
    const { producer, injected } = put({ pk: "o-1" });
    expect(injected.pk).toBe("o-1");
    const field = injected[DYNAMODB_TRACE_ATTRIBUTE] as Record<string, string>;
    expect(field.traceparent).toContain(producer.traceId);
    expect(field["x-amzn-trace-id"]).toBeUndefined();

    const extracted = extractFromDynamoDbRecord(toStreamRecord(injected));
    expect(extracted.source).toBe("stream-image");
    expect(extracted.spanContext?.spanId).toBe(producer.spanId);
  });

  it("merges carrier keys into an existing _trace object without mutating the caller's (R8-A)", () => {
    const existing = { custom: "x" };
    const { producer, injected } = put({ [DYNAMODB_TRACE_ATTRIBUTE]: existing });
    const field = injected[DYNAMODB_TRACE_ATTRIBUTE] as Record<string, unknown>;
    expect(field.custom).toBe("x");
    expect(field.traceparent).toContain(producer.traceId);
    // 呼び出し側の object は mutate しない
    expect(existing).toEqual({ custom: "x" });
  });

  it("does not overwrite an existing _trace", () => {
    const own = { traceparent: "00-11111111111111111111111111111111-2222222222222222-01" };
    const { injected } = put({ [DYNAMODB_TRACE_ATTRIBUTE]: own });
    expect(injected[DYNAMODB_TRACE_ATTRIBUTE]).toEqual(own);
  });

  it("returns none for a record without _trace", () => {
    expect(extractFromDynamoDbRecord({ dynamodb: { NewImage: { pk: { S: "x" } } } }).source).toBe(
      "none",
    );
    expect(extractFromDynamoDbRecord({}).source).toBe("none");
  });

  it("does not crash on null/undefined entries inside _trace.M (R4-A-3)", () => {
    const record = {
      dynamodb: {
        NewImage: { _trace: { M: { traceparent: null, other: undefined } as never } },
      },
    };
    expect(extractFromDynamoDbRecord(record).source).toBe("none");
  });
});

describe("withDynamoDbRecord", () => {
  it("opens `process <table>` CONSUMER span linked to the producer", async () => {
    const { producer, injected } = put({ pk: "o-1" });
    await tracer.startActiveSpan("invocation", async (inv) => {
      await withDynamoDbRecord(toStreamRecord(injected), () => undefined);
      inv.end();
    });
    const consumer = spanNamed(harness.spans(), "process orders");
    expect(consumer.kind).toBe(SpanKind.CONSUMER);
    expect(consumer.links.map((l) => l.context.spanId)).toEqual([producer.spanId]);
    expect(consumer.attributes).toMatchObject({
      "messaging.system": "aws_dynamodb",
      // eventSourceARN は stream ARN — table_arn 属性は `/stream/...` を削った table ARN。
      "aws.dynamodb.table_arn": "arn:aws:dynamodb:ap-northeast-1:123456789012:table/orders",
      "sekimori.context.source": "stream-image",
    });
  });
});

describe("Round-7 hardening", () => {
  it("treats `_trace: null` as absent and writes the carrier (inject/extract symmetry)", () => {
    const { producer, injected } = put({ pk: "o-1", _trace: null });
    expect(injected._trace).toMatchObject({
      traceparent: expect.stringContaining(producer.traceId),
    });
  });
});

describe("suppression (R11-A)", () => {
  it("writes no _trace attribute when the context is suppressed", () => {
    tracer.startActiveSpan("ddb-sup", (span) => {
      const injected = injectDynamoDbItem(
        { pk: "o-1" },
        { context: suppressTracing(context.active()) },
      );
      span.end();
      expect(injected._trace).toBeUndefined();
      expect(injected.pk).toBe("o-1");
    });
  });
});

describe("Round-12 hardening", () => {
  const PIN_A = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
  const XRAY_A = "Root=1-aaaaaaaa-aaaaaaaaaaaaaaaaaaaaaaaa;Parent=bbbbbbbbbbbbbbbb;Sampled=1";

  it("does not merge into a non-plain-object _trace (Map / class instance)", () => {
    // Map / Set / class instance は spread で `{}` や enumerable field だけの複製に
    // なり caller の値が silent に失われる — merge せず値をそのまま残す。
    const map = new Map([["k", "v"]]);
    const injected = injectDynamoDbItem({ pk: "o-1", _trace: map });
    expect(injected._trace).toBe(map);
  });

  it("keeps the caller's xray field on a _trace pin conflict", () => {
    tracer.startActiveSpan("ddb-pin-conflict", (span) => {
      const injected = injectDynamoDbItem({
        pk: "o-1",
        _trace: { traceparent: PIN_A, "x-amzn-trace-id": XRAY_A },
      });
      span.end();
      const field = injected._trace as Record<string, string>;
      expect(field.traceparent).toBe(PIN_A);
      expect(field["x-amzn-trace-id"]).toBe(XRAY_A);
    });
  });

  it("rejects a non-plain-object item instead of silently dropping it (R18)", () => {
    // Map / Date は spread で `{}` や enumerable field だけの複製になり、
    // `_trace` だけの item が Put される silent loss。
    expect(() => injectDynamoDbItem(new Map([["pk", "o-1"]]))).toThrow(SekimoriError);
    expect(() => injectDynamoDbItem(new Date())).toThrow(SekimoriError);
  });

  it("removes a stale _trace xray field that disagrees with the pin (R19)", () => {
    // pin（trace A）と別 trace（C）の xray field が残ると xray を優先する読み手が
    // pin に勝つ — pin の trace に照合して消す。
    const XRAY_C = "Root=1-cccccccc-cccccccccccccccccccccccc;Parent=dddddddddddddddd;Sampled=1";
    tracer.startActiveSpan("ddb-pin-stale-xray", (span) => {
      const injected = injectDynamoDbItem({
        pk: "o-1",
        _trace: { traceparent: PIN_A, "x-amzn-trace-id": XRAY_C },
      });
      span.end();
      const field = injected._trace as Record<string, string>;
      expect(field.traceparent).toBe(PIN_A);
      expect(field["x-amzn-trace-id"]).toBeUndefined();
    });
  });
});
