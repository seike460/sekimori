/** `withRecord` — event source を判別して各 service の consume handler へ dispatch する union 入口。 */
import type { Span } from "@opentelemetry/api";
import { type HttpEventLike, withHttpEvent } from "./apigw.js";
import { type DynamoDbRecordLike, withDynamoDbRecord } from "./dynamodb.js";
import { assertConsumeOptions, assertObject, SekimoriError } from "./errors.js";
import { type EventBridgeEventLike, withEventBridgeEvent } from "./eventbridge.js";
import { type KinesisRecordLike, withKinesisRecord } from "./kinesis.js";
import { type SnsRecordLike, withSnsRecord } from "./sns.js";
import { type SqsRecordLike, withSqsRecord } from "./sqs.js";
import type { ConsumeOptions } from "./types.js";

/** `withRecord` が dispatch できる record の union。 */
export type AnyRecord =
  // eventSource は JS 側から `undefined` 明示で来ることがあるため `| undefined` を許す
  // （`exactOptionalPropertyTypes` 下でも実行時の形を素直に書けるように）。
  | (SqsRecordLike & { eventSource?: string | undefined })
  | (SnsRecordLike & { EventSource?: string | undefined })
  | (KinesisRecordLike & { eventSource?: string | undefined })
  | (DynamoDbRecordLike & { eventSource?: string | undefined })
  | EventBridgeEventLike
  | HttpEventLike;

function isSqsRecord(record: AnyRecord): record is SqsRecordLike & { eventSource?: string } {
  // `eventSource: undefined` が明示された record は「eventSource 無し」として扱う —
  // `"eventSource" in record` が true でも値が無ければ messageId/eventSourceARN の
  // fallback 判定に回さないと SQS record を取りこぼす。
  if ("eventSource" in record && record.eventSource !== undefined) {
    return record.eventSource === "aws:sqs";
  }
  // eventSource を欠く SQS 形 record（fixture / 非 ESM 由来）も拾う —
  // `messageId` + `eventSourceARN` は Kinesis / DynamoDB / SNS には無い組み合わせ。
  return "messageId" in record && "eventSourceARN" in record;
}

function isSnsRecord(record: AnyRecord): record is SnsRecordLike {
  return "Sns" in record || ("EventSource" in record && record.EventSource === "aws:sns");
}

function isKinesisRecord(record: AnyRecord): record is KinesisRecordLike {
  return "kinesis" in record || ("eventSource" in record && record.eventSource === "aws:kinesis");
}

function isDynamoDbRecord(record: AnyRecord): record is DynamoDbRecordLike {
  return "dynamodb" in record || ("eventSource" in record && record.eventSource === "aws:dynamodb");
}

function isEventBridgeEvent(record: AnyRecord): record is EventBridgeEventLike {
  return "detail-type" in record || ("detail" in record && "source" in record);
}

/**
 * API Gateway の Lambda proxy event。v2（routeKey / rawPath）と v1（httpMethod / resource）の
 * 両方を `requestContext` + 識別子の組み合わせで見る。
 */
function isHttpEvent(record: AnyRecord): record is HttpEventLike {
  if (!("requestContext" in record)) return false;
  return (
    "routeKey" in record ||
    "rawPath" in record ||
    "httpMethod" in record ||
    "headers" in record ||
    "multiValueHeaders" in record
  );
}

/**
 * record の形で境界を判別して `withSqsRecord` / `withSnsRecord` / `withKinesisRecord` /
 * `withDynamoDbRecord` / `withEventBridgeEvent` / `withHttpEvent` に振り分ける。
 * SFN task の event（state input）は形が不定のため対象外 — `withStepFunctionsTask` を直接呼ぶ。
 * なお HTTP event は handler 引数（Records ではなく event そのもの）に来る点だけ注意。
 */
export async function withRecord<T>(
  record: AnyRecord,
  fn: (span: Span) => Promise<T> | T,
  options: ConsumeOptions = {},
): Promise<T> {
  assertObject(record, "withRecord");
  assertObject(options, "withRecord");
  assertConsumeOptions(options, "withRecord");
  if (isSqsRecord(record)) return withSqsRecord(record, fn, options);
  if (isSnsRecord(record)) return withSnsRecord(record, fn, options);
  if (isKinesisRecord(record)) return withKinesisRecord(record, fn, options);
  if (isDynamoDbRecord(record)) return withDynamoDbRecord(record, fn, options);
  if (isEventBridgeEvent(record)) return withEventBridgeEvent(record, fn, options);
  if (isHttpEvent(record)) return withHttpEvent(record, fn, options);
  throw new SekimoriError(
    "withRecord: unsupported record shape. Expected an SQS / SNS / Kinesis / DynamoDB Streams record, an EventBridge event, or an API Gateway HTTP event.",
  );
}
