import {
  context,
  propagation,
  type SpanContext,
  SpanKind,
  TraceFlags,
  trace,
} from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractFromSqsRecord,
  injectEventBridgeEntry,
  injectSqsMessage,
  linksFromSqsEvent,
  queueNameFromArn,
  type SdkMessageAttributes,
  SekimoriError,
  withSqsRecord,
} from "../src/index.js";
import { asMalformed, type OtelHarness, setupOtel, spanNamed } from "./otel-setup.js";

const harness: OtelHarness = setupOtel("w3c");
const tracer = trace.getTracer("test");
afterAll(() => harness.teardown());
beforeEach(() => harness.reset());

const QUEUE_ARN = "arn:aws:sqs:ap-northeast-1:123456789012:orders-queue";

function send(
  input: Parameters<typeof injectSqsMessage>[0] = {},
  options?: Parameters<typeof injectSqsMessage>[1],
) {
  let producer!: SpanContext;
  let injected!: ReturnType<typeof injectSqsMessage>;
  tracer.startActiveSpan("send", (span) => {
    producer = span.spanContext();
    injected = injectSqsMessage(input, options);
    span.end();
  });
  return { producer, injected };
}

/** SDK 形（PascalCase）の属性を Lambda record 形（camelCase）に変換する。 */
function toRecordAttributes(attrs: SdkMessageAttributes | undefined) {
  return Object.fromEntries(
    Object.entries(attrs ?? {}).map(([k, v]) => [
      k,
      { dataType: v.DataType, stringValue: v.StringValue },
    ]),
  );
}

