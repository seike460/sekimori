/** SNS consumer 側 — record からの context 抽出と CONSUMER span。 */
import { type Context, propagation, type Span } from "@opentelemetry/api";
import {
  asRecord,
  baseContext,
  consumerSpanPlan,
  objectGetter,
  type SnsEnvelopeAttributes,
  snsEnvelopeAttributesGetter,
} from "./carriers.js";
import { assertConsumeOptions, assertObject } from "./errors.js";
import { CarrierStash } from "./object-carrier.js";
import {
  ATTR_AWS_SNS_TOPIC_ARN,
  ATTR_MESSAGING_DESTINATION_NAME,
  ATTR_MESSAGING_MESSAGE_ID,
  ATTR_MESSAGING_OPERATION_TYPE,
  ATTR_MESSAGING_SYSTEM,
  ATTR_SEKIMORI_CONTEXT_SOURCE,
  MESSAGING_OPERATION_TYPE_PROCESS,
  MESSAGING_SYSTEM_AWS_SNS,
} from "./semconv.js";
import { withConsumerSpan } from "./span.js";
import type { CarrierSource, ConsumeOptions, Extracted } from "./types.js";

/** Lambda に届く SNS record（`aws-lambda` の `SNSEventRecord` と構造的に互換）の最小形。 */
export interface SnsRecordLike {
  Sns?:
    | {
        MessageId?: string | undefined;
        TopicArn?: string | undefined;
        Message?: string | undefined;
        MessageAttributes?: SnsEnvelopeAttributes | undefined;
      }
    | undefined;
}

function topicName(arn: string | undefined): string | undefined {
  if (typeof arn !== "string" || arn === "") return undefined;
  const name = arn.split(":").at(-1);
  return name === "" ? undefined : name;
}

/**
 * SNS → Lambda 直接 invoke の record から producer context を取り出す。
 * `Sns.MessageAttributes`（`{ Type, Value }` 形）を読む。見つからなければ `Message` が
 * JSON object のとき `detail`（EventBridge→SNS の経路）と body 直下の W3C key も見る。
 */
export function extractFromSnsRecord(
  record: SnsRecordLike,
  options: { context?: Context } = {},
): Extracted {
  assertObject(record, "extractFromSnsRecord");
  assertObject(options, "extractFromSnsRecord");
  const base = baseContext(options.context, "extractFromSnsRecord");
  // baggage だけを載せる carrier は即 return せず退避し、後続 carrier の実 trace context を
  // 優先する（CarrierStash 規約 — SQS と同じ）。
  const stash = new CarrierStash(base);
  const consider = (ctx: Context, source: CarrierSource): Extracted | undefined =>
    stash.consider(ctx, source);

  const sns = record.Sns;
  const attrs = sns?.MessageAttributes;
  if (
    attrs !== null &&
    typeof attrs === "object" &&
    !Array.isArray(attrs) &&
    Object.keys(attrs).length > 0
  ) {
    const hit = consider(
      propagation.extract(base, attrs, snsEnvelopeAttributesGetter),
      "sns-record",
    );
    if (hit) return hit;
  }

  const message = sns?.Message;
  if (typeof message === "string" && message !== "") {
    // parse 失敗（Message が JSON でない）だけを飲み込み、propagator 等の例外は
    // 上流へ伝播させる — extract の throw をここで飲むと `none` への silent degrade
    // になる（`injectKinesisRecord` と同じ方針）。
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      parsed = undefined;
    }
    const record = asRecord(parsed);
    if (record !== undefined) {
      // EventBridge→SNS→Lambda（直接 invoke）では Message が event 本体で、
      // carrier は detail にネストされる（EventBridge→SNS→SQS と同じ構造）。
      const detail = asRecord(record.detail);
      if (detail !== undefined) {
        const hit = consider(propagation.extract(base, detail, objectGetter), "body-detail");
        if (hit) return hit;
      }
      const hit = consider(propagation.extract(base, record, objectGetter), "body");
      if (hit) return hit;
    }
  }
  return stash.fallback() ?? { context: base, source: "none" };
}

/**
 * SNS → Lambda 直接 invoke の record 1 件を処理する CONSUMER span を開く。
 * 親は invocation span、producer へは link（DEC-002 と同じ既定）。
 */
export async function withSnsRecord<T>(
  record: SnsRecordLike,
  fn: (span: Span) => Promise<T> | T,
  options: ConsumeOptions = {},
): Promise<T> {
  assertObject(record, "withSnsRecord");
  assertObject(options, "withSnsRecord");
  assertConsumeOptions(options, "withSnsRecord");
  const base = baseContext(options.context, "withSnsRecord");
  const extracted = extractFromSnsRecord(record, { context: base });
  // baggage は常に union（producer mode でも base 側の entry を消さない）。
  const { parent, link } = consumerSpanPlan(base, extracted, options.parent);
  const topic = topicName(record.Sns?.TopicArn ?? undefined);
  return withConsumerSpan(
    options.name ?? `process ${topic ?? "sns"}`,
    {
      parent,
      link,
      attributes: {
        [ATTR_MESSAGING_SYSTEM]: MESSAGING_SYSTEM_AWS_SNS,
        [ATTR_MESSAGING_OPERATION_TYPE]: MESSAGING_OPERATION_TYPE_PROCESS,
        ...(typeof record.Sns?.TopicArn === "string" && record.Sns.TopicArn !== ""
          ? { [ATTR_AWS_SNS_TOPIC_ARN]: record.Sns.TopicArn }
          : {}),
        ...(topic !== undefined ? { [ATTR_MESSAGING_DESTINATION_NAME]: topic } : {}),
        ...(typeof record.Sns?.MessageId === "string" && record.Sns.MessageId !== ""
          ? { [ATTR_MESSAGING_MESSAGE_ID]: record.Sns.MessageId }
          : {}),
        [ATTR_SEKIMORI_CONTEXT_SOURCE]: extracted.source,
        ...options.attributes,
      },
    },
    fn,
  );
}
