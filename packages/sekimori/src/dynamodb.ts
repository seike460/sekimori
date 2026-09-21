/** DynamoDB Streams record 向け carrier — item attribute への inject / 抽出と record span。 */
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
  carrierHasW3c,
  consumerSpanPlan,
  hasCarrierKey,
  hasNewBaggage,
  isTracingSuppressed,
  newSpanContext,
  objectGetter,
  pinnedW3cTraceConflicts,
  pinnedW3cTraceId,
  preserveBaseBaggage,
  removeCarrierKey,
  removeW3cSpanSlots,
  scrubStaleXrayField,
  stripW3cCarrierKeys,
  TRACEPARENT_KEY,
  TRACESTATE_KEY,
  w3cSpanPairPinned,
  XRAY_FIELD,
} from "./carriers.js";
import {
  assertConsumeOptions,
  assertInjectOptions,
  assertObject,
  assertPlainObject,
  isPlainObject,
} from "./errors.js";
import {
  ATTR_AWS_DYNAMODB_TABLE_ARN,
  ATTR_MESSAGING_DESTINATION_NAME,
  ATTR_MESSAGING_OPERATION_TYPE,
  ATTR_MESSAGING_SYSTEM,
  ATTR_SEKIMORI_CONTEXT_SOURCE,
  MESSAGING_OPERATION_TYPE_PROCESS,
  MESSAGING_SYSTEM_AWS_DYNAMODB,
} from "./semconv.js";
import { withConsumerSpan } from "./span.js";
import type { ConsumeOptions, Extracted, InjectOptions } from "./types.js";

/**
 * item に載せる W3C carrier の属性名（opt-in 規約・experimental）。
 * DynamoDB にはネイティブの trace channel が無い。`_` 始まりでアプリ属性と衝突しにくくする。
 */
export const DYNAMODB_TRACE_ATTRIBUTE = "_trace";

/** PutItem する item（DocumentClient 相当の plain object）。 */
export type DynamoDbItemLike = Record<string, unknown>;

/** DynamoDB AttributeValue の最小形（Streams の NewImage がこの形で届く）。 */
export interface AttributeValueLike {
  S?: string | undefined;
  M?: Record<string, AttributeValueLike> | undefined;
}

/** Lambda に届く DynamoDB Streams record の最小形。 */
export interface DynamoDbRecordLike {
  eventSourceARN?: string | undefined;
  dynamodb?: { NewImage?: Record<string, AttributeValueLike> | undefined } | undefined;
}

/**
 * PutItem する item に `_trace` 属性（plain object）として W3C carrier を書く。
 * DocumentClient / `marshal` 前の item を想定。`_trace` が既に plain object の場合は
 * carrier key を merge し既存の非 carrier key は保つ。primitive / array の `_trace` は
 * 上書きしない（extract 側も carrier として読まない）。
 * item は JSON 化可能な plain object のみ — spread で返すため class instance は prototype を失う。
 */