describe("extractFromSqsRecord precedence", () => {
  it("prefers message attributes", () => {
    const { producer, injected } = send();
    const extracted = extractFromSqsRecord({
      messageAttributes: toRecordAttributes(injected.MessageAttributes),
      attributes: {
        AWSTraceHeader:
          "Root=1-00000000-000000000000000000000001;Parent=0000000000000001;Sampled=1",
      },
    });
    expect(extracted.source).toBe("message-attributes");
    expect(extracted.spanContext?.spanId).toBe(producer.spanId);
  });

  it("falls back to AWSTraceHeader (the same source the ESM uses for links)", () => {
    const header = "Root=1-5759e988-bd862e3fe1be46a994272793;Parent=53995c3f42cd8ad8;Sampled=1";
    const extracted = extractFromSqsRecord({ attributes: { AWSTraceHeader: header } });
    expect(extracted.source).toBe("aws-trace-header");
    expect(extracted.spanContext).toEqual({
      traceId: "5759e988bd862e3fe1be46a994272793",
      spanId: "53995c3f42cd8ad8",
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    });
  });

  it("reads the SNS envelope when the subscription is not raw delivery", () => {
    const { producer, injected } = send();
    const body = JSON.stringify({
      Type: "Notification",
      Message: "{}",
      MessageAttributes: Object.fromEntries(
        Object.entries(injected.MessageAttributes ?? {}).map(([k, v]) => [
          k,
          { Type: v.DataType, Value: v.StringValue },
        ]),
      ),
    });
    const extracted = extractFromSqsRecord({ body });
    expect(extracted.source).toBe("sns-envelope");
    expect(extracted.spanContext?.spanId).toBe(producer.spanId);
  });

  it("reads the EventBridge detail carrier nested in the body (OQ-1)", () => {
    let publisher!: SpanContext;
    let eb!: ReturnType<typeof injectEventBridgeEntry>;
    tracer.startActiveSpan("put-events", (span) => {
      publisher = span.spanContext();
      eb = injectEventBridgeEntry({ Detail: JSON.stringify({ orderId: "o-9" }) });
      span.end();
    });
    // EventBridge → SQS target は event 全体が body になる
    const body = JSON.stringify({ source: "orders", detail: JSON.parse(eb.Detail!) });
    const extracted = extractFromSqsRecord({ body });
    expect(extracted.source).toBe("body-detail");
    expect(extracted.spanContext?.spanId).toBe(publisher.spanId);
  });

  it("reads a W3C payload envelope in the body as the last resort", () => {
    const { producer, injected } = send();
    const body = JSON.stringify({
      traceparent: injected.MessageAttributes?.traceparent?.StringValue,
      data: 1,
    });
    const extracted = extractFromSqsRecord({ body });
    expect(extracted.source).toBe("body");
    expect(extracted.spanContext?.spanId).toBe(producer.spanId);
  });

  it("returns none for a bare record", () => {
    expect(extractFromSqsRecord({ body: "hello" }).source).toBe("none");
  });

  it("detects a baggage-only carrier (no traceparent)", () => {
    const extracted = extractFromSqsRecord({
      messageAttributes: {
        baggage: { dataType: "String", stringValue: "customer=premium" },
      },
    });
    expect(extracted.source).toBe("message-attributes");
    expect(extracted.spanContext).toBeUndefined();
  });

  it("keeps scanning past a baggage-only carrier for a real trace context", () => {
    const { producer, injected } = send();
    const extracted = extractFromSqsRecord({
      messageAttributes: {
        // attributes には baggage だけ — span context は body 側が持つ
        baggage: { dataType: "String", stringValue: "customer=premium" },
      },
      body: JSON.stringify({
        traceparent: injected.MessageAttributes?.traceparent?.StringValue,
      }),
    });
    expect(extracted.source).toBe("body");
    expect(extracted.spanContext?.spanId).toBe(producer.spanId);
    // baggage-only carrier の entry も失われない
    expect(propagation.getBaggage(extracted.context)?.getEntry("customer")?.value).toBe("premium");
  });

  it("prefers a W3C body carrier over AWSTraceHeader (AWS transit nodes dead-link)", () => {
    const { producer, injected } = send();
    const extracted = extractFromSqsRecord({
      // AWS が転送時に書く header — Parent は EventBridge/SNS の内部 node を指し得る
      attributes: {
        AWSTraceHeader:
          "Root=1-00000000-0000000000000000000000ff;Parent=00000000deadbeef;Sampled=1",
      },
      body: JSON.stringify({
        traceparent: injected.MessageAttributes?.traceparent?.StringValue,
      }),
    });
    expect(extracted.source).toBe("body");
    expect(extracted.spanContext?.spanId).toBe(producer.spanId);
  });

  it("merges body baggage when AWSTraceHeader is the fallback (EventBridge→SQS)", () => {
    const extracted = extractFromSqsRecord({
      attributes: {
        AWSTraceHeader:
          "Root=1-5759e988-bd862e3fe1be46a994272793;Parent=53995c3f42cd8ad8;Sampled=1",
      },
      // EventBridge→SQS は body が event 全体 — detail に baggage だけ載るケース
      body: JSON.stringify({ source: "orders", detail: { baggage: "customer=premium" } }),
    });
    expect(extracted.source).toBe("aws-trace-header");
    expect(extracted.spanContext?.spanId).toBe("53995c3f42cd8ad8");
    expect(propagation.getBaggage(extracted.context)?.getEntry("customer")?.value).toBe("premium");
  });

  it("parses the carrier nested in an SNS envelope Message (EventBridge→SNS→SQS)", () => {
    const { producer, injected } = send();
    // 非 raw 配信: body.Message が実 payload（ここでは EventBridge event）
    const body = JSON.stringify({
      Type: "Notification",
      Message: JSON.stringify({
        source: "orders",
        detail: { traceparent: injected.MessageAttributes?.traceparent?.StringValue },
      }),
    });
    const extracted = extractFromSqsRecord({ body });
    expect(extracted.source).toBe("body-detail");
    expect(extracted.spanContext?.spanId).toBe(producer.spanId);

    // Message 直下に W3C key を持つ形も拾う
    const flat = JSON.stringify({
      Type: "Notification",
      Message: JSON.stringify({
        traceparent: injected.MessageAttributes?.traceparent?.StringValue,
      }),
    });
    const inner = extractFromSqsRecord({ body: flat });
    expect(inner.source).toBe("body");
    expect(inner.spanContext?.spanId).toBe(producer.spanId);
  });

  it("ignores a malformed (non-string) AWSTraceHeader instead of crashing", () => {
    const record = asMalformed({
      attributes: { AWSTraceHeader: 123 },
      body: "plain",
    });
    expect(extractFromSqsRecord(record).source).toBe("none");
  });

  it("never reports the active span as the extracted producer (no self-link)", () => {
    tracer.startActiveSpan("invocation", (inv) => {
      const extracted = extractFromSqsRecord({ body: "{}" });
      expect(extracted.spanContext).toBeUndefined();
      expect(extracted.spanContext?.spanId).not.toBe(inv.spanContext().spanId);
      inv.end();
    });
  });
});

