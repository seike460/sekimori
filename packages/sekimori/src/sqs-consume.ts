/** SQS consumer 側 — record からの context 抽出と CONSUMER span。 */
import {
  type Context,
  isSpanContextValid,
  type Link,
  propagation,
  type Span,
  trace,
} from "@opentelemetry/api";
import {
  asRecord,
  baseContext,
  consumerSpanPlan,
  mergeBaggage,
  newSpanContext,
  objectGetter,
  type RecordMessageAttributes,
  recordAttributesGetter,
  type SnsEnvelopeAttributes,
  snsEnvelopeAttributesGetter,
} from "./carriers.js";
import { assertConsumeOptions, assertObject, SekimoriError } from "./errors.js";
import { CarrierStash } from "./object-carrier.js";
import {
  ATTR_AWS_SQS_APPROXIMATE_RECEIVE_COUNT,
  ATTR_MESSAGING_DESTINATION_NAME,
  ATTR_MESSAGING_MESSAGE_ID,
  ATTR_MESSAGING_OPERATION_TYPE,
  ATTR_MESSAGING_SYSTEM,
  ATTR_SEKIMORI_CONTEXT_SOURCE,
  MESSAGING_OPERATION_TYPE_PROCESS,
  MESSAGING_SYSTEM_AWS_SQS,
} from "./semconv.js";
import { withConsumerSpan } from "./span.js";
import type { CarrierSource, ConsumeOptions, Extracted } from "./types.js";
import { parseXrayTraceHeader } from "./xray-header.js";

/** Lambda の `SQSRecord` と構造的に互換な最小形。 */
export interface SqsRecordLike {
  messageId?: string | undefined;
  body?: string | undefined;
  eventSourceARN?: string | undefined;
  // interface（aws-lambda の SQSRecordAttributes）を受けるため index signature は置かない
  attributes?:
    | { AWSTraceHeader?: string | undefined; ApproximateReceiveCount?: string | undefined }
    | undefined;
  messageAttributes?: RecordMessageAttributes | undefined;
}

export interface SqsEventLike {
  Records: SqsRecordLike[];
}

function parseBody(body: string | undefined): Record<string, unknown> | undefined {
  if (!body) return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    return asRecord(parsed);
  } catch {
    return undefined;
  }
}

type Consider = (ctx: Context, source: CarrierSource) => Extracted | undefined;

/**
 * 非 raw 配信の SNS envelope — `MessageAttributes` の carrier と、内側 `Message`
 * （JSON 文字列。EventBridge→SNS→SQS では中身が event 本体）の detail / 直下を試す。
 */
function considerSnsEnvelope(
  body: Record<string, unknown>,
  base: Context,
  consider: Consider,
): Extracted | undefined {
  const attrs = asRecord(body.MessageAttributes);
  if (attrs !== undefined) {
    const hit = consider(
      propagation.extract(base, attrs as SnsEnvelopeAttributes, snsEnvelopeAttributesGetter),
      "sns-envelope",
    );
    if (hit) return hit;
  }
  const message = typeof body.Message === "string" ? parseBody(body.Message) : undefined;
  if (message === undefined) return undefined;
  const innerDetail = asRecord(message.detail);
  if (innerDetail !== undefined) {
    const hit = consider(propagation.extract(base, innerDetail, objectGetter), "body-detail");
    if (hit) return hit;
  }
  return consider(propagation.extract(base, message, objectGetter), "body");
}

/**
 * SQS record から producer context を取り出す。span context の優先順:
 * 1. `messageAttributes`（W3C）
 * 2. body の SNS envelope（非 raw 配信）の `MessageAttributes`
 * 3. envelope `Message`（内側 payload JSON。EventBridge→SNS→SQS では中身が event 本体）
 * 4. body が EventBridge event なら `detail` 内の W3C carrier（OQ-1）
 * 5. body 直下の W3C key（payload envelope）
 * 6. `attributes.AWSTraceHeader`（X-Ray 形式）— AWS が転送する経路では `Parent` が
 *    EventBridge/SNS の内部 node を指し、実 span が無い dead link になり得るため最後に見る
 *    （sekimori が inject した場合は producer span を指すのでどちらでも同じ）。
 *    W3C carrier から退避した baggage もここで merge する。
 */
