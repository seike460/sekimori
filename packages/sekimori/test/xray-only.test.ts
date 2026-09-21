import { type SpanContext, trace } from "@opentelemetry/api";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  DYNAMODB_TRACE_ATTRIBUTE,
  extractFromDynamoDbRecord,
  extractFromEventBridgeEvent,
  extractFromKinesisRecord,
  extractFromSnsRecord,
  extractFromSqsRecord,
  extractFromStateInput,
  injectDynamoDbItem,
  injectEventBridgeEntry,
  injectKinesisPayload,
  injectSnsMessage,
  injectSqsMessage,
  injectStartExecution,
  SFN_TRACE_FIELD,
} from "../src/index.js";
import { type OtelHarness, setupOtel, spanNamed } from "./otel-setup.js";

// `OTEL_PROPAGATORS=xray` の環境（R7-A）— carrier は `x-amzn-trace-id` のみ。
// W3C traceparent が無くても、全境界で唯一の carrier が drop されず roundtrip できることを固定する。
const harness: OtelHarness = setupOtel("xray");
const tracer = trace.getTracer("test");
afterAll(() => harness.teardown());
beforeEach(() => harness.reset());

function inSpan<T>(fn: (producer: SpanContext) => T): { producer: SpanContext; out: T } {
  let producer!: SpanContext;
  let out!: T;
  tracer.startActiveSpan("publish", (span) => {
    producer = span.spanContext();
    out = fn(producer);
    span.end();
  });
  return { producer, out };
}

const XRAY_KEY = "x-amzn-trace-id";