describe("withSqsRecord", () => {
  it("opens `process <queue>` under the invocation span, linked to the producer, with messaging attributes", async () => {
    const { producer, injected } = send();
    const record = {
      messageId: "m-1",
      body: "{}",
      eventSourceARN: QUEUE_ARN,
      attributes: { ApproximateReceiveCount: "2" },
      messageAttributes: toRecordAttributes(injected.MessageAttributes),
    };
    await tracer.startActiveSpan("invocation", async (inv) => {
      await withSqsRecord(record, () => "done");
      inv.end();
    });
    const spans = harness.spans();
    const consumer = spanNamed(spans, "process orders-queue");
    expect(consumer.kind).toBe(SpanKind.CONSUMER);
    expect(consumer.parentSpanContext?.spanId).toBe(
      spanNamed(spans, "invocation").spanContext().spanId,
    );
    expect(consumer.links.map((l) => l.context.spanId)).toEqual([producer.spanId]);
    expect(consumer.attributes).toMatchObject({
      "messaging.system": "aws_sqs",
      "messaging.operation.type": "process",
      "messaging.destination.name": "orders-queue",
      "messaging.message.id": "m-1",
      "aws.sqs.approximate_receive_count": 2,
      "sekimori.context.source": "message-attributes",
    });
  });

  it("merges producer baggage into the consumer's active context even in link mode", async () => {
    const { injected } = send();
    const record = {
      eventSourceARN: QUEUE_ARN,
      messageAttributes: {
        ...toRecordAttributes(injected.MessageAttributes),
        baggage: { dataType: "String", stringValue: "customer=premium" },
      },
    };
    let seen: string | undefined;
    await tracer.startActiveSpan("invocation", async (inv) => {
      await withSqsRecord(record, async () => {
        seen = propagation.getBaggage(context.active())?.getEntry("customer")?.value;
      });
      inv.end();
    });
    expect(seen).toBe("premium");
    // link mode のまま — producer は link、親は invocation
    const consumer = spanNamed(harness.spans(), "process orders-queue");
    expect(consumer.links).toHaveLength(1);
    expect(consumer.parentSpanContext?.spanId).toBe(
      spanNamed(harness.spans(), "invocation").spanContext().spanId,
    );
  });

  it("can parent on the producer for FIFO-style single-record processing", async () => {
    const { producer, injected } = send();
    await withSqsRecord(
      {
        eventSourceARN: QUEUE_ARN,
        messageAttributes: toRecordAttributes(injected.MessageAttributes),
      },
      () => undefined,
      { parent: "producer" },
    );
    const consumer = spanNamed(harness.spans(), "process orders-queue");
    expect(consumer.parentSpanContext?.spanId).toBe(producer.spanId);
    expect(consumer.links).toEqual([]);
  });

  it("unions baggage — producer mode keeps base entries and carrier entries", async () => {
    const { injected } = send();
    const record = {
      eventSourceARN: QUEUE_ARN,
      messageAttributes: {
        ...toRecordAttributes(injected.MessageAttributes),
        baggage: { dataType: "String", stringValue: "customer=premium" },
      },
    };
    let seen: { base: string | undefined; carrier: string | undefined } = {
      base: undefined,
      carrier: undefined,
    };
    // base context に独自 baggage を持たせる — producer mode でも消えないはず
    const base = propagation.setBaggage(
      context.active(),
      propagation.createBaggage({ tenant: { value: "local" } }),
    );
    await context.with(base, async () => {
      await withSqsRecord(
        record,
        async () => {
          const bag = propagation.getBaggage(context.active());
          seen = {
            base: bag?.getEntry("tenant")?.value,
            carrier: bag?.getEntry("customer")?.value,
          };
        },
        { parent: "producer" },
      );
    });
    expect(seen).toEqual({ base: "local", carrier: "premium" });
  });

  it("rejects null / primitive records with a named error", async () => {
    // @ts-expect-error runtime guard の検証
    expect(() => extractFromSqsRecord(null)).toThrow(SekimoriError);
    // @ts-expect-error runtime guard の検証
    await expect(withSqsRecord("x", () => undefined)).rejects.toThrow(SekimoriError);
    // @ts-expect-error runtime guard の検証
    expect(() => linksFromSqsEvent(null)).toThrow(SekimoriError);
  });

  it("runs fn with a non-recording span when the context is suppressed (R13)", async () => {
    // inject 側の抑止と対称 — 抑制された scope で consumer span だけ生えない。
    // fn 自体は NonRecordingSpan で実行される（戻り値もそのまま返る）。
    const { injected } = send();
    const record = {
      eventSourceARN: QUEUE_ARN,
      messageAttributes: toRecordAttributes(injected.MessageAttributes),
    };
    let recorded = true;
    let result: string | undefined;
    await context.with(suppressTracing(context.active()), async () => {
      result = await withSqsRecord(record, (span) => {
        recorded = span.isRecording();
        return "ran";
      });
    });
    expect(result).toBe("ran");
    expect(recorded).toBe(false);
    expect(harness.spans().some((s) => s.name === "process orders-queue")).toBe(false);
  });

  it("activates the suppressed parent inside fn so nested inject stays suppressed (R15)", async () => {
    // ambient context のまま fn を走らせると、fn 内の nested inject / getActiveSpan が
    // 抑制されていない ambient を見てしまう — 抑制された parent を active にする。
    const { injected } = send();
    const record = {
      eventSourceARN: QUEUE_ARN,
      messageAttributes: toRecordAttributes(injected.MessageAttributes),
    };
    let activeRecording = true;
    let nestedAttrs: unknown;
    await context.with(suppressTracing(context.active()), async () => {
      await withSqsRecord(record, (span) => {
        activeRecording = span.isRecording();
        nestedAttrs = injectSqsMessage({}).MessageAttributes;
      });
    });
    expect(activeRecording).toBe(false);
    expect(nestedAttrs).toBeUndefined();
  });

  it("propagates the original error when span.recordException throws (R13)", async () => {
    // custom Span 実装が recordException で投げても元の error を隠さない。
    const { injected } = send();
    const record = {
      eventSourceARN: QUEUE_ARN,
      messageAttributes: toRecordAttributes(injected.MessageAttributes),
    };
    let proto: object | undefined;
    tracer.startActiveSpan("probe", (s) => {
      proto = Object.getPrototypeOf(s);
      s.end();
    });
    const spy = vi
      .spyOn(proto as { recordException: (e: unknown) => void }, "recordException")
      .mockImplementation(() => {
        throw new Error("recorder boom");
      });
    try {
      await expect(
        withSqsRecord(record, () => {
          throw new Error("original boom");
        }),
      ).rejects.toThrow("original boom");
    } finally {
      spy.mockRestore();
    }
  });

  it("collects links for a whole batch, skipping records without context", () => {
    const a = send();
    const b = send();
    const links = linksFromSqsEvent({
      Records: [
        { messageAttributes: toRecordAttributes(a.injected.MessageAttributes) },
        { body: "no context" },
        { messageAttributes: toRecordAttributes(b.injected.MessageAttributes) },
      ],
    });
    expect(links.map((l) => l.context.spanId)).toEqual([a.producer.spanId, b.producer.spanId]);
  });

  it("skips malformed records in a batch instead of failing the whole batch (R4-A-9)", () => {
    const a = send();
    const links = linksFromSqsEvent({
      Records: [
        null,
        { messageAttributes: toRecordAttributes(a.injected.MessageAttributes) },
        "oops",
      ] as never,
    });
    expect(links.map((l) => l.context.spanId)).toEqual([a.producer.spanId]);
  });

  it("does not crash on a primitive-string messageAttributes (R4-A-1)", () => {
    // `in` 演算子は primitive string に投げる — object ガードで TypeError ではなく none。
    const record = { messageAttributes: "oops" as never };
    expect(extractFromSqsRecord(record).source).toBe("none");
  });

  it("derives the queue name from the event source ARN", () => {
    expect(queueNameFromArn(QUEUE_ARN)).toBe("orders-queue");
    expect(queueNameFromArn(undefined)).toBeUndefined();
  });
});
