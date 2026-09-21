/** trace context carrier の共有 primitive — pin/conflict 判定、baggage merge、context key、境界 narrow。 */
import {
  type Context,
  createContextKey,
  isSpanContextValid,
  context as otelContext,
  propagation,
  type SpanContext,
  type TextMapGetter,
  trace,
} from "@opentelemetry/api";
import { assertContext } from "./errors.js";
import type { Extracted } from "./types.js";
import { parseXrayTraceHeader } from "./xray-header.js";

/**
 * `@opentelemetry/core` の `SUPPRESS_TRACING_KEY` と同じ context key。
 * core は dependency に持てない（peer は api のみ）ため、key 文字列が spec 固定なのを
 * 利用して `Symbol.for` 経由の同一 symbol をここで作る。
 */
const SUPPRESS_TRACING_KEY = createContextKey("OpenTelemetry SDK Context Key SUPPRESS_TRACING");

/** SDK の `suppressTracing` で抑止された context か。core の `isTracingSuppressed` と同値。 */
export function isTracingSuppressed(ctx: Context): boolean {
  return ctx.getValue(SUPPRESS_TRACING_KEY) === true;
}

/** `unknown` を `Record<string, unknown>` へ絞る — JSON object（非配列）ならそのまま、それ以外は undefined。 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * DEC-002 の parent/link 選択 — baggage を base に union し、`parent: "producer"` 指定時だけ
 * producer の SpanContext を親に据える（それ以外は link として withConsumerSpan へ残す）。
 */
export function consumerSpanPlan(
  base: Context,
  extracted: Extracted,
  parentMode: "invocation" | "producer" | undefined,
): { parent: Context; link: SpanContext | undefined } {
  const merged = mergeBaggage(base, extracted.context);
  const parent =
    parentMode === "producer" && extracted.spanContext !== undefined
      ? trace.setSpanContext(merged, extracted.spanContext)
      : merged;
  const link = parentMode === "producer" ? undefined : extracted.spanContext;
  return { parent, link };
}

/** AWS SDK v3 の SendMessage / PublishBatch が受ける属性値の形。 */
export interface SdkMessageAttributeValue {
  DataType: string;
  StringValue?: string | undefined;
  BinaryValue?: Uint8Array | undefined;
}
export type SdkMessageAttributes = Record<string, SdkMessageAttributeValue>;

/** Lambda の SQSRecord.messageAttributes の形（camelCase）。SDK 形（PascalCase）も受ける。 */
export interface RecordMessageAttributeValue {
  stringValue?: string | undefined;
  StringValue?: string | undefined;
  dataType?: string | undefined;
  DataType?: string | undefined;
}
export type RecordMessageAttributes = Record<string, RecordMessageAttributeValue>;

function findKey(carrier: Record<string, unknown>, key: string): string | undefined {
  if (key in carrier) return key;
  const lower = key.toLowerCase();
  return Object.keys(carrier).find((k) => k.toLowerCase() === lower);
}

/** carrier に key が（大文字小文字を区別せず）存在するか。inject 時に利用者の key を守るために使う。 */
export function hasCarrierKey(carrier: Record<string, unknown>, key: string): boolean {
  return findKey(carrier, key) !== undefined;
}

/** carrier target から key を（大文字小文字を区別せず）取り除く。除去したら true。 */
export function removeCarrierKey(carrier: Record<string, unknown>, key: string): boolean {
  const k = findKey(carrier, key);
  if (k === undefined) return false;
  delete carrier[k];
  return true;
}

/** `options.context`（明示 Context）を検査して返す。未指定なら active context。 */
export function baseContext(context: Context | undefined, api: string): Context {
  assertContext(context, api);
  return context ?? otelContext.active();
}

/** message attributes から文字列値だけを読む getter（大文字小文字を区別しない）。 */
export const recordAttributesGetter: TextMapGetter<RecordMessageAttributes> = {
  keys: (carrier) => Object.keys(carrier),
  get(carrier, key) {
    const k = findKey(carrier, key);
    if (k === undefined) return undefined;
    // TextMapGetter の契約は string — 非 string 値は custom propagator の `.split()` 等を
    // 落とすため undefined に畳む（objectGetter と同じ方針）。camelCase / PascalCase の
    // 両形を受けるため、片側が非 string や空文字でも有効な文字列側へ fallback する
    // （`stringValue: ""` が valid な `StringValue` を shadow しない）。
    const v = carrier[k]?.stringValue;
    if (typeof v === "string" && v !== "") return v;
    const w = carrier[k]?.StringValue;
    return typeof w === "string" && w !== "" ? w : undefined;
  },
};

