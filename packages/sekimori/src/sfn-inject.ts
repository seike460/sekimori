/** Step Functions producer 側 — StartExecution への trace context 注入。 */
import { isSpanContextValid, propagation, trace } from "@opentelemetry/api";
import {
  asRecord,
  baseContext,
  carrierHasW3c,
  hasCarrierKey,
  isTracingSuppressed,
  pinnedW3cTraceConflicts,
  pinnedW3cTraceId,
  removeCarrierKey,
  removeW3cSpanSlots,
  scrubStaleXrayField,
  stripW3cCarrierKeys,
  TRACEPARENT_KEY,
  TRACESTATE_KEY,
  w3cSpanPairPinned,
  XRAY_FIELD,
} from "./carriers.js";
import { assertInjectOptions, assertObject, SekimoriError } from "./errors.js";
import type { InjectOptions } from "./types.js";
import { formatXrayTraceHeader } from "./xray-header.js";

/** state input の JSON に載せる W3C carrier の key。衝突しにくいよう `_` 始まりにする。 */
export const SFN_TRACE_FIELD = "_trace";

/** StartExecution の `input` の上限（256 KiB）。carrier 追加で超過する前に止める。 */
export const SFN_MAX_INPUT_BYTES = 256 * 1024;

/** `StartExecutionCommandInput` と構造的に互換な最小形。 */
export interface StartExecutionLike {
  input?: string | undefined;
  traceHeader?: string | undefined;
}

/**
 * `StartExecutionCommand` の入力に trace context を載せる。
 * - `traceHeader`（X-Ray 形式・≤256 ASCII）: Step Functions のネイティブ channel。
 * - `input` JSON の `_trace` に W3C `traceparent` / `tracestate` / `baggage`: task から
 *   Lambda まで state として届く。input が JSON object でない場合は `_trace` を書かず input を変更しない。
 */
