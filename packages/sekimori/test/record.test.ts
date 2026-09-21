import { context, SpanKind } from "@opentelemetry/api";
import { afterAll, describe, expect, it } from "vitest";
import { SekimoriError, withConsumerSpan, withRecord } from "../src/index.js";
import { asMalformed, setupOtel, spanNamed } from "./otel-setup.js";

const harness = setupOtel("w3c");
afterAll(() => harness.teardown());

describe("withRecord", () => {
  it("dispatches SQS / SNS / Kinesis / DynamoDB records and EventBridge events by shape", async () => {
    await withRecord({ eventSource: "aws:sqs", eventSourceARN: "arn:aws:sqs:r:1:q" }, () => 1);
    await withRecord({ EventSource: "aws:sns", Sns: { TopicArn: "arn:aws:sns:r:1:t" } }, () => 2);
    await withRecord(
      { eventSource: "aws:kinesis", eventSourceARN: "arn:aws:kinesis:r:1:stream/s" },
      () => 3,
    );
    await withRecord(
      {
        eventSource: "aws:dynamodb",
        eventSourceARN: "arn:aws:dynamodb:r:1:table/tbl/stream/x",
      },
      () => 4,
    );
    await withRecord({ source: "svc", "detail-type": "x", detail: {} }, () => 5);
    const spans = harness.spans();
    expect(spanNamed(spans, "process q")).toBeDefined();
    expect(spanNamed(spans, "process t")).toBeDefined();
    expect(spanNamed(spans, "process s")).toBeDefined();
    expect(spanNamed(spans, "process tbl")).toBeDefined();
    expect(spanNamed(spans, "process svc")).toBeDefined();
  });

  it("dispatches an API Gateway HTTP event (the handler argument itself)", async () => {
    await withRecord(
      {
        headers: {},
        requestContext: { http: { method: "POST", path: "/orders" } },
        routeKey: "POST /orders",
        rawPath: "/orders",
      },
      () => 6,
    );
    const server = spanNamed(harness.spans(), "POST /orders");
    expect(server).toBeDefined();
    expect(server.kind).toBe(SpanKind.SERVER);
  });

  it("dispatches SQS-shaped records that carry `eventSource: undefined` explicitly (R9-A)", async () => {
    // `"eventSource" in record` が true でも値が undefined なら、
    // messageId + eventSourceARN の fallback 判定に回さないと SQS record を取りこぼす。
    await withRecord(
      { eventSource: undefined, messageId: "m-1", eventSourceARN: "arn:aws:sqs:r:1:q2" },
      () => 7,
    );
    expect(spanNamed(harness.spans(), "process q2")).toBeDefined();
  });

  it("names unsupported shapes instead of guessing", async () => {
    await expect(withRecord(asMalformed({}), () => undefined)).rejects.toThrow(SekimoriError);
  });

  it("rejects null and primitive records instead of crashing on property access", async () => {
    await expect(withRecord(asMalformed(null), () => undefined)).rejects.toThrow(SekimoriError);
    await expect(withRecord(asMalformed("rec"), () => undefined)).rejects.toThrow(SekimoriError);
    await expect(withRecord(asMalformed(42), () => undefined)).rejects.toThrow(SekimoriError);
  });
});

describe("withConsumerSpan option validation (R10-A)", () => {
  it("rejects a non-string / empty span name and invalid kind/attributes", async () => {
    // 各 assertion が狙ったガードだけを打つよう parent には有効な Context を渡す。
    const parent = context.active();
    // 空文字は型上は string なのでコンパイルは通る — runtime guard で弾く。
    await expect(withConsumerSpan("", { parent }, () => undefined)).rejects.toThrow(SekimoriError);
    await expect(
      // @ts-expect-error runtime guard の検証
      withConsumerSpan(42, { parent }, () => undefined),
    ).rejects.toThrow(SekimoriError);
    await expect(
      // @ts-expect-error runtime guard の検証 — SpanKind enum 外の値
      withConsumerSpan("n", { parent, kind: 99 }, () => undefined),
    ).rejects.toThrow(SekimoriError);
    await expect(
      // @ts-expect-error runtime guard の検証 — attributes は object
      withConsumerSpan("n", { parent, attributes: [] }, () => undefined),
    ).rejects.toThrow(SekimoriError);
    // 有効値は通る
    await expect(
      withConsumerSpan("n", { parent, kind: SpanKind.CONSUMER }, () => "ok"),
    ).resolves.toBe("ok");
  });
});