/** SNS envelope（非 raw 配信で SQS body に入る JSON）の MessageAttributes: `{ Type, Value }`。 */
export type SnsEnvelopeAttributes = Record<
  string,
  { Type?: string | undefined; Value?: string | undefined }
>;
export const snsEnvelopeAttributesGetter: TextMapGetter<SnsEnvelopeAttributes> = {
  keys: (carrier) => Object.keys(carrier),
  get(carrier, key) {
    const k = findKey(carrier, key);
    const v = k === undefined ? undefined : carrier[k]?.Value;
    return typeof v === "string" ? v : undefined;
  },
};

/** 任意の JSON object（EventBridge `detail` / payload envelope）から文字列値だけを読む getter。 */
export const objectGetter: TextMapGetter<Record<string, unknown>> = {
  keys: (carrier) => Object.keys(carrier),
  get(carrier, key) {
    const k = findKey(carrier, key);
    if (k === undefined) return undefined;
    const v = carrier[k];
    return typeof v === "string" ? v : undefined;
  },
};

/** W3C Trace Context / AWS X-Ray の propagation key 名 — wire 上の正本をここに集約する。 */
export const TRACEPARENT_KEY = "traceparent";
export const TRACESTATE_KEY = "tracestate";
export const BAGGAGE_KEY = "baggage";
export const XRAY_FIELD = "x-amzn-trace-id";

/**
 * inject 済み carrier が W3C context（traceparent）を含むか。
 * X-Ray propagator の `x-amzn-trace-id` は W3C があるときだけ冗長 — carrier が xray field
 * だけを持つ（X-Ray-only propagator 構成）場合は唯一の context なので剥がしてはいけない。
 */
export function carrierHasW3c(carrier: Record<string, string>): boolean {
  return hasCarrierKey(carrier, TRACEPARENT_KEY);
}

/**
 * `target` から stale な W3C span slot（`traceparent` / `tracestate`）を消す。
 * fresh な X-Ray context を書いたのに古い hop の W3C slot を残すと、ADOT layer 既定の
 * composite propagator（`baggage,xray,tracecontext` — 順に extract され後勝ちするため
 * traceparent が最終的に選ばれる）が stale な W3C context を fresh な xray より優先して
 * 拾う split-brain になるため。除去したら true。
 */
export function removeW3cSpanSlots(target: Record<string, unknown>): boolean {
  const a = removeCarrierKey(target, TRACEPARENT_KEY);
  const b = removeCarrierKey(target, TRACESTATE_KEY);
  return a || b;
}

/**
 * `traceparent` / `tracestate` は対の slot — 呼び出し側がどちらかを pin した状態で
 * carrier の対を埋めると、別 trace の traceparent+tracestate が混在する（pin した
 * traceparent に fresh な tracestate が付く等）。どちらかが target に既存なら
 * 「対が pin 済み」として carrier 側の両方の書き込み・scrub を止める。
 */
export function w3cSpanPairPinned(target: Record<string, unknown>): boolean {
  return hasCarrierKey(target, TRACEPARENT_KEY) || hasCarrierKey(target, TRACESTATE_KEY);
}

/**
 * SDK attribute map（SQS/SNS 共通）に対する W3C pin の判定。
 * `w3cAllowed` = `options.w3c !== false`。`w3cPinned` は対の片方でも既存なら true、
 * `pinnedConflict` は pin 済み traceparent が active span と別 trace を指すとき true —
 * その場合 carrier/xray slot への fresh な書き込みを抑止して pin 側に揃える。
 */
export function w3cPinPlan(
  attributes: Record<
    string,
    { StringValue?: string | undefined; stringValue?: string | undefined } | undefined
  >,
  spanContext: SpanContext | undefined,
  w3cAllowed: boolean,
): { w3cPinned: boolean; pinnedConflict: boolean } {
  const w3cPinned = w3cAllowed && w3cSpanPairPinned(attributes);
  const pinnedConflict =
    w3cPinned &&
    spanContext !== undefined &&
    isSpanContextValid(spanContext) &&
    sdkPinnedW3cTraceConflicts(attributes, spanContext);
  return { w3cPinned, pinnedConflict };
}

