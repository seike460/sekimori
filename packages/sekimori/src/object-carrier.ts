// object carrier（EventBridge `detail` / Kinesis payload envelope）への merge。
// carriers.js の carrier primitive（pin 判定・key 操作・baggage merge）を組み合わせて
// 「JSON object に carrier を安全に埋め込む / 読み出す」規約を提供する。
import { type Context, isSpanContextValid, propagation, trace } from "@opentelemetry/api";
import {
  asRecord,
  carrierHasW3c,
  hasCarrierKey,
  hasNewBaggage,
  mergeBaggage,
  newSpanContext,
  pinnedW3cTraceConflicts,
  pinnedW3cTraceId,
  preserveBaseBaggage,
  removeCarrierKey,
  scrubStaleXrayField,
  stripW3cCarrierKeys,
  TRACEPARENT_KEY,
  TRACESTATE_KEY,
  w3cSpanPairPinned,
  XRAY_FIELD,
} from "./carriers.js";
import type { CarrierSource, Extracted, InjectOptions } from "./types.js";

/**
 * JSON 文字列を plain object として parse する。
 * parse 失敗・非 object（配列・null・primitive）なら undefined — carrier を
 * 埋め込める / 読める形かの判定に使う。propagator 等の例外は飲み込まない。
 */
export function parseJsonObject(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined || text === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return asRecord(parsed);
  } catch {
    // JSON parse 失敗 = carrier を埋め込める object ではない。
    return undefined;
  }
}

/**
 * `ctx` の carrier を `propagation.inject` で取り出す。
 * `w3c: false` は W3C key を書かないという意味 — inject 自体は行い、
 * `x-amzn-trace-id` 等の non-W3C field は残す（xray-only propagator で
 * context が全喪失するのを防ぐ）。
 */
export function injectCarrier(ctx: Context, options: InjectOptions): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(ctx, carrier);
  if (options.w3c === false) stripW3cCarrierKeys(carrier);
  return carrier;
}

/**
 * object carrier への carrier マージ計画 — pin 状態と conflict を 1 か所で判定する。
 * 呼び出し側が pin した `traceparent`/`tracestate` は対の slot: 片方でも既存なら
 * carrier 側の両方を書かず、pin された対を scrub もしない。ただし `w3c: false`
 * 指定の下では入力由来の W3C slot は pin ではなく stale 扱いにする。
 * pin された traceparent が active span と別 trace を指す場合、X-Ray slot に
 * fresh な trace を書くと pin を読む側と X-Ray channel を読む側で trace が
 * 分かれる split-brain になる — そのときは X-Ray slot の書き込みを抑止して
 * pin 側に揃える（`pinnedConflict`）。
 */
export interface ObjectCarrierPlan {
  /** inject 済み carrier が W3C context（traceparent）を持つか。 */
  readonly carrierWroteW3c: boolean;
  /** 呼び出し側が `traceparent`/`tracestate` の対を pin 済みか。 */
  readonly w3cPinned: boolean;
  /** pin が active span と別 trace を指すか。 */
  readonly pinnedConflict: boolean;
}

/** pin / conflict の判定は extractor と同じ grammar（`pinnedW3cTraceId`）で行う。 */
export function planObjectCarrier(
  target: Record<string, unknown>,
  carrier: Record<string, string>,
  ctx: Context,
  w3cOption: boolean | undefined,
): ObjectCarrierPlan {
  const carrierWroteW3c = carrierHasW3c(carrier);
  const w3cPinned = w3cOption !== false && w3cSpanPairPinned(target);
  const spanContext = trace.getSpanContext(ctx);
  const pinnedConflict =
    w3cPinned &&
    spanContext !== undefined &&
    isSpanContextValid(spanContext) &&
    pinnedW3cTraceConflicts(target, spanContext);
  return { carrierWroteW3c, w3cPinned, pinnedConflict };
}

/** detail 不在・suppressed 時の merge 計画（pin / conflict なし）。 */
export const EMPTY_CARRIER_PLAN: ObjectCarrierPlan = {
  carrierWroteW3c: false,
  w3cPinned: false,
  pinnedConflict: false,
};