describe("xray-only propagator (OTEL_PROPAGATORS=xray)", () => {
  it("EventBridge: keeps x-amzn-trace-id in Detail and extracts the producer (R7-A)", () => {
    const { producer, out: injected } = inSpan(() =>
      injectEventBridgeEntry({
        Source: "orders",
        DetailType: "created",
        Detail: JSON.stringify({ orderId: "o-1" }),
      }),
    );
    const detail = JSON.parse(injected.Detail ?? "{}") as Record<string, unknown>;
    // W3C が無いため唯一の carrier — TraceHeader は配信 event に残らないので detail 側に残る
    expect(detail[XRAY_KEY]).toContain(`Parent=${producer.spanId}`);
    expect(detail[XRAY_KEY]).toContain(producer.traceId.slice(0, 8));
    expect(detail.traceparent).toBeUndefined();
    expect(injected.TraceHeader).toBeDefined();

    const extracted = extractFromEventBridgeEvent({ detail });
    expect(extracted.source).toBe("detail");
    expect(extracted.spanContext).toMatchObject({
      traceId: producer.traceId,
      spanId: producer.spanId,
    });
  });

  it("SQS: keeps x-amzn-trace-id in MessageAttributes and extracts the producer", () => {
    const { producer, out: injected } = inSpan(() => injectSqsMessage({}));
    const header = injected.MessageAttributes?.[XRAY_KEY]?.StringValue;
    expect(header).toContain(producer.spanId);
    // xray propagator が担うため AWSTraceHeader system attribute は書かない（auto 既定）
    expect(injected.MessageSystemAttributes?.AWSTraceHeader).toBeUndefined();

    const extracted = extractFromSqsRecord({
      body: "{}",
      messageAttributes: {
        [XRAY_KEY]: { dataType: "String", stringValue: header },
      },
    });
    expect(extracted.spanContext).toMatchObject({
      traceId: producer.traceId,
      spanId: producer.spanId,
    });
  });

  it("SNS: keeps x-amzn-trace-id in MessageAttributes and extracts the producer", () => {
    const { producer, out: injected } = inSpan(() =>
      injectSnsMessage({ Message: "{}", TopicArn: "arn:aws:sns:us-east-1:1:t" }),
    );
    const header = injected.MessageAttributes?.[XRAY_KEY]?.StringValue;
    expect(header).toContain(producer.spanId);

    const extracted = extractFromSnsRecord({
      Sns: {
        Message: "{}",
        MessageAttributes: {
          [XRAY_KEY]: { Type: "String", Value: header },
        },
      },
    });
    expect(extracted.spanContext).toMatchObject({
      traceId: producer.traceId,
      spanId: producer.spanId,
    });
  });

  it("SQS: w3c:false still writes AWSTraceHeader — and keeps the xray carrier field (R11-A)", () => {
    // `w3c: false` は W3C key（traceparent/tracestate/baggage）の抑制であって inject
    // 自体の抑止ではない — xray propagator の `x-amzn-trace-id` は attribute に残る
    // （SNS 等 native channel の無い境界で context が全喪失するのを防ぐための挙動）。
    const { producer, out: injected } = inSpan(() => injectSqsMessage({}, { w3c: false }));
    const attrs = injected.MessageAttributes ?? {};
    expect(attrs["x-amzn-trace-id"]?.StringValue).toContain(`Parent=${producer.spanId}`);
    expect(attrs.traceparent).toBeUndefined();
    expect(attrs.tracestate).toBeUndefined();
    expect(attrs.baggage).toBeUndefined();
    expect(injected.MessageSystemAttributes?.AWSTraceHeader?.StringValue).toContain(
      `Parent=${producer.spanId}`,
    );
  });

  it("SQS: overwrites a stale x-amzn-trace-id attribute (propagation slot, R8-A)", () => {
    const { producer, out: injected } = inSpan(() =>
      injectSqsMessage({
        MessageAttributes: {
          [XRAY_KEY]: {
            DataType: "String",
            StringValue:
              "Root=1-aaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb;Parent=cccccccccccccccc;Sampled=1",
          },
        },
      }),
    );
    expect(injected.MessageAttributes?.[XRAY_KEY]?.StringValue).toContain(
      `Parent=${producer.spanId}`,
    );
  });

  it("SFN: keeps x-amzn-trace-id in _trace and extracts the producer", () => {
    const { producer, out: injected } = inSpan(() =>
      injectStartExecution({ input: JSON.stringify({ orderId: "o-1" }) }),
    );
    const record = JSON.parse(injected.input ?? "{}") as Record<string, unknown>;
    const field = record[SFN_TRACE_FIELD] as Record<string, string>;
    expect(field[XRAY_KEY]).toContain(`Parent=${producer.spanId}`);
    expect(field.traceparent).toBeUndefined();
    expect(injected.traceHeader).toBeDefined();

    const extracted = extractFromStateInput(record);
    expect(extracted.source).toBe("state-input");
    expect(extracted.spanContext).toMatchObject({
      traceId: producer.traceId,
      spanId: producer.spanId,
    });
  });

  it("DynamoDB: keeps x-amzn-trace-id in _trace and extracts the producer", () => {
    const { producer, out: item } = inSpan(() => injectDynamoDbItem({ pk: "o-1" }));
    const field = item[DYNAMODB_TRACE_ATTRIBUTE] as Record<string, string>;
    expect(field[XRAY_KEY]).toContain(`Parent=${producer.spanId}`);
    expect(field.traceparent).toBeUndefined();

    const extracted = extractFromDynamoDbRecord({
      dynamodb: {
        NewImage: {
          [DYNAMODB_TRACE_ATTRIBUTE]: {
            M: Object.fromEntries(Object.entries(field).map(([k, v]) => [k, { S: v }])),
          },
        },
      },
    });
    expect(extracted.source).toBe("stream-image");
    expect(extracted.spanContext).toMatchObject({
      traceId: producer.traceId,
      spanId: producer.spanId,
    });
  });

  it("Kinesis: keeps x-amzn-trace-id in the payload envelope and extracts the producer", () => {
    const { producer, out: payload } = inSpan(() => injectKinesisPayload({ orderId: "o-1" }));
    expect(payload[XRAY_KEY]).toContain(`Parent=${producer.spanId}`);
    expect(payload.traceparent).toBeUndefined();

    const extracted = extractFromKinesisRecord({
      kinesis: { data: Buffer.from(JSON.stringify(payload), "utf8").toString("base64") },
    });
    expect(extracted.source).toBe("record-data");
    expect(extracted.spanContext).toMatchObject({
      traceId: producer.traceId,
      spanId: producer.spanId,
    });
  });

  it("withSqsRecord links the consumer span to the xray-only producer", async () => {
    const { withSqsRecord } = await import("../src/index.js");
    const { producer, out: injected } = inSpan(() => injectSqsMessage({}));
    const header = injected.MessageAttributes?.[XRAY_KEY]?.StringValue;
    await withSqsRecord(
      {
        body: "{}",
        messageAttributes: {
          [XRAY_KEY]: { dataType: "String", stringValue: header },
        },
      },
      () => undefined,
    );
    const consumer = spanNamed(harness.spans(), "process sqs");
    expect(consumer.links.map((l) => l.context.spanId)).toEqual([producer.spanId]);
    expect(consumer.attributes["sekimori.context.source"]).toBe("message-attributes");
  });
});