/**
 * `W3CTraceContextPropagator` の `TRACE_PARENT_REGEX` と同じ grammar。
 * pin 判定が extractor の読み取りと一致しないと、誰も読めない pin のために X-Ray
 * channel を抑止する（context 全喪失）か、読める pin を見逃して split-brain になる。
 */
const TRACEPARENT_RE =
  /^\s?((?!ff)[\da-f]{2})-((?!0{32})[\da-f]{32})-((?!0{16})[\da-f]{16})-([\da-f]{2})(-.*)?\s?$/;

/**
 * `traceparent` 値から trace-id を取り出す（extractor と同じ grammar で parse）。
 * spec 上 valid でない pin（all-zero id / `ff` version / 非 hex / 不正 flags 等）は
 * compliant な extractor が読まない「競合する valid context」ではないため
 * undefined — その場合に X-Ray channel まで抑止すると context が全喪失する。
 */
function traceparentTraceId(value: string): string | undefined {
  const m = TRACEPARENT_RE.exec(value);
  // version `00` で extra field を持つ値は spec 上 reject（将来 version は後方に
  // field を足し得るため `(-.*)?` を許容するのは `00` 以外）。
  if (m === null || (m[1] === "00" && m[5] !== undefined)) return undefined;
  return m[2];
}

/** SDK attribute value の文字列表現 — extractor（`recordAttributesGetter`）と同じ優先順位。 */
function sdkAttributeStringValue(
  attr: { StringValue?: string | undefined; stringValue?: string | undefined } | undefined,
): string | undefined {
  // 空でない `stringValue` → `StringValue` の順（空文字や非 string が valid 値を
  // shadow しない）。逆順や `??` だと extractor が読む値と食い違う。
  const v = attr?.stringValue;
  if (typeof v === "string" && v !== "") return v;
  const w = attr?.StringValue;
  return typeof w === "string" && w !== "" ? w : undefined;
}

/**
 * pin された `traceparent` の trace-id を返す（extractor と同じ grammar）。
 * spec 上 valid でない pin は「競合する valid context」ではないため undefined。
 */
export function pinnedW3cTraceId(target: Record<string, unknown>): string | undefined {
  const k = findKey(target, TRACEPARENT_KEY);
  const v = k === undefined ? undefined : target[k];
  return typeof v === "string" ? traceparentTraceId(v) : undefined;
}

/**
 * `pinnedW3cTraceId` の SDK attribute map 版。
 * `MessageAttributes` の値は `{ DataType, StringValue }` の object なので
 * `StringValue`（camelCase `stringValue` も許容）を unwrap しないと pin が読めない。
 */
export function sdkPinnedW3cTraceId(
  target: Record<
    string,
    { StringValue?: string | undefined; stringValue?: string | undefined } | undefined
  >,
): string | undefined {
  const k = findKey(target, TRACEPARENT_KEY);
  const s = k === undefined ? undefined : sdkAttributeStringValue(target[k]);
  return s !== undefined ? traceparentTraceId(s) : undefined;
}

/**
 * pin された `traceparent` が `spanContext` と別の trace を指すか。
 * pin が valid な traceparent なのに active span の trace-id と食い違う場合、
 * native X-Ray channel（`AWSTraceHeader` / `TraceHeader` / `traceHeader`）や
 * `x-amzn-trace-id` field に fresh な trace を書くと、carrier の pin 値を読む側と
 * X-Ray channel を読む側で別 trace に分かれる split-brain になる — そのときだけ
 * true を返し、呼び出し側は X-Ray slot の fresh 書き込みを抑止する。
 * parse できない pin は「競合する valid context」ではないため false。
 */
export function pinnedW3cTraceConflicts(
  target: Record<string, unknown>,
  spanContext: SpanContext,
): boolean {
  const traceId = pinnedW3cTraceId(target);
  return traceId !== undefined && traceId !== spanContext.traceId.toLowerCase();
}

/**
 * `pinnedW3cTraceConflicts` の SDK attribute map 版。
 * `MessageAttributes` の値は `{ DataType, StringValue }` の object なので
 * `StringValue`（camelCase `stringValue` も許容）を unwrap しないと pin が読めない。
 */
