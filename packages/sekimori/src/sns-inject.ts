/** SNS producer 側 — Publish(Batch) への trace context 注入。 */
import { type Context, propagation, trace } from "@opentelemetry/api";
import {
  baseContext,
  carrierHasW3c,
  isTracingSuppressed,
  mergeSdkAttributesCarrier,
  removeW3cSpanSlots,
  type SdkMessageAttributes,
  sdkPinnedW3cTraceId,
  stripW3cCarrierKeys,
  w3cPinPlan,
} from "./carriers.js";
import { assertAttributeMap, assertInjectOptions, assertObject, SekimoriError } from "./errors.js";
import type { InjectOptions } from "./types.js";

/**
 * SNS の message attribute は SQS と同じ SDK 形だが、fan-out 先が SQS のときは
 * SQS の 10 attribute 上限が効く。SQS への到達を前提に同じ上限を課す。
 */
export const SNS_MAX_MESSAGE_ATTRIBUTES = 10;

/** `PublishCommandInput` / `PublishBatchRequestEntry` と構造的に互換な最小形。 */
export interface SnsPublishLike {
  Message?: string | undefined;
  Id?: string | undefined;
  MessageAttributes?: SdkMessageAttributes | undefined;
}

/** `PublishBatchCommandInput` と構造的に互換な最小形。 */
export interface SnsPublishBatchLike {
  PublishBatchRequestEntries?: SnsPublishLike[] | undefined;
}

function injectAttributes(
  input: SnsPublishLike,
  ctx: Context,
  options: InjectOptions,
): SdkMessageAttributes {
  const attributes: SdkMessageAttributes = { ...(input.MessageAttributes ?? {}) };
  const spanContext = trace.getSpanContext(ctx);
  // 呼び出し側が pin した `traceparent`/`tracestate` — 対の slot。片方でも既存なら
  // carrier 側の両方を書かず、pin された対を scrub もしない。pin が active span と
  // 別 trace を指す pinnedConflict では xray slot の書き込み・削除を抑止して pin 側に
  // 揃える（pin を読む側と xray を読む側で trace が分かれるため。SQS と同じ規約）。
  const { w3cPinned, pinnedConflict } = w3cPinPlan(attributes, spanContext, options.w3c !== false);
  if (!isTracingSuppressed(ctx)) {
    // 呼び出し側が置いた key は上書きしない（case-insensitive）。SQS / EventBridge と同じ方針。
    // `w3c: false` は W3C key を書かないという意味 — inject 自体は行い、SNS に
    // native channel が無いため `x-amzn-trace-id` を残さないと xray-only propagator で
    // context が全喪失する。
    const carrier: Record<string, string> = {};
    propagation.inject(ctx, carrier);
    if (options.w3c === false) stripW3cCarrierKeys(carrier);
    const carrierWroteW3c = carrierHasW3c(carrier);
    // pin 衝突時、stale な `x-amzn-trace-id` attribute が xray を優先する読み手に
    // pin より先に拾われる — pin の trace に照合して消す（pin と同じ trace や
    // 読めない値は残す。SQS の native pin scrub と同じ規約）。
    const pinTraceId = pinnedConflict ? sdkPinnedW3cTraceId(attributes) : undefined;
    // merge 規約（pin 保護・stale slot の除去・既存 key の保持）は SQS/SNS 共通 —
    // carriers.js の mergeSdkAttributesCarrier が正本。
    const { wroteXray: carrierWroteXray } = mergeSdkAttributesCarrier(attributes, carrier, {
      carrierWroteW3c,
      w3cSlotsPinned: w3cPinned,
      xrayConflict: pinnedConflict,
      pinTraceId,
    });
    // xray-only propagator で fresh な xray field を書いたのに stale な traceparent/
    // tracestate が残ると、ADOT 既定の composite（tracecontext が後勝ち）が stale な
    // W3C context を選ぶ split-brain になる（SQS と同じ方針。pin 済みの対は除く）。
    if (carrierWroteXray && !w3cPinned) removeW3cSpanSlots(attributes);
  }
  const count = Object.keys(attributes).length;
  if (count > SNS_MAX_MESSAGE_ATTRIBUTES) {
    throw new SekimoriError(
      `SNS message carries ${count} attributes; downstream SQS drops deliveries beyond ${SNS_MAX_MESSAGE_ATTRIBUTES}. ` +
        "Move application data into the message body, or pass { w3c: false }.",
    );
  }
  return attributes;
}

/**
 * `PublishCommand` の入力に W3C carrier（`traceparent` / `tracestate` / `baggage`）を載せる。
 * SNS に X-Ray ネイティブ channel は無い。attribute は raw delivery の SQS・Lambda 直接 invoke・
 * 非 raw では body envelope（`extractFromSqsRecord` が読む）へ届く。
 */
export function injectSnsMessage<T extends SnsPublishLike>(
  input: T,
  options: InjectOptions = {},
): T & SnsPublishLike {
  assertObject(input, "injectSnsMessage");
  assertObject(options, "injectSnsMessage");
  assertInjectOptions(options, "injectSnsMessage");
  // 非 object / array / Map の attribute map は spread でゴミ key か `{}` になるため弾く。
  assertAttributeMap(input.MessageAttributes, "injectSnsMessage", "MessageAttributes");
  const ctx = baseContext(options.context, "injectSnsMessage");
  const attributes = injectAttributes(input, ctx, options);
  // 書く attribute が無く入力側にも無ければ MessageAttributes を付けない（SQS と同じ方針）。
  if (Object.keys(attributes).length === 0 && input.MessageAttributes === undefined) {
    return { ...input };
  }
  return { ...input, MessageAttributes: attributes };
}

/** `PublishBatchRequestEntry` 1 件に W3C carrier を載せる。 */
export function injectSnsBatchEntry<T extends SnsPublishLike>(
  entry: T,
  options: InjectOptions = {},
): T & SnsPublishLike {
  return injectSnsMessage(entry, options);
}

/** `PublishBatchCommand` の入力の全 entry に W3C carrier を載せる。 */
export function injectSnsPublishBatch<T extends SnsPublishBatchLike>(
  input: T,
  options: InjectOptions = {},
): T & SnsPublishBatchLike {
  assertObject(input, "injectSnsPublishBatch");
  assertObject(options, "injectSnsPublishBatch");
  assertInjectOptions(options, "injectSnsPublishBatch");
  // entries 未指定の早期 return より先に context を検証する（sibling API と同じ規約）。
  baseContext(options.context, "injectSnsPublishBatch");
  if (
    input.PublishBatchRequestEntries !== undefined &&
    !Array.isArray(input.PublishBatchRequestEntries)
  ) {
    throw new SekimoriError("injectSnsPublishBatch: PublishBatchRequestEntries must be an array");
  }
  // entries 未指定なら key 自体を付けない（phantom `PublishBatchRequestEntries: undefined`）。
  if (input.PublishBatchRequestEntries === undefined) return { ...input };
  return {
    ...input,
    PublishBatchRequestEntries: input.PublishBatchRequestEntries.map((entry) =>
      injectSnsBatchEntry(entry, options),
    ),
  };
}
