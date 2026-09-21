/** EventBridge `detail` 向け carrier — PutEvents entry への inject / 抽出と CONSUMER span。 */
import {
  type Context,
  isSpanContextValid,
  propagation,
  type Span,
  trace,
} from "@opentelemetry/api";
import {
  asRecord,
  baseContext,
  consumerSpanPlan,
  hasNewBaggage,
  isTracingSuppressed,
  newSpanContext,
  objectGetter,
  preserveBaseBaggage,
  removeCarrierKey,
  removeW3cSpanSlots,
  XRAY_FIELD,
} from "./carriers.js";
import {
  assertConsumeOptions,
  assertInjectOptions,
  assertObject,
  SekimoriError,
} from "./errors.js";
import {
  EMPTY_CARRIER_PLAN,
  injectCarrier,
  mergeObjectCarrier,
  type ObjectCarrierPlan,
  parseJsonObject,
  planObjectCarrier,
} from "./object-carrier.js";
import {
  ATTR_AWS_EVENTBRIDGE_DETAIL_TYPE,
  ATTR_AWS_EVENTBRIDGE_EVENT_ID,
  ATTR_AWS_EVENTBRIDGE_SOURCE,
  ATTR_MESSAGING_OPERATION_TYPE,
  ATTR_MESSAGING_SYSTEM,
  ATTR_SEKIMORI_CONTEXT_SOURCE,
  MESSAGING_OPERATION_TYPE_PROCESS,
  MESSAGING_SYSTEM_AWS_EVENTBRIDGE,
} from "./semconv.js";
import { withConsumerSpan } from "./span.js";
import type { ConsumeOptions, Extracted, InjectOptions } from "./types.js";
import { formatXrayTraceHeader } from "./xray-header.js";

/** EventBridge PutEvents の 1 entry の上限（256 KiB）。carrier 追加で超過する前に止める。 */
export const EVENTBRIDGE_MAX_ENTRY_BYTES = 256 * 1024;

/** `PutEventsRequestEntry` と構造的に互換な最小形。 */
export interface PutEventsEntryLike {
  Detail?: string | undefined;
  TraceHeader?: string | undefined;
}

/** Lambda に届く EventBridge event の最小形（`aws-lambda` の `EventBridgeEvent` と構造的に互換）。 */
export interface EventBridgeEventLike {
  id?: string | undefined;
  source?: string | undefined;
  "detail-type"?: string | undefined;
  detail?: unknown;
}

// Detail 未指定の entry には W3C carrier を書かない — 空 object を新設すると
// event の形が変わり、`detail` の有無で filter する target や利用者を壊す。

/**
 * PutEvents の entry に trace context を載せる。
 * - `TraceHeader`（X-Ray 形式）: EventBridge が Lambda target へ内部伝達する。配信 event には入らない。
 * - `Detail` に W3C `traceparent` / `tracestate` / `baggage`: archive replay・API destination・
 *   W3C-only な consumer でも producer span を特定できる（DEC-001）。
 * Detail が無い、または JSON object でない場合は W3C carrier を書かず、Detail を変更しない
 * （TraceHeader だけが乗る）。
 */
export function injectEventBridgeEntry<T extends PutEventsEntryLike>(
  entry: T,
  options: InjectOptions = {},
): T & PutEventsEntryLike {
  assertObject(entry, "injectEventBridgeEntry");
  assertObject(options, "injectEventBridgeEntry");
  assertInjectOptions(options, "injectEventBridgeEntry");
  const ctx = baseContext(options.context, "injectEventBridgeEntry");
  const spanContext = trace.getSpanContext(ctx);
  const out: T & PutEventsEntryLike = { ...entry };

  // suppress された context では native header も書かない（suppression は計装そのものを
  // 止める合図 — SQS の AWSTraceHeader と同じ方針）。
  const suppressed = isTracingSuppressed(ctx);
  // detail を先に parse する — pin 判定が TraceHeader の書き込み可否を左右するため。
  const detail = suppressed ? undefined : parseJsonObject(out.Detail);
  // `w3c: false` は W3C key を書かないという意味 — inject 自体は行い、
  // `x-amzn-trace-id` 等の non-W3C field は残す（xray-only propagator で
  // context が全喪失するのを防ぐ）。detail が無ければ inject も pin 判定もしない。
  const carrier = detail === undefined ? undefined : injectCarrier(ctx, options);
  // pin / 衝突の判定は object carrier 共通規約（Kinesis payload と同じ —
  // `planObjectCarrier` / `mergeObjectCarrier` を参照）。
  const plan: ObjectCarrierPlan =
    detail !== undefined && carrier !== undefined
      ? planObjectCarrier(detail, carrier, ctx, options.w3c)
      : EMPTY_CARRIER_PLAN;
  // `TraceHeader` は配信 event には含まれず、AWS 側の bus→target hop の X-Ray
  // view にしか効かない — caller が別 trace を pin しても consumer 側の
  // split-brain にはならないため、carrier 抑止の対象にはしない（pin は保持する）。
  const wroteTraceHeader =
    options.xrayHeader !== false &&
    !suppressed &&
    !plan.pinnedConflict &&
    spanContext !== undefined &&
    isSpanContextValid(spanContext) &&
    !out.TraceHeader;
  if (wroteTraceHeader) {
    // formatXrayTraceHeader の出力は固定長（73 文字）で EventBridge の 500 文字上限を常に下回る。
    out.TraceHeader = formatXrayTraceHeader(spanContext);
  }

  if (detail !== undefined && carrier !== undefined) {
    let { wrote, wroteXray } = mergeObjectCarrier(detail, carrier, plan);
    // fresh な xray context（TraceHeader または xray-only の carrier field）を書いたのに
    // stale な traceparent/tracestate が detail に残ると、ADOT 既定の composite
    // （`baggage,xray,tracecontext` — tracecontext が後勝ち）が stale な W3C context を
    // 選ぶ split-brain になる。
    if ((wroteTraceHeader || wroteXray) && !plan.carrierWroteW3c && !plan.w3cPinned) {
      wrote = removeW3cSpanSlots(detail) || wrote;
    }
    // fresh な TraceHeader を書いたのに入力由来の `x-amzn-trace-id` が detail に残ると、
    // extract が detail を先に読む経路で stale context が勝つ split-brain になる
    // （carrier が今回 fresh 値を書いた場合はその値が生きているので消さない）。
    if (wroteTraceHeader && !wroteXray) {
      wrote = removeCarrierKey(detail, XRAY_FIELD) || wrote;
    }
    // carrier が空（何も書けなかった）なら Detail を再 serialize しない — byte が変わると
    // 内容比較する target / 利用者に phantom write と見える。
    if (wrote) out.Detail = JSON.stringify(detail);
  }
  // PutEvents entry の上限は 256 KiB — carrier 追加で限界を超えた entry は AWS が拒否する。
  // stringify 不能な入力（circular な extra field 等）はここでは測らない
  // （その場合は AWS SDK の serialize 段階で同様に失敗する）。
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(out);
  } catch {
    serialized = undefined;
  }
  if (serialized !== undefined) {
    const size = Buffer.byteLength(serialized, "utf8");
    if (size > EVENTBRIDGE_MAX_ENTRY_BYTES) {
      throw new SekimoriError(
        `injectEventBridgeEntry: entry is ${size} bytes, over the EventBridge PutEvents limit of ${EVENTBRIDGE_MAX_ENTRY_BYTES} bytes — AWS would reject the call. Reduce the Detail payload.`,
      );
    }
  }
  return out;
}

