import { type SpanContext, SpanKind, trace } from "@opentelemetry/api";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  extractFromSnsRecord,
  injectSnsMessage,
  injectSnsPublishBatch,
  type SdkMessageAttributes,
  SekimoriError,
  withSnsRecord,
} from "../src/index.js";
import { type OtelHarness, setupOtel, spanNamed } from "./otel-setup.js";

const harness: OtelHarness = setupOtel("w3c");
const tracer = trace.getTracer("test");
afterAll(() => harness.teardown());
beforeEach(() => harness.reset());

const TOPIC_ARN = "arn:aws:sns:ap-northeast-1:123456789012:events";

function publish(input: Parameters<typeof injectSnsMessage>[0] = {}) {
  let producer!: SpanContext;
  let injected!: ReturnType<typeof injectSnsMessage>;
  tracer.startActiveSpan("publish", (span) => {
    producer = span.spanContext();
    injected = injectSnsMessage(input);
    span.end();
  });
  return { producer, injected };
}

/** SDK 形（PascalCase）を SNS record / envelope 形（`{ Type, Value }`）に変換する。 */
function toSnsAttributes(attrs: SdkMessageAttributes | undefined) {
  return Object.fromEntries(
    Object.entries(attrs ?? {}).map(([k, v]) => [k, { Type: v.DataType, Value: v.StringValue }]),
  );
}

describe("extractFromSnsRecord / withSnsRecord", () => {
  it("reads MessageAttributes from a direct SNS -> Lambda record", () => {
    const { producer, injected } = publish();
    const extracted = extractFromSnsRecord({
      Sns: {
        MessageId: "m",
        TopicArn: TOPIC_ARN,
        MessageAttributes: toSnsAttributes(injected.MessageAttributes),
      },
    });
    expect(extracted.source).toBe("sns-record");
    expect(extracted.spanContext?.spanId).toBe(producer.spanId);
  });

  it("falls back to W3C keys inside a JSON Message", () => {
    const { producer, injected } = publish();
    const extracted = extractFromSnsRecord({
      Sns: {
        Message: JSON.stringify({
          traceparent: injected.MessageAttributes?.traceparent?.StringValue,
        }),
      },
    });
    expect(extracted.source).toBe("body");
    expect(extracted.spanContext?.spanId).toBe(producer.spanId);
  });

  it("returns none for a bare record", () => {
    expect(extractFromSnsRecord({ Sns: { Message: "plain" } }).source).toBe("none");
  });

  it("does not crash on a primitive-string MessageAttributes (R4-A-1)", () => {
    // `in` 演算子は primitive string に投げる — object ガードで TypeError ではなく none。
    const record = { Sns: { MessageAttributes: "oops" as never } };
    expect(extractFromSnsRecord(record).source).toBe("none");
  });

  it("reads the carrier from detail inside a JSON Message (EventBridge→SNS→Lambda, R4-A-2)", () => {
    const { producer } = publish();
    const extracted = extractFromSnsRecord({
      Sns: {
        Message: JSON.stringify({
          "detail-type": "probe",
          source: "test",
          detail: {
            traceparent: `00-${producer.traceId}-${producer.spanId}-01`,
          },
        }),
      },
    });
    expect(extracted.source).toBe("body-detail");
    expect(extracted.spanContext?.spanId).toBe(producer.spanId);
  });

  it("rejects a non-array PublishBatchRequestEntries", () => {
    expect(() => injectSnsPublishBatch({ PublishBatchRequestEntries: "x" as never })).toThrow(
      SekimoriError,
    );
  });

  it("opens `process <topic>` CONSUMER span linked to the producer", async () => {
    const { producer, injected } = publish();
    await tracer.startActiveSpan("invocation", async (inv) => {
      await withSnsRecord(
        {
          Sns: {
            MessageId: "m-1",
            TopicArn: TOPIC_ARN,
            MessageAttributes: toSnsAttributes(injected.MessageAttributes),
          },
        },
        () => undefined,
      );
      inv.end();
    });
    const consumer = spanNamed(harness.spans(), "process events");
    expect(consumer.kind).toBe(SpanKind.CONSUMER);
    expect(consumer.links.map((l) => l.context.spanId)).toEqual([producer.spanId]);
    expect(consumer.attributes).toMatchObject({
      "messaging.system": "aws_sns",
      "aws.sns.topic_arn": TOPIC_ARN,
      "messaging.destination.name": "events",
      "messaging.message.id": "m-1",
      "sekimori.context.source": "sns-record",
    });
  });
});

describe("Round-5 hardening", () => {
  it("does not write an empty MessageAttributes object (R5-A-5)", () => {
    const injected = injectSnsMessage({}, { w3c: false });
    expect("MessageAttributes" in injected).toBe(false);
  });

  it("does not set topic/message attributes from non-string fields (R5-A-4)", async () => {
    await withSnsRecord(
      { Sns: { TopicArn: 5 as never, MessageId: {} as never, Message: "{}" } },
      () => undefined,
    );
    const consumer = spanNamed(harness.spans(), "process sns");
    expect(consumer.attributes["aws.sns.topic_arn"]).toBeUndefined();
    expect(consumer.attributes["messaging.message.id"]).toBeUndefined();
  });

  it("rejects a null options argument with a named error (R5-A-6)", () => {
    // @ts-expect-error runtime guard の検証
    expect(() => injectSnsMessage({}, null)).toThrow(SekimoriError);
    // @ts-expect-error runtime guard の検証
    expect(() => extractFromSnsRecord({}, null)).toThrow(SekimoriError);
  });
});