/**
 * inject 済み carrier を object carrier `target` にマージする。
 * - 利用者の既存 key は上書きしない（case-insensitive）
 * - `x-amzn-trace-id` は W3C context があるときだけ捨てる — xray-only propagator では
 *   これが唯一の context なので残す（同じ slot として古い値を上書きする）
 * - pin 衝突時は pin に合致する既存値を残し、pin と別 trace の stale 値は消す
 * @returns `wrote` = target が変更されたか（再 serialize 要否）、
 *          `wroteXray` = fresh な `x-amzn-trace-id` を書いたか
 */
export function mergeObjectCarrier(
  target: Record<string, unknown>,
  carrier: Record<string, string>,
  plan: ObjectCarrierPlan,
): { wrote: boolean; wroteXray: boolean } {
  let wrote = false;
  // `x-amzn-trace-id` は伝播 slot — fresh な traceparent と古い hop の値が同居すると
  // xray を優先する読み手が stale context を選ぶため消す。`tracestate` も対の slot。
  if (plan.carrierWroteW3c) {
    // pin 衝突時は carrier の fresh traceparent は pin に負けて書かれない —
    // caller の x-amzn-trace-id（pin に合致し得る）を残す。
    if (!plan.pinnedConflict) wrote = removeCarrierKey(target, XRAY_FIELD) || wrote;
    if (!plan.w3cPinned && !hasCarrierKey(carrier, TRACESTATE_KEY)) {
      wrote = removeCarrierKey(target, TRACESTATE_KEY) || wrote;
    }
  }
  // pin 衝突時、pin と別 trace の stale な `x-amzn-trace-id` が残ると xray を
  // 優先する読み手が pin に勝つ — pin の trace に照合して消す。
  if (plan.pinnedConflict) {
    const pinTraceId = pinnedW3cTraceId(target);
    if (pinTraceId !== undefined) wrote = scrubStaleXrayField(target, pinTraceId) || wrote;
  }
  let wroteXray = false;
  for (const [k, v] of Object.entries(carrier)) {
    const lower = k.toLowerCase();
    if (lower === XRAY_FIELD) {
      if (plan.carrierWroteW3c || plan.pinnedConflict) continue;
      removeCarrierKey(target, k);
      wroteXray = true;
    } else if (
      lower === TRACEPARENT_KEY || lower === TRACESTATE_KEY
        ? plan.w3cPinned
        : hasCarrierKey(target, k)
    ) {
      continue;
    }
    target[k] = v;
    wrote = true;
  }
  return { wrote, wroteXray };
}

/**
 * baggage だけを載せる carrier の退避。span context を持たない carrier は即 return せず
 * 保持し、後続 carrier に実 trace context が無いときの fallback として使う
 * （SQS / SNS / SFN / Kinesis 共通の規約）。
 */
export class CarrierStash {
  private stashed: { context: Context; source: CarrierSource } | undefined;

  constructor(private readonly base: Context) {}

  /**
   * carrier から extract した `ctx` を評価する。
   * span context があれば hit として Extracted を返す（退避済み baggage は merge —
   * key 衝突は退避側が勝つ）。baggage だけなら退避に畳み込んで undefined
   * （key 衝突は先に読んだ carrier が勝つ）。
   */
  consider(ctx: Context, source: CarrierSource): Extracted | undefined {
    const spanContext = newSpanContext(this.base, ctx);
    if (spanContext !== undefined) {
      // 退避した baggage-only carrier の entry も失わないよう merge して返す。
      // baggage extractor が replace する propagator でも base の entry は残す。
      return {
        context: preserveBaseBaggage(
          this.stashed ? mergeBaggage(ctx, this.stashed.context) : ctx,
          this.base,
        ),
        source,
        spanContext,
      };
    }
    if (hasNewBaggage(this.base, ctx)) {
      this.stashed = this.stashed
        ? { context: mergeBaggage(ctx, this.stashed.context), source: this.stashed.source }
        : { context: ctx, source };
    }
    return undefined;
  }

  /** 退避した carrier の context（hit への baggage merge 用）。無ければ undefined。 */
  stashedContext(): Context | undefined {
    return this.stashed?.context;
  }

  /** 実 context を持つ carrier が無かったときの fallback（baggage のみ）。無ければ undefined。 */
  fallback(): Extracted | undefined {
    return this.stashed !== undefined
      ? {
          context: preserveBaseBaggage(this.stashed.context, this.base),
          source: this.stashed.source,
        }
      : undefined;
  }
}
