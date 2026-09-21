import { context as otelContext, propagation, type SpanContext, trace } from "@opentelemetry/api";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  injectDynamoDbItem,
  injectEventBridgeEntry,
  injectKinesisPayload,
  injectSnsMessage,
  injectSqsMessage,
  injectStartExecution,
  withDynamoDbRecord,
  withEventBridgeEvent,
  withHttpEvent,
  withKinesisRecord,
  withSnsRecord,
  withSqsRecord,
  withStepFunctionsTask,
} from "../../src/index.js";
import { type OtelHarness, type PropagatorMode, setupOtel, spanNamed } from "../otel-setup.js";

/**
 * Boundary Contract Tests（BC-01〜BC-11）。
 * 同じ suite を「素の OTel SDK（W3C のみ）」と「ADOT layer 相当（W3C + X-Ray propagator）」で走らせ、
 * propagator 構成が変わっても producer → consumer の link が保たれることを保証する
 * （minamo の InMemory / DynamoDB Contract Test と同じ発想）。
 */
export function registerBoundaryContract(mode: PropagatorMode): void {
  describe(`boundary contract [${mode}]`, () => {
    let harness: OtelHarness;
    const tracer = () => trace.getTracer("contract");

    beforeAll(() => {
      harness = setupOtel(mode);
    });
    afterAll(() => harness.teardown());
    beforeEach(() => harness.reset());

    function produce<T>(fn: () => T): { producer: SpanContext; value: T } {
      let producer!: SpanContext;
      let value!: T;
      tracer().startActiveSpan("produce", (span) => {
        producer = span.spanContext();
        value = fn();
        span.end();
      });
      return { producer, value };
    }

    it("BC-01 EventBridge: detail carrier links consumer to producer", async () => {
      const { producer, value } = produce(() =>
        injectEventBridgeEntry({ Source: "bc", DetailType: "t", Detail: JSON.stringify({ n: 1 }) }),
      );
      await tracer().startActiveSpan("invocation", async (inv) => {
        await withEventBridgeEvent(
          { source: "bc", detail: JSON.parse(value.Detail!) },
          () => undefined,
        );
        inv.end();
      });
      const consumer = spanNamed(harness.spans(), "process bc");
      expect(consumer.links.map((l) => l.context.spanId)).toEqual([producer.spanId]);
      expect(consumer.attributes["sekimori.context.source"]).toBe("detail");
    });

    it("BC-02 EventBridge: TraceHeader is always written in X-Ray format", () => {
      const { producer, value } = produce(() => injectEventBridgeEntry({ Detail: "{}" }));
      expect(value.TraceHeader).toBe(
        `Root=1-${producer.traceId.slice(0, 8)}-${producer.traceId.slice(8)};Parent=${producer.spanId};Sampled=1`,
      );
    });

    it("BC-03 SQS: message attributes carry W3C context and never the X-Ray field", async () => {
      const { producer, value } = produce(() => injectSqsMessage({}));
      const keys = Object.keys(value.MessageAttributes ?? {}).map((k) => k.toLowerCase());
      expect(keys).toContain("traceparent");
      expect(keys).not.toContain("x-amzn-trace-id");
      const record = {
        eventSourceARN: "arn:aws:sqs:ap-northeast-1:1:q",
        messageAttributes: Object.fromEntries(
          Object.entries(value.MessageAttributes ?? {}).map(([k, v]) => [
            k,
            { dataType: v.DataType, stringValue: v.StringValue },
          ]),
        ),
      };
      await tracer().startActiveSpan("invocation", async (inv) => {
        await withSqsRecord(record, () => undefined);
        inv.end();
      });
      expect(spanNamed(harness.spans(), "process q").links.map((l) => l.context.spanId)).toEqual([
        producer.spanId,
      ]);
    });

    it("BC-04 SQS: AWSTraceHeader system attribute is written only when the X-Ray propagator is absent (auto)", () => {
      const { value } = produce(() => injectSqsMessage({}));
      if (mode === "w3c") expect(value.MessageSystemAttributes?.AWSTraceHeader).toBeDefined();
      else expect(value.MessageSystemAttributes).toBeUndefined();
    });

    it("BC-05 SQS: AWSTraceHeader alone (ESM path) still links the consumer", async () => {
      const { producer, value } = produce(() => injectSqsMessage({}, { xrayHeader: true }));
      const record = {
        eventSourceARN: "arn:aws:sqs:ap-northeast-1:1:q2",
        attributes: { AWSTraceHeader: value.MessageSystemAttributes!.AWSTraceHeader!.StringValue! },
      };
      await withSqsRecord(record, () => undefined);
      const consumer = spanNamed(harness.spans(), "process q2");
      expect(consumer.links.map((l) => l.context.spanId)).toEqual([producer.spanId]);
      expect(consumer.attributes["sekimori.context.source"]).toBe("aws-trace-header");
    });

    it("BC-06 SNS -> SQS (non-raw): the envelope in the body still links the consumer", async () => {
      const { producer, value } = produce(() => injectSnsMessage({ Message: "hello" }));
      // SNS 非 raw 配信: attributes は SQS body の envelope に入る
      const body = JSON.stringify({
        Type: "Notification",
        Message: "hello",
        MessageAttributes: Object.fromEntries(
          Object.entries(value.MessageAttributes ?? {}).map(([k, v]) => [
            k,
            { Type: v.DataType, Value: v.StringValue },
          ]),
        ),
      });
      await tracer().startActiveSpan("invocation", async (inv) => {
        await withSqsRecord({ eventSourceARN: "arn:aws:sqs:r:1:qq", body }, () => undefined);
        inv.end();
      });
      const consumer = spanNamed(harness.spans(), "process qq");
      expect(consumer.links.map((l) => l.context.spanId)).toEqual([producer.spanId]);
      expect(consumer.attributes["sekimori.context.source"]).toBe("sns-envelope");
    });

    it("BC-07 SNS -> Lambda direct: Sns.MessageAttributes links the consumer", async () => {
      const { producer, value } = produce(() => injectSnsMessage({ Message: "hi" }));
      await withSnsRecord(
        {
          Sns: {
            TopicArn: "arn:aws:sns:r:1:t",
            MessageAttributes: Object.fromEntries(
              Object.entries(value.MessageAttributes ?? {}).map(([k, v]) => [
                k,
                { Type: v.DataType, Value: v.StringValue },
              ]),
            ),
          },
        },
        () => undefined,
      );
      const consumer = spanNamed(harness.spans(), "process t");
      expect(consumer.links.map((l) => l.context.spanId)).toEqual([producer.spanId]);
      expect(consumer.attributes["sekimori.context.source"]).toBe("sns-record");
    });

    it("BC-08 Step Functions: _trace in the state input links the task span", async () => {
      const { producer, value } = produce(() =>
        injectStartExecution({ input: JSON.stringify({ orderId: 1 }) }),
      );
      const event = JSON.parse(value.input!);
      await tracer().startActiveSpan("invocation", async (inv) => {
        await withStepFunctionsTask(event, () => undefined);
        inv.end();
      });
      const task = spanNamed(harness.spans(), "process stepfunctions-task");
      expect(task.links.map((l) => l.context.spanId)).toEqual([producer.spanId]);
      expect(task.attributes["sekimori.context.source"]).toBe("state-input");
    });

    it("BC-09 API Gateway: the client traceparent parents the SERVER span", async () => {
      const { producer, value } = produce(() => {
        const carrier: Record<string, string> = {};
        propagation.inject(otelContext.active(), carrier);
        return carrier;
      });
      await tracer().startActiveSpan("invocation", async (inv) => {
        await withHttpEvent(
          {
            headers: value,
            routeKey: "POST /orders",
            requestContext: { http: { method: "POST", path: "/orders" } },
          },
          () => undefined,
        );
        inv.end();
      });
      const server = spanNamed(harness.spans(), "POST /orders");
      // HTTP は同期呼び出し — 既定で client（producer）が親になる（DEC-007）。
      expect(server.parentSpanContext?.spanId).toBe(producer.spanId);
      expect(server.attributes["sekimori.context.source"]).toBe("headers");
    });

    it("BC-10 DynamoDB Streams: _trace in NewImage links the record span", async () => {
      const { producer, value } = produce(() => injectDynamoDbItem({ pk: "p" }));
      const traceField = value._trace as Record<string, string>;
      const image = {
        pk: { S: "p" },
        _trace: {
          M: Object.fromEntries(Object.entries(traceField).map(([k, v]) => [k, { S: v }])),
        },
      };
      await tracer().startActiveSpan("invocation", async (inv) => {
        await withDynamoDbRecord(
          {
            dynamodb: { NewImage: image },
            eventSourceARN: "arn:aws:dynamodb:r:1:table/orders/stream/2026",
          },
          () => undefined,
        );
        inv.end();
      });
      const consumer = spanNamed(harness.spans(), "process orders");
      expect(consumer.links.map((l) => l.context.spanId)).toEqual([producer.spanId]);
      expect(consumer.attributes["sekimori.context.source"]).toBe("stream-image");
    });

    it("BC-11 Kinesis: W3C keys in the JSON payload link the record span", async () => {
      const { producer, value } = produce(() => injectKinesisPayload({ orderId: 1 }));
      const data = Buffer.from(JSON.stringify(value)).toString("base64");
      await tracer().startActiveSpan("invocation", async (inv) => {
        await withKinesisRecord(
          { kinesis: { data }, eventSourceARN: "arn:aws:kinesis:r:1:stream/orders" },
          () => undefined,
        );
        inv.end();
      });
      const consumer = spanNamed(harness.spans(), "process orders");
      expect(consumer.links.map((l) => l.context.spanId)).toEqual([producer.spanId]);
      expect(consumer.attributes["sekimori.context.source"]).toBe("record-data");
    });
  });
}