export function injectStartExecution<T extends StartExecutionLike>(
  input: T,
  options: InjectOptions = {},
): T & StartExecutionLike {
  assertObject(input, "injectStartExecution");
  assertObject(options, "injectStartExecution");
  assertInjectOptions(options, "injectStartExecution");
  const ctx = baseContext(options.context, "injectStartExecution");
  const spanContext = trace.getSpanContext(ctx);
  const out: T & StartExecutionLike = { ...input };

  // suppress された context では native header も書かない（suppression は計装そのものを
  // 止める合図 — SQS の AWSTraceHeader と同じ方針）。
  const suppressed = isTracingSuppressed(ctx);
  // input を先に parse する — `_trace` の pin 判定が traceHeader の書き込み可否を
  // 左右するため。parse 失敗（input が JSON でない）だけを飲み込み、propagator 等の
  // 例外は上流へ伝播させる — inject 内の throw を飲むと `_trace` だけが silent に
  // 欠落する部分的失敗になる（`injectKinesisRecord` と同じ方針）。
  let inputRecord: Record<string, unknown> | undefined;
  if (out.input !== undefined && !suppressed) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(out.input);
    } catch {
      // input が JSON でなければ carrier merge 対象なし（呼び出し側の input を壊さない）。
      parsed = undefined;
    }
    inputRecord = asRecord(parsed);
  }
  const traceTarget = asRecord(inputRecord?.[SFN_TRACE_FIELD]);
  // pin 判定は `_trace`（carrier slot）と input 直下の両方で行う。input 直下は
  // `state-input-flattened`（ResultSelector 等で flatten された carrier）の slot で
  // extract 側も読む — root pin を無視して `_trace` に fresh な context を書くと、
  // extract が `_trace` を先に読むため caller の pin が shadow される。
  const w3cPinned =
    options.w3c !== false &&
    ((traceTarget !== undefined && w3cSpanPairPinned(traceTarget)) ||
      (inputRecord !== undefined && w3cSpanPairPinned(inputRecord)));
  // pin された traceparent が active span と別 trace を指す場合、native channel
  // （traceHeader）や `x-amzn-trace-id` field に fresh な trace を書くと、pin を読む側と
  // X-Ray channel を読む側で trace が分かれる — そのときは X-Ray slot の書き込みを
  // 抑止して pin 側に揃える。衝突元は slot ごとに追う — root pin 衝突時は `_trace`
  // 内の stale な xray field が extract で root pin を shadow するため消す対象に
  // なり、`_trace` 自身の pin 衝突では逆に pin に合致し得る既存値を残す。
  const activeSpan =
    options.w3c !== false && spanContext !== undefined && isSpanContextValid(spanContext)
      ? spanContext
      : undefined;
  const traceTargetConflict =
    activeSpan !== undefined &&
    traceTarget !== undefined &&
    pinnedW3cTraceConflicts(traceTarget, activeSpan);
  const rootConflict =
    activeSpan !== undefined &&
    inputRecord !== undefined &&
    pinnedW3cTraceConflicts(inputRecord, activeSpan);
  const pinnedConflict = traceTargetConflict || rootConflict;
  // `traceHeader` は task の input に含まれず、AWS 側の execution X-Ray view に
  // しか効かない — caller が別 trace を pin しても consumer 側の split-brain に
  // はならないため、carrier 抑止の対象にはしない（pin は保持する）。
  const wroteTraceHeader =
    options.xrayHeader !== false &&
    !suppressed &&
    !pinnedConflict &&
    spanContext !== undefined &&
    isSpanContextValid(spanContext) &&
    !out.traceHeader;
  if (wroteTraceHeader) {
    // formatXrayTraceHeader の出力は固定長（73 文字）で SFN の 256 文字上限を常に下回る。
    out.traceHeader = formatXrayTraceHeader(spanContext);
  }

  if (inputRecord !== undefined) {
    const record = inputRecord;
    const existing = record[SFN_TRACE_FIELD];
    // `w3c: false` は W3C key を書かないという意味 — inject 自体は行い、
    // `x-amzn-trace-id` 等の non-W3C field は残す（xray-only propagator で
    // context が全喪失するのを防ぐ）。
    const carrier: Record<string, string> = {};
    propagation.inject(ctx, carrier);
    if (options.w3c === false) stripW3cCarrierKeys(carrier);
    const carrierWroteW3c = carrierHasW3c(carrier);
    const traceField: Record<string, string> = {};
    for (const [k, v] of Object.entries(carrier)) {
      // `x-amzn-trace-id` は `traceHeader`（native channel）が担う — ただし
      // W3C context が無い xray-only propagator では唯一の context なので残す。
      if (k.toLowerCase() === XRAY_FIELD && carrierWroteW3c) continue;
      traceField[k] = v;
    }
    // `_trace` が plain object なら既存の非 carrier key を保って carrier を merge する
    // （EventBridge の detail と同じ key-level の扱い）。undefined / null は「未設定」
    // なので新規に置く。primitive / array は extract 側も carrier として読まないため
    // 上書きせず書き込まない。
    let carrierWroteXray = false;
    if (existing === undefined || existing === null) {
      // input 直下に pin があるときは `_trace` 新設でも W3C span pair を書かない
      // （extract が `_trace` を先に読み root pin が shadow されるため）。pin 衝突時は
      // `x-amzn-trace-id` も書かない — `_trace` 内で split-brain になる。
      if (w3cPinned) removeW3cSpanSlots(traceField);
      if (pinnedConflict) removeCarrierKey(traceField, XRAY_FIELD);
      carrierWroteXray = hasCarrierKey(traceField, XRAY_FIELD);
      if (Object.keys(traceField).length > 0) {
        record[SFN_TRACE_FIELD] = traceField;
        out.input = JSON.stringify(record);
      }
    } else {
      const target = asRecord(existing);
      // primitive / array の `_trace` は extract 側も carrier として読まない — 上書きしない。
      if (target !== undefined) {
        // `x-amzn-trace-id` は伝播 slot — fresh な traceparent と古い hop の値が
        // 同居すると xray を優先する読み手（xray-only propagator / xray-last 構成）が
        // stale context を選ぶため消す。`tracestate` も対の slot なので同様に扱う。
        let changed = false;
        if (carrierWroteW3c) {
          // pin 衝突時は carrier の fresh traceparent は pin に負けて書かれない —
          // caller の x-amzn-trace-id（pin に合致し得る）を残す。pin 側の照合は
          // carrierWroteW3c の有無に関わらず後段で行う。
          if (!pinnedConflict) {
            changed = removeCarrierKey(target, XRAY_FIELD) || changed;
          }
          if (!w3cPinned && !hasCarrierKey(carrier, TRACESTATE_KEY)) {
            changed = removeCarrierKey(target, TRACESTATE_KEY) || changed;
          }
        }
        // pin 衝突時、`_trace` の stale な `x-amzn-trace-id` は extract で pin を
        // shadow する — `_trace` pin 側は pin の trace と照合して別 trace なら消し、
        // root pin 側は別 slot の pin を shadow し得るため無条件で消す
        // （xray-only propagator で carrier が W3C を書かない構成でも同じ）。
        if (traceTargetConflict) {
          const pinTraceId = pinnedW3cTraceId(target);
          if (pinTraceId !== undefined) {
            changed = scrubStaleXrayField(target, pinTraceId) || changed;
          }
        } else if (rootConflict) {
          changed = removeCarrierKey(target, XRAY_FIELD) || changed;
        }
        for (const [k, v] of Object.entries(traceField)) {
          // xray-only では x-amzn-trace-id が唯一の context — 同じ slot として上書きする。
          const lower = k.toLowerCase();
          if (lower === XRAY_FIELD) {
            // pin された W3C と別 trace の xray 値で caller の slot を上書きすると
            // _trace 内で split-brain になる — pin に合致する既存値を残す。
            if (pinnedConflict) continue;
            removeCarrierKey(target, k);
            target[k] = v;
            changed = true;
            carrierWroteXray = true;
          } else if (
            lower === TRACEPARENT_KEY || lower === TRACESTATE_KEY
              ? w3cPinned
              : hasCarrierKey(target, k)
          ) {
          } else {
            target[k] = v;
            changed = true;
          }
        }
        // fresh な xray context（traceHeader または xray-only の carrier field）を
        // 書いたのに stale な traceparent/tracestate が残ると、ADOT 既定の composite
        // （`baggage,xray,tracecontext` — tracecontext が後勝ち）が stale な W3C
        // context を選ぶ split-brain になる（pin 済みの対は除く）。
        if ((wroteTraceHeader || carrierWroteXray) && !carrierWroteW3c && !w3cPinned) {
          changed = removeW3cSpanSlots(target) || changed;
        }
        // fresh な traceHeader を書いたのに入力由来の `x-amzn-trace-id` が _trace に
        // 残ると、extract が _trace を読む経路で stale context が勝つ（EventBridge の
        // detail と同じ問題。carrier が今回 fresh 値を書いた場合は消さない）。
        if (wroteTraceHeader && !carrierWroteXray) {
          changed = removeCarrierKey(target, XRAY_FIELD) || changed;
        }
        if (changed) out.input = JSON.stringify(record);
      }
    }
    // stale slot の規約は `_trace` と同じく input 直下（state-input-flattened slot）にも
    // 適用する — `_trace` が hit しない場合 extract は root を読むため。root の W3C key は
    // 通常 mode では pin として保護されるが、`w3c: false` では pin 判定が無効化されるため
    // 入力由来の W3C slot もここで stale として消える（他の carrier slot と同じ規約）。
    if (!w3cPinned && (wroteTraceHeader || carrierWroteXray) && !carrierWroteW3c) {
      if (removeW3cSpanSlots(record)) out.input = JSON.stringify(record);
    }
    if (wroteTraceHeader && !carrierWroteXray) {
      if (removeCarrierKey(record, XRAY_FIELD)) out.input = JSON.stringify(record);
    }
    // root pin 衝突時、root 直下の stale な `x-amzn-trace-id` は xray を優先する
    // 読み手に pin より先に拾われる — pin の trace に照合して消す。
    if (rootConflict) {
      const pinTraceId = pinnedW3cTraceId(record);
      if (pinTraceId !== undefined && scrubStaleXrayField(record, pinTraceId)) {
        out.input = JSON.stringify(record);
      }
    }
  }
  // StartExecution の input 上限は 256 KiB — carrier 追加で限界を超えた input は
  // AWS が拒否する。input を持たない呼び出し（ traceHeader のみ）は対象外。
  if (typeof out.input === "string" && Buffer.byteLength(out.input, "utf8") > SFN_MAX_INPUT_BYTES) {
    throw new SekimoriError(
      `injectStartExecution: input is over the Step Functions limit of ${SFN_MAX_INPUT_BYTES} bytes — AWS would reject StartExecution. Reduce the state input payload.`,
    );
  }
  return out;
}