describe("xray-only propagator — w3c:false keeps the xray carrier field (R11-A)", () => {
  // `w3c: false` は W3C key の抑制であって inject 自体の抑止ではない。native channel を
  // 持たない境界（SNS/DynamoDB/Kinesis）や embedded carrier（EventBridge detail / SFN
  // input）で `x-amzn-trace-id` が残り、xray-only propagator の context が全喪失しない。
  it("SNS keeps x-amzn-trace-id in MessageAttributes", () => {
    const { producer, out: injected } = inSpan(() => injectSnsMessage({}, { w3c: false }));
    expect(injected.MessageAttributes?.[XRAY_KEY]?.StringValue).toContain(
      `Parent=${producer.spanId}`,
    );
    expect(injected.MessageAttributes?.traceparent).toBeUndefined();
  });

  it("DynamoDB keeps x-amzn-trace-id in _trace", () => {
    const { producer, out: injected } = inSpan(() =>
      injectDynamoDbItem({ pk: "o-1" }, { w3c: false }),
    );
    const carrier = injected._trace as Record<string, string>;
    expect(carrier[XRAY_KEY]).toContain(`Parent=${producer.spanId}`);
    expect(carrier.traceparent).toBeUndefined();
  });

  it("Kinesis keeps x-amzn-trace-id in the payload", () => {
    const { producer, out: injected } = inSpan(() =>
      injectKinesisPayload({ kind: "order" }, { w3c: false }),
    );
    expect(injected[XRAY_KEY]).toContain(`Parent=${producer.spanId}`);
    expect(injected.traceparent).toBeUndefined();
  });

  it("EventBridge keeps x-amzn-trace-id in Detail", () => {
    const { producer, out: injected } = inSpan(() =>
      injectEventBridgeEntry({ Detail: JSON.stringify({ a: 1 }) }, { w3c: false }),
    );
    const detail = JSON.parse(injected.Detail ?? "{}") as Record<string, unknown>;
    expect(detail[XRAY_KEY]).toContain(`Parent=${producer.spanId}`);
    expect(detail.traceparent).toBeUndefined();
  });

  it("StepFunctions keeps x-amzn-trace-id in _trace", () => {
    const { producer, out: injected } = inSpan(() =>
      injectStartExecution({ input: JSON.stringify({ a: 1 }) }, { w3c: false }),
    );
    const record = JSON.parse(injected.input ?? "{}") as Record<string, unknown>;
    const carrier = record[SFN_TRACE_FIELD] as Record<string, string>;
    expect(carrier[XRAY_KEY]).toContain(`Parent=${producer.spanId}`);
    expect(carrier.traceparent).toBeUndefined();
  });
});