export function injectDynamoDbItem<T extends object>(
  item: T,
  options: InjectOptions = {},
): T & DynamoDbItemLike {
  assertObject(item, "injectDynamoDbItem");
  // Map / Set / Date / class instance は spread で `{}` や enumerable field だけの
  // 複製になり、item の内容が silent に失われるため弾く。
  assertPlainObject(item, "injectDynamoDbItem", "item");
  assertObject(options, "injectDynamoDbItem");
  assertInjectOptions(options, "injectDynamoDbItem");
  const ctx = baseContext(options.context, "injectDynamoDbItem");
  const spanContext = trace.getSpanContext(ctx);
  const out: Record<string, unknown> = { ...asRecord(item) };
  // suppress された context では carrier を書かない（計装抑止の意図に反するため）。
  if (isTracingSuppressed(ctx)) return out as T & DynamoDbItemLike;
  // `w3c: false` は W3C key を書かないという意味 — inject 自体は行い、
  // `x-amzn-trace-id` 等の non-W3C field は残す（xray-only propagator で
  // context が全喪失するのを防ぐ）。
  const carrier: Record<string, string> = {};
  propagation.inject(ctx, carrier);
  if (options.w3c === false) stripW3cCarrierKeys(carrier);
  const carrierWroteW3c = carrierHasW3c(carrier);
  const traceField: Record<string, string> = {};
  for (const [k, v] of Object.entries(carrier)) {
    // `x-amzn-trace-id` は W3C context があるときだけ捨てる — xray-only propagator では
    // これが唯一の context なので残す。
    if (k.toLowerCase() === XRAY_FIELD && carrierWroteW3c) continue;
    traceField[k] = v;
  }
  const existing = out[DYNAMODB_TRACE_ATTRIBUTE];
  // `_trace: null` は「未設定」と同じ — extract 側も null を carrier として読まない。
  // null を温存すると item に carrier が載らず context が silent に失われる。
  // `_trace` が plain object のときだけ merge する。Map / Set / class instance は
  // spread で `{}` や enumerable field だけの複製になり、caller の値（`custom` key や
  // prototype method）が silent に失われるため merge しない（値はそのまま残し、
  // carrier も書かない — primitive / array と同じ扱い）。
  if (existing === undefined || existing === null) {
    if (Object.keys(traceField).length > 0) out[DYNAMODB_TRACE_ATTRIBUTE] = traceField;
  } else if (isPlainObject(existing)) {
    // 呼び出し側の object を mutate しないよう clone してから merge する。
    const target = { ...existing };
    // 呼び出し側が pin した `traceparent`/`tracestate` — 対の slot。片方でも既存なら
    // carrier 側の両方を書かず、pin された対を scrub もしない（SQS と同じ規約）。
    const w3cPinned = options.w3c !== false && w3cSpanPairPinned(target);
    // pin された traceparent が active span と別 trace を指す場合、`_trace` 内の
    // `x-amzn-trace-id` に fresh な trace を書くと pin を読む側と xray を読む側で
    // trace が分かれる — そのときは xray slot の書き込み・削除を抑止して pin 側に
    // 揃える（DynamoDB に native channel は無いが carrier 内では同じ問題）。
    const pinnedConflict =
      w3cPinned &&
      spanContext !== undefined &&
      isSpanContextValid(spanContext) &&
      pinnedW3cTraceConflicts(target, spanContext);
    // `x-amzn-trace-id` は伝播 slot — fresh な traceparent と古い hop の値が同居すると
    // xray を優先する読み手（xray-only propagator / xray-last 構成）が stale context を
    // 選ぶため消す。`tracestate` も traceparent と対の slot なので同様に扱う。
    if (carrierWroteW3c) {
      // pin 衝突時は carrier の fresh traceparent は pin に負けて書かれない —
      // caller の x-amzn-trace-id（pin に合致し得る）を残す。
      if (!pinnedConflict) removeCarrierKey(target, XRAY_FIELD);
      if (!w3cPinned && !hasCarrierKey(carrier, TRACESTATE_KEY)) {
        removeCarrierKey(target, TRACESTATE_KEY);
      }
    }
    let carrierWroteXray = false;
    for (const [k, v] of Object.entries(traceField)) {
      // xray-only では x-amzn-trace-id が唯一の context — 同じ slot として上書きする。
      const lower = k.toLowerCase();
      if (lower === XRAY_FIELD) {
        // pin された W3C と別 trace の xray 値で caller の slot を上書きすると
        // _trace 内で split-brain になる — pin に合致する既存値を残す。
        if (pinnedConflict) continue;
        removeCarrierKey(target, k);
        target[k] = v;
        carrierWroteXray = true;
      } else if (
        lower === TRACEPARENT_KEY || lower === TRACESTATE_KEY ? w3cPinned : hasCarrierKey(target, k)
      ) {
      } else {
        target[k] = v;
      }
    }
    // pin 衝突時、`_trace` 内の stale な `x-amzn-trace-id` が xray を優先する
    // 読み手に pin より先に拾われる — pin の trace に照合して消す（SQS と同じ規約）。
    if (pinnedConflict) {
      const pinTraceId = pinnedW3cTraceId(target);
      if (pinTraceId !== undefined) scrubStaleXrayField(target, pinTraceId);
    }
    // xray-only propagator で fresh な xray field を書いたのに stale な traceparent/
    // tracestate が残ると、ADOT 既定の composite（tracecontext が後勝ち）が stale な
    // W3C context を選ぶ split-brain になる（SQS と同じ方針。pin 済みの対は除く）。
    if (carrierWroteXray && !w3cPinned) removeW3cSpanSlots(target);
    out[DYNAMODB_TRACE_ATTRIBUTE] = target;
  }
  return out as T & DynamoDbItemLike;
}