export function sdkPinnedW3cTraceConflicts(
  target: Record<
    string,
    { StringValue?: string | undefined; stringValue?: string | undefined } | undefined
  >,
  spanContext: SpanContext,
): boolean {
  const traceId = sdkPinnedW3cTraceId(target);
  return traceId !== undefined && traceId !== spanContext.traceId.toLowerCase();
}

/**
 * pin 済み trace（`pinTraceId`）と別 trace を指す `x-amzn-trace-id` を消す。
 * pin が authoritative なのに別 trace の stale slot が残ると、xray を優先する
 * 読み手（xray-only propagator / xray-last 構成）が pin に勝つ split-brain になる。
 * parse できない値（extractor も読めない = 無害）と pin に合致する値は残す。
 * 除去したら true。
 */
export function scrubStaleXrayField(target: Record<string, unknown>, pinTraceId: string): boolean {
  const k = findKey(target, XRAY_FIELD);
  if (k === undefined) return false;
  const v = target[k];
  const parsed = typeof v === "string" ? parseXrayTraceHeader(v) : undefined;
  if (parsed === undefined || parsed.traceId === pinTraceId) return false;
  delete target[k];
  return true;
}

/** `scrubStaleXrayField` の SDK attribute map 版。値は extractor と同じ優先順位で unwrap する。 */
export function scrubStaleSdkXrayAttribute(
  target: Record<
    string,
    { StringValue?: string | undefined; stringValue?: string | undefined } | undefined
  >,
  pinTraceId: string,
): boolean {
  const k = findKey(target, XRAY_FIELD);
  if (k === undefined) return false;
  const s = sdkAttributeStringValue(target[k]);
  const parsed = s !== undefined ? parseXrayTraceHeader(s) : undefined;
  if (parsed === undefined || parsed.traceId === pinTraceId) return false;
  delete target[k];
  return true;
}

/**
 * inject 済み carrier を SDK attribute map（SQS `MessageAttributes` / SNS 同形）へ
 * merge する共通規約 — SQS / SNS inject が共有する pin・scrub・上書き保護のルール。
 * - 呼び出し側が置いた key は上書きしない（case-insensitive）
 * - `x-amzn-trace-id` は W3C context があるときだけ捨てる（xray-only propagator では
 *   唯一の context なので残す — 同じ slot として古い値を上書きする）
 * - `w3cSlotsPinned` = carrier の `traceparent`/`tracestate` を書かない
 *   （W3C pin だけでなく native xray pin 衝突で W3C を抑止するケースも含む）
 * - `xrayConflict` = pin と別 trace の xray 値で caller の slot を上書きしない
 * - `pinTraceId` があれば、pin と別 trace の stale な `x-amzn-trace-id` を消す
 * @returns `wroteXray` = fresh な `x-amzn-trace-id` を書いたか
 */
export function mergeSdkAttributesCarrier(
  attributes: SdkMessageAttributes,
  carrier: Record<string, string>,
  plan: {
    readonly carrierWroteW3c: boolean;
    readonly w3cSlotsPinned: boolean;
    readonly xrayConflict: boolean;
    readonly pinTraceId?: string | undefined;
  },
): { wroteXray: boolean } {
  // `x-amzn-trace-id` は伝播 slot — fresh な traceparent と古い hop の値が同居すると、
  // xray を優先する読み手（xray-only propagator / xray-last 構成、および extract が
  // attributes を先に読む経路）が stale context を選ぶため消す。`tracestate` は
  // traceparent と対の slot — carrier が出さないのに入力由来が残ると別 trace の
  // vendor state が fresh context に紛れるため同様に消す（pin 済みの対は消さない）。
  if (plan.carrierWroteW3c) {
    // pin 衝突時は carrier の fresh traceparent は pin に負けて書かれない —
    // caller の x-amzn-trace-id（pin に合致し得る）を残す。
    if (!plan.xrayConflict) removeCarrierKey(attributes, XRAY_FIELD);
    if (!plan.w3cSlotsPinned && !hasCarrierKey(carrier, TRACESTATE_KEY)) {
      removeCarrierKey(attributes, TRACESTATE_KEY);
    }
  }
  let wroteXray = false;
  for (const [k, v] of Object.entries(carrier)) {
    const lower = k.toLowerCase();
    const isXrayField = lower === XRAY_FIELD;
    if (isXrayField && (plan.carrierWroteW3c || plan.xrayConflict)) continue;
    if (isXrayField) {
      removeCarrierKey(attributes, k);
      wroteXray = true;
    } else if (
      lower === TRACEPARENT_KEY || lower === TRACESTATE_KEY
        ? plan.w3cSlotsPinned
        : hasCarrierKey(attributes, k)
    ) {
      continue;
    }
    attributes[k] = { DataType: "String", StringValue: v };
  }
  if (plan.pinTraceId !== undefined) {
    scrubStaleSdkXrayAttribute(attributes, plan.pinTraceId);
  }
  return { wroteXray };
}