export function extractFromSqsRecord(
  record: SqsRecordLike,
  options: { context?: Context } = {},
): Extracted {
  assertObject(record, "extractFromSqsRecord");
  assertObject(options, "extractFromSqsRecord");
  const base = baseContext(options.context, "extractFromSqsRecord");
  // baggage だけを載せる carrier は span context を持たないため即 return せず退避し、
  // 後続 carrier に実 trace context が無いかを最後まで確認する（CarrierStash 規約）。
  const stash = new CarrierStash(base);
  const consider = (ctx: Context, source: CarrierSource): Extracted | undefined =>
    stash.consider(ctx, source);

  if (
    record.messageAttributes !== null &&
    typeof record.messageAttributes === "object" &&
    !Array.isArray(record.messageAttributes) &&
    Object.keys(record.messageAttributes).length > 0
  ) {
    const hit = consider(
      propagation.extract(base, record.messageAttributes, recordAttributesGetter),
      "message-attributes",
    );
    if (hit) return hit;
  }

  const body = parseBody(record.body);
  if (body) {
    if (body.Type === "Notification") {
      const hit = considerSnsEnvelope(body, base, consider);
      if (hit) return hit;
    }
    // EventBridge → SQS target は event 全体が body になる。carrier は detail にネストされる。
    const detail = asRecord(body.detail);
    if (detail !== undefined) {
      const hit = consider(propagation.extract(base, detail, objectGetter), "body-detail");
      if (hit) return hit;
    }
    const hit = consider(propagation.extract(base, body, objectGetter), "body");
    if (hit) return hit;
  }

  // AWSTraceHeader は W3C carrier の fallback。baggage-only で退避した carrier の
  // entry も merge する（EB→SQS は常に AWSTraceHeader を書くので、detail の
  // baggage を捨てないため）。
  const xray = parseXrayTraceHeader(record.attributes?.AWSTraceHeader);
  if (xray) {
    const stashedCtx = stash.stashedContext();
    const ctx = trace.setSpanContext(stashedCtx ? mergeBaggage(base, stashedCtx) : base, xray);
    const spanContext = newSpanContext(base, ctx);
    if (spanContext !== undefined) {
      return { context: ctx, source: "aws-trace-header", spanContext };
    }
  }
  return stash.fallback() ?? { context: base, source: "none" };
}

/** `eventSourceARN` の末尾 = queue 名。 */
export function queueNameFromArn(arn: string | undefined): string | undefined {
  if (typeof arn !== "string" || arn === "") return undefined;
  const name = arn.split(":").at(-1);
  return name === "" ? undefined : name;
}

/**
 * record 1 件を処理する CONSUMER span（`process <queue>`）を開く。
 * DEC-002: 既定の親は invocation span、producer へは link。`parent: "producer"` で親子にできる。
 * `ReportBatchItemFailures` と両立する: fn が throw すれば span は ERROR で閉じ、例外はそのまま伝わる。
 */
export async function withSqsRecord<T>(
  record: SqsRecordLike,
  fn: (span: Span) => Promise<T> | T,
  options: ConsumeOptions = {},
): Promise<T> {
  assertObject(record, "withSqsRecord");
  assertObject(options, "withSqsRecord");
  assertConsumeOptions(options, "withSqsRecord");
  const base = baseContext(options.context, "withSqsRecord");
  const extracted = extractFromSqsRecord(record, { context: base });
  // baggage は常に union（producer mode でも base 側の entry を消さない）。
  const { parent, link } = consumerSpanPlan(base, extracted, options.parent);
  const queue = queueNameFromArn(record.eventSourceARN);
  // ApproximateReceiveCount は数字文字列のみ受理（""→0、"0x10"→16 のような誤 coercion を防ぐ）。
  // 桁数が非常に大きい値は Number が Infinity を返すため safe integer に限定する。
  const rawReceiveCount = record.attributes?.ApproximateReceiveCount;
  const receiveCount = (() => {
    if (typeof rawReceiveCount !== "string" || !/^\d+$/.test(rawReceiveCount)) {
      return undefined;
    }
    const n = Number(rawReceiveCount);
    return Number.isSafeInteger(n) ? n : undefined;
  })();
  return withConsumerSpan(
    options.name ?? `process ${queue ?? "sqs"}`,
    {
      parent,
      link,
      attributes: {
        [ATTR_MESSAGING_SYSTEM]: MESSAGING_SYSTEM_AWS_SQS,
        [ATTR_MESSAGING_OPERATION_TYPE]: MESSAGING_OPERATION_TYPE_PROCESS,
        ...(queue !== undefined ? { [ATTR_MESSAGING_DESTINATION_NAME]: queue } : {}),
        ...(typeof record.messageId === "string" && record.messageId !== ""
          ? { [ATTR_MESSAGING_MESSAGE_ID]: record.messageId }
          : {}),
        ...(receiveCount !== undefined
          ? { [ATTR_AWS_SQS_APPROXIMATE_RECEIVE_COUNT]: receiveCount }
          : {}),
        [ATTR_SEKIMORI_CONTEXT_SOURCE]: extracted.source,
        ...options.attributes,
      },
    },
    fn,
  );
}

/** batch 全体の producer への link 一覧（invocation span に足す用途）。context が無い record は飛ばす。 */
export function linksFromSqsEvent(
  event: SqsEventLike,
  options: { context?: Context } = {},
): Link[] {
  assertObject(event, "linksFromSqsEvent");
  assertObject(options, "linksFromSqsEvent");
  if (!Array.isArray(event.Records)) {
    throw new SekimoriError("linksFromSqsEvent: event.Records must be an array");
  }
  const base = baseContext(options.context, "linksFromSqsEvent");
  const links: Link[] = [];
  // 同じ producer span への重複 link は span の link quota（既定 128）を消費するだけなので除く。
  const seen = new Set<string>();
  for (const record of event.Records) {
    // malformed record（null / primitive / 配列）で batch 全体を落とさない — context が無い
    // record として飛ばす。ガード条件は assertObject と同じ形に揃える。
    if (record === null || typeof record !== "object" || Array.isArray(record)) continue;
    const { spanContext } = extractFromSqsRecord(record, { context: base });
    if (spanContext && isSpanContextValid(spanContext)) {
      const key = `${spanContext.traceId}:${spanContext.spanId}`;
      if (!seen.has(key)) {
        seen.add(key);
        links.push({ context: spanContext });
      }
    }
  }
  return links;
}