function attributeMapToCarrier(
  image: Record<string, AttributeValueLike>,
): Record<string, unknown> | undefined {
  const field = image[DYNAMODB_TRACE_ATTRIBUTE]?.M;
  if (!field) return undefined;
  const carrier: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(field)) carrier[k] = v?.S;
  return carrier;
}

/**
 * DynamoDB Streams record の `NewImage._trace`（opt-in 規約）から producer context を取り出す。
 * `_trace` を付けて Put された item だけに効く。experimental。
 */
export function extractFromDynamoDbRecord(
  record: DynamoDbRecordLike,
  options: { context?: Context } = {},
): Extracted {
  assertObject(record, "extractFromDynamoDbRecord");
  assertObject(options, "extractFromDynamoDbRecord");
  const base = baseContext(options.context, "extractFromDynamoDbRecord");
  const image = record.dynamodb?.NewImage;
  if (image) {
    const carrier = attributeMapToCarrier(image);
    if (carrier) {
      const ctx = propagation.extract(base, carrier, objectGetter);
      const spanContext = newSpanContext(base, ctx);
      // carrier が baggage だけを載せる（traceparent なし）場合も source を記録する。
      // そのとき spanContext は付けない（self-link 防止）。
      if (spanContext !== undefined || hasNewBaggage(base, ctx)) {
        return {
          context: preserveBaseBaggage(ctx, base),
          source: "stream-image",
          ...(spanContext !== undefined ? { spanContext } : {}),
        };
      }
    }
  }
  return { context: base, source: "none" };
}

function tableNameFromArn(arn: string | undefined): string | undefined {
  if (typeof arn !== "string" || arn === "") return undefined;
  // arn:aws:dynamodb:region:account:table/name/stream/...
  const m = /:table\/([^/]+)/.exec(arn);
  return m?.[1];
}

/**
 * DynamoDB Streams record 1 件を処理する CONSUMER span を開く（experimental）。
 * 親は invocation span、producer（Put した側）へは link。
 */
export async function withDynamoDbRecord<T>(
  record: DynamoDbRecordLike,
  fn: (span: Span) => Promise<T> | T,
  options: ConsumeOptions = {},
): Promise<T> {
  assertObject(record, "withDynamoDbRecord");
  assertObject(options, "withDynamoDbRecord");
  assertConsumeOptions(options, "withDynamoDbRecord");
  const base = baseContext(options.context, "withDynamoDbRecord");
  const extracted = extractFromDynamoDbRecord(record, { context: base });
  // baggage は常に union（producer mode でも base 側の entry を消さない）。
  const { parent, link } = consumerSpanPlan(base, extracted, options.parent);
  const table = tableNameFromArn(record.eventSourceARN);
  // eventSourceARN は stream ARN（.../table/<name>/stream/<ts>）— attribute 名は
  // table_arn なので `/stream/...` 以降を削って table ARN に戻す。
  const eventSourceArn =
    typeof record.eventSourceARN === "string" && record.eventSourceARN !== ""
      ? record.eventSourceARN
      : undefined;
  const tableArn = eventSourceArn?.includes(":table/")
    ? eventSourceArn.split("/stream/")[0]
    : undefined;
  return withConsumerSpan(
    options.name ?? `process ${table ?? "dynamodb-stream"}`,
    {
      parent,
      link,
      attributes: {
        [ATTR_MESSAGING_SYSTEM]: MESSAGING_SYSTEM_AWS_DYNAMODB,
        [ATTR_MESSAGING_OPERATION_TYPE]: MESSAGING_OPERATION_TYPE_PROCESS,
        ...(tableArn !== undefined ? { [ATTR_AWS_DYNAMODB_TABLE_ARN]: tableArn } : {}),
        ...(table !== undefined ? { [ATTR_MESSAGING_DESTINATION_NAME]: table } : {}),
        [ATTR_SEKIMORI_CONTEXT_SOURCE]: extracted.source,
        ...options.attributes,
      },
    },
    fn,
  );
}