/**
 * `w3c: false` — inject 済み carrier から W3C key（`traceparent` / `tracestate` /
 * `baggage`）を除く。`x-amzn-trace-id` 等の non-W3C field は残す。
 * `propagation.inject` 自体を呼ばない実装だと xray-only propagator の context が
 * 全喪失するため、inject してから W3C key だけを落とす。
 */
export function stripW3cCarrierKeys(carrier: Record<string, string>): void {
  for (const k of Object.keys(carrier)) {
    const lower = k.toLowerCase();
    if (lower === TRACEPARENT_KEY || lower === TRACESTATE_KEY || lower === BAGGAGE_KEY) {
      delete carrier[k];
    }
  }
}

/** グローバル propagator に X-Ray propagator（ADOT layer 既定 `baggage,xray,tracecontext`）が含まれるか。 */
export function globalPropagatorHasXray(): boolean {
  return propagation.fields().some((f) => f.toLowerCase() === XRAY_FIELD);
}

/**
 * `ctx` が `base` とは別の valid な span context を持つとき、その SpanContext を返す。
 * carrier に traceparent が無い（baggage だけ等）場合や、base と同じ span なら undefined —
 * `Extracted.spanContext` に載せてよい producer context かどうかの判定に使う。
 */
export function newSpanContext(base: Context, ctx: Context): SpanContext | undefined {
  const a = trace.getSpanContext(base);
  const b = trace.getSpanContext(ctx);
  if (!b || !isSpanContextValid(b)) return undefined;
  return a?.traceId === b.traceId && a?.spanId === b.spanId ? undefined : b;
}

/**
 * `extracted` が `base` に無い baggage entry（または metadata の違う entry）を持つか。
 * carrier が baggage だけを載せる（traceparent なし）ケースを検出するのに使う。
 */
export function hasNewBaggage(base: Context, extracted: Context): boolean {
  const a = new Map(propagation.getBaggage(base)?.getAllEntries() ?? []);
  return (propagation.getBaggage(extracted)?.getAllEntries() ?? []).some(([k, v]) => {
    const existing = a.get(k);
    return existing?.value !== v.value || existing?.metadata !== v.metadata;
  });
}

/**
 * `extracted` の baggage entry を `base` の baggage に畳み込んだ context を返す（union）。
 * `base` 側に既にある entry は残り、衝突した key だけ `extracted`（carrier 側）が勝つ。
 * DEC-002 の link mode でも producer の baggage を殺さないために、consumer span を
 * 開くときの active context として使う。新しい entry が無ければ `base` をそのまま返す。
 */
export function mergeBaggage(base: Context, extracted: Context): Context {
  const extractedBag = propagation.getBaggage(extracted);
  if (extractedBag === undefined) return base;
  const baseBag = propagation.getBaggage(base) ?? propagation.createBaggage();
  let merged = baseBag;
  for (const [k, v] of extractedBag.getAllEntries()) {
    merged = merged.setEntry(k, v);
  }
  return merged === baseBag ? base : propagation.setBaggage(base, merged);
}

/**
 * carrier 由来の `onto` context に `base` の baggage entry を union して返す。
 * baggage extractor が merge ではなく replace する propagator でも、direct `extractFrom*`
 * API の戻り値が base の entry を落とさないようにする。key 衝突は `onto`（carrier 側）が
 * 勝ち、`onto` の span context は保つ（`mergeBaggage` とは base/extracted の役割が逆）。
 */
export function preserveBaseBaggage(onto: Context, base: Context): Context {
  const baseBag = propagation.getBaggage(base);
  if (baseBag === undefined) return onto;
  let merged = baseBag;
  for (const [k, v] of propagation.getBaggage(onto)?.getAllEntries() ?? []) {
    merged = merged.setEntry(k, v);
  }
  return propagation.setBaggage(onto, merged);
}
