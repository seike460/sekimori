import type { SQSEvent, SQSRecord } from "aws-lambda";
import { describe, expect, it } from "vitest";
import { handler } from "./consumer.js";

function sqsRecord(body: string, messageId = "m-1"): SQSRecord {
  return {
    messageId,
    receiptHandle: "receipt",
    body,
    attributes: {
      ApproximateReceiveCount: "1",
      SentTimestamp: "1700000000000",
      SenderId: "sender",
      ApproximateFirstReceiveTimestamp: "1700000000000",
    },
    messageAttributes: {},
    md5OfBody: "md5",
    eventSource: "aws:sqs",
    eventSourceARN: "arn:aws:sqs:ap-northeast-1:123456789012:probe-queue",
    awsRegion: "ap-northeast-1",
  };
}

const event = (...records: SQSRecord[]): SQSEvent => ({ Records: records });

describe("consumer handler", () => {
  it("processes a well-formed probe envelope without failures", async () => {
    const res = await handler(event(sqsRecord(JSON.stringify({ detail: { probeId: "probe-1" } }))));
    expect(res.batchItemFailures).toEqual([]);
  });

  it("reports malformed JSON bodies as partial batch failures", async () => {
    const res = await handler(event(sqsRecord("not-json", "bad-1")));
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: "bad-1" }]);
  });

  it("fails only the malformed record in a mixed batch", async () => {
    const res = await handler(
      event(
        sqsRecord(JSON.stringify({ detail: { probeId: "probe-1" } }), "ok-1"),
        sqsRecord("{unterminated", "bad-1"),
        sqsRecord(JSON.stringify({ detail: { probeId: "probe-2" } }), "ok-2"),
      ),
    );
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: "bad-1" }]);
  });

  it("accepts envelopes without a probeId (probe_id attribute is optional)", async () => {
    const res = await handler(event(sqsRecord(JSON.stringify({ detail: {} }))));
    expect(res.batchItemFailures).toEqual([]);
  });

  it("skips a probeId outside the safe character set without failing the record", async () => {
    // span attribute には安全な文字集合だけを載せる — 異形の probeId は
    // record 失敗ではなく attribute 未設定として扱う（assert 側は probeId で
    // query するため、この event は相関対象外になる）。
    const res = await handler(
      event(sqsRecord(JSON.stringify({ detail: { probeId: 'bad" id |;' } }))),
    );
    expect(res.batchItemFailures).toEqual([]);
  });

  it("skips non-string probeId and non-object envelopes", async () => {
    const res = await handler(
      event(
        sqsRecord(JSON.stringify({ detail: { probeId: 42 } }), "n-1"),
        sqsRecord(JSON.stringify("just-a-string"), "n-2"),
        sqsRecord(JSON.stringify(null), "n-3"),
      ),
    );
    expect(res.batchItemFailures).toEqual([]);
  });

  it("returns an empty failure list for an empty batch", async () => {
    const res = await handler(event());
    expect(res.batchItemFailures).toEqual([]);
  });
});