/** EventBridge event の `detail` に載った W3C carrier から producer context を取り出す。 */
export function extractFromEventBridgeEvent(
  event: EventBridgeEventLike,
  options: { context?: Context } = {},
): Extracted {
  assertObject(event, "extractFromEventBridgeEvent");
  assertObject(options, "extractFromEventBridgeEvent");
  const base = baseContext(options.context, "extractFromEventBridgeEvent");
  const detail = asRecord(event.detail);
  if (detail !== undefined) {
    const ctx = propagation.extract(base, detail, objectGetter);
    const spanContext = newSpanContext(base, ctx);
    // carrier が baggage だけを載せる（traceparent なし）場合も source を記録する。
    // そのとき spanContext は付けない — base の span（invocation span 等）を producer と
    // 誤認して self-link するのを防ぐ。
    if (spanContext !== undefined || hasNewBaggage(base, ctx)) {
      return {
        context: preserveBaseBaggage(ctx, base),
        source: "detail",
        ...(spanContext !== undefined ? { spanContext } : {}),
      };
    }
  }
  return { context: base, source: "none" };
}

/**
 * EventBridge event を処理する CONSUMER span を開く。
 * 既定の親は invocation span（ADOT layer）、`detail.traceparent` の producer へ link（DEC-002）。
 */
export async function withEventBridgeEvent<T>(
  event: EventBridgeEventLike,
  fn: (span: Span) => Promise<T> | T,
  options: ConsumeOptions = {},
): Promise<T> {
  assertObject(event, "withEventBridgeEvent");
  assertObject(options, "withEventBridgeEvent");
  assertConsumeOptions(options, "withEventBridgeEvent");
  const base = baseContext(options.context, "withEventBridgeEvent");
  const extracted = extractFromEventBridgeEvent(event, { context: base });
  // baggage は常に union（producer mode でも base 側の entry を消さない）。
  const { parent, link } = consumerSpanPlan(base, extracted, options.parent);
  const sourceName =
    typeof event.source === "string" && event.source !== "" ? event.source : "eventbridge";
  const name = options.name ?? `process ${sourceName}`;
  return withConsumerSpan(
    name,
    {
      parent,
      link,
      attributes: {
        [ATTR_MESSAGING_SYSTEM]: MESSAGING_SYSTEM_AWS_EVENTBRIDGE,
        [ATTR_MESSAGING_OPERATION_TYPE]: MESSAGING_OPERATION_TYPE_PROCESS,
        ...(typeof event.source === "string" && event.source !== ""
          ? { [ATTR_AWS_EVENTBRIDGE_SOURCE]: event.source }
          : {}),
        ...(typeof event["detail-type"] === "string" && event["detail-type"] !== ""
          ? { [ATTR_AWS_EVENTBRIDGE_DETAIL_TYPE]: event["detail-type"] }
          : {}),
        ...(typeof event.id === "string" && event.id !== ""
          ? { [ATTR_AWS_EVENTBRIDGE_EVENT_ID]: event.id }
          : {}),
        [ATTR_SEKIMORI_CONTEXT_SOURCE]: extracted.source,
        ...options.attributes,
      },
    },
    fn,
  );
}