describe("xray-only propagator — pinned traceparent conflict (R12)", () => {
  // pin = caller の明示指定が carrier の fresh context に勝つ。pin が active span と
  // 別 trace を指すのに fresh な `x-amzn-trace-id` / native header を書くと、
  // pin を読む側と xray を読む側で trace が分かれる — xray slot の fresh 書き込みを
  // 抑止し、pin に合致し得る caller の既存値は残す。
  const PIN_A = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
  const XRAY_A = "Root=1-aaaaaaaa-aaaaaaaaaaaaaaaaaaaaaaaa;Parent=bbbbbbbbbbbbbbbb;Sampled=1";

  it("SQS: keeps the caller's xray attribute and writes no fresh one", () => {
    const callerXray = { DataType: "String", StringValue: XRAY_A };
    const { out: injected } = inSpan(() =>
      injectSqsMessage({
        MessageAttributes: {
          traceparent: { DataType: "String", StringValue: PIN_A },
          [XRAY_KEY]: callerXray,
        },
      }),
    );
    const attrs = injected.MessageAttributes ?? {};
    expect(attrs.traceparent?.StringValue).toBe(PIN_A);
    expect(attrs[XRAY_KEY]).toBe(callerXray);
    expect(injected.MessageSystemAttributes?.AWSTraceHeader).toBeUndefined();
  });

  it("SNS: keeps the caller's xray attribute and writes no fresh one", () => {
    const callerXray = { DataType: "String", StringValue: XRAY_A };
    const { out: injected } = inSpan(() =>
      injectSnsMessage({
        Message: "{}",
        MessageAttributes: {
          traceparent: { DataType: "String", StringValue: PIN_A },
          [XRAY_KEY]: callerXray,
        },
      }),
    );
    const attrs = injected.MessageAttributes ?? {};
    expect(attrs.traceparent?.StringValue).toBe(PIN_A);
    expect(attrs[XRAY_KEY]).toBe(callerXray);
  });

  it("EventBridge: keeps the pinned detail pair and suppresses TraceHeader", () => {
    const { out: injected } = inSpan(() =>
      injectEventBridgeEntry({
        Detail: JSON.stringify({ traceparent: PIN_A, [XRAY_KEY]: XRAY_A }),
      }),
    );
    const detail = JSON.parse(injected.Detail ?? "{}") as Record<string, unknown>;
    expect(detail.traceparent).toBe(PIN_A);
    expect(detail[XRAY_KEY]).toBe(XRAY_A);
    expect(injected.TraceHeader).toBeUndefined();
  });

  it("StepFunctions: keeps the pinned _trace pair and suppresses traceHeader", () => {
    const { out: injected } = inSpan(() =>
      injectStartExecution({
        input: JSON.stringify({
          [SFN_TRACE_FIELD]: { traceparent: PIN_A, [XRAY_KEY]: XRAY_A },
        }),
      }),
    );
    const record = JSON.parse(injected.input ?? "{}") as Record<string, unknown>;
    const field = record[SFN_TRACE_FIELD] as Record<string, string>;
    expect(field.traceparent).toBe(PIN_A);
    expect(field[XRAY_KEY]).toBe(XRAY_A);
    expect(injected.traceHeader).toBeUndefined();
  });

  it("DynamoDB: keeps the pinned _trace pair without a fresh xray field", () => {
    const { out: item } = inSpan(() =>
      injectDynamoDbItem({ _trace: { traceparent: PIN_A, [XRAY_KEY]: XRAY_A } }),
    );
    const field = item[DYNAMODB_TRACE_ATTRIBUTE] as Record<string, string>;
    expect(field.traceparent).toBe(PIN_A);
    expect(field[XRAY_KEY]).toBe(XRAY_A);
  });

  it("Kinesis: keeps the pinned payload pair without a fresh xray field", () => {
    const { out: payload } = inSpan(() =>
      injectKinesisPayload({ traceparent: PIN_A, [XRAY_KEY]: XRAY_A }),
    );
    expect(payload.traceparent).toBe(PIN_A);
    expect(payload[XRAY_KEY]).toBe(XRAY_A);
  });
});
