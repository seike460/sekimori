/** SQS producer 側 — SendMessage(Batch) への trace context 注入。 */
import { isSpanContextValid, propagation, trace } from "@opentelemetry/api";
import {
  baseContext,
  carrierHasW3c,
  globalPropagatorHasXray,
  isTracingSuppressed,
  mergeSdkAttributesCarrier,
  removeCarrierKey,
  removeW3cSpanSlots,
  type SdkMessageAttributes,
  type SdkMessageAttributeValue,
  sdkPinnedW3cTraceId,
  stripW3cCarrierKeys,
  w3cPinPlan,
  XRAY_FIELD,
} from "./carriers.js";
import { assertAttributeMap, assertInjectOptions, assertObject, SekimoriError } from "./errors.js";
import type { InjectOptions } from "./types.js";
import { formatXrayTraceHeader, parseXrayTraceHeader } from "./xray-header.js";

/** SQS が 1 message に許す message attribute 数。 */
export const SQS_MAX_MESSAGE_ATTRIBUTES = 10;

/** `SendMessageCommandInput` / `SendMessageBatchRequestEntry` と構造的に互換な最小形。 */
export interface SqsSendMessageLike {
  MessageAttributes?: SdkMessageAttributes | undefined;
  MessageSystemAttributes?: Record<string, SdkMessageAttributeValue> | undefined;
}

/**
 * SendMessage(Batch) の入力に trace context を載せる。
 * - `MessageAttributes` に W3C `traceparent` / `tracestate` / `baggage`（消費する属性枠は最大 3）。
 * - X-Ray field は attribute に書かず、`MessageSystemAttributes.AWSTraceHeader`（quota 外）に書く。
 *   既定 `"auto"` はグローバル propagator に X-Ray propagator が無いとき、または `w3c: false` で
 *   carrier が抑制されるときに書く（ADOT layer 下で carrier を書く場合は Smithy middleware の
 *   HTTP header から SQS が自動で付けるため二重にしない）。
 *   ただし propagator が inject した `x-amzn-trace-id` は W3C context が無い xray-only
 *   構成では唯一の context なので attribute に残す。
 * 属性が 10 を超える入力は SekimoriError（SQS が拒否する前に、ここで名指しして止める）。
 */
export function injectSqsMessage<T extends SqsSendMessageLike>(
  input: T,
  options: InjectOptions = {},
): T & SqsSendMessageLike {
  assertObject(input, "injectSqsMessage");
  assertObject(options, "injectSqsMessage");
  assertInjectOptions(options, "injectSqsMessage");
  // 非 object / array / Map の attribute map は spread でゴミ key か `{}` になるため弾く。
  assertAttributeMap(input.MessageAttributes, "injectSqsMessage", "MessageAttributes");
  assertAttributeMap(input.MessageSystemAttributes, "injectSqsMessage", "MessageSystemAttributes");
  const ctx = baseContext(options.context, "injectSqsMessage");
  const spanContext = trace.getSpanContext(ctx);
  const attributes: SdkMessageAttributes = { ...(input.MessageAttributes ?? {}) };

  // propagator が今回の呼び出しで fresh な `x-amzn-trace-id` を attribute に書いたか
  // （stale 判定と区別する — DEC-006 の xray-only 保持を壊さないため）。
  let carrierWroteXray = false;
  let carrierWroteW3c = false;
  // 呼び出し側が pin した `traceparent`/`tracestate` — 対の slot なので片方でも
  // 既存なら carrier 側の両方を書かず、pin された対を scrub もしない。
  // ただし `w3c: false` は「W3C を載せない」明示指定 — その指定の下では入力由来の
  // W3C slot も stale 扱いにして scrub 対象にする（残すと ADOT が fresh な
  // AWSTraceHeader より stale traceparent を選ぶ split-brain に戻る）。
  // pin 済みの W3C pair が active span と別 trace なら pinnedConflict=true — fresh な
  // trace を native channel（AWSTraceHeader）や `x-amzn-trace-id` field に書くと
  // pin を読む側と X-Ray channel を読む側で trace が分かれるため、X-Ray slot の
  // 書き込みを抑止して pin 側に揃える。
  const { w3cPinned, pinnedConflict } = w3cPinPlan(attributes, spanContext, options.w3c !== false);
  const existingXray = input.MessageSystemAttributes?.AWSTraceHeader;
  const keepExistingXray =
    typeof existingXray?.StringValue === "string" && existingXray.StringValue !== "";
  // caller が native slot（AWSTraceHeader）に active span と別 trace の valid な
  // X-Ray header を pin した場合、fresh な W3C carrier を書くと extract は W3C
  // （fresh trace）を読み AWS 側の X-Ray view は pin（別 trace）を見る逆向きの
  // split-brain になる。AWSTraceHeader は record の attributes に配信されるため、
  // consumer は最終 fallback で pin に揃う — carrier の span context 書き込みを
  // 抑止して pin 側に揃える（baggage は trace 非依存なので書く）。
  const pinnedXrayContext = keepExistingXray
    ? parseXrayTraceHeader(existingXray.StringValue)
    : undefined;
  const xrayPinConflict =
    pinnedXrayContext !== undefined &&
    spanContext !== undefined &&
    isSpanContextValid(spanContext) &&
    pinnedXrayContext.traceId !== spanContext.traceId;
  const anyPinConflict = pinnedConflict || xrayPinConflict;
  const suppressed = isTracingSuppressed(ctx);
  if (!suppressed) {
    // 呼び出し側が置いた key は上書きしない（case-insensitive）。inject 先の attribute map を
    // 直接書き換えず temp carrier 経由にするのは、この保護を carrier 種別に関わらず
    // 一貫させるため（EventBridge detail / Kinesis payload と同じ方針）。
    // `w3c: false` は W3C key を書かないという意味 — inject 自体は行い、
    // `x-amzn-trace-id` 等の non-W3C field は残す（xray-only propagator で
    // context が全喪失するのを防ぐ）。
    const carrier: Record<string, string> = {};
    propagation.inject(ctx, carrier);
    if (options.w3c === false) stripW3cCarrierKeys(carrier);
    carrierWroteW3c = carrierHasW3c(carrier);
    // pin（W3C pair または native AWSTraceHeader）が authoritative なのに、pin と
    // 別 trace の stale な `x-amzn-trace-id` attribute が残ると、xray を優先する
    // 読み手（xray-only propagator / xray-last 構成）が pin に勝つ — pin に揃える
    // ため scrub の基準 trace id を pin 側から取る。consumer が実際に読む pin
    // （messageAttributes の valid traceparent → native AWSTraceHeader の順）に
    // 照合し、pin と同じ trace や読めない値（extractor も読めない = 無害）は残す。
    // `w3c: false` では attributes の traceparent は stale 扱い（後段で scrub）なので
    // pin 基準から外し、consumer が読む native pin に揃える。native pin は active span
    // と一致していても consumer-visible（record.attributes に配信される）なので、
    // 衝突の有無に関わらず valid pin があれば pin 基準で scrub する。
    const pinTraceId =
      anyPinConflict || pinnedXrayContext !== undefined
        ? ((options.w3c !== false ? sdkPinnedW3cTraceId(attributes) : undefined) ??
          pinnedXrayContext?.traceId)
        : undefined;
    // merge 規約（pin 保護・stale slot の除去・既存 key の保持）は SQS/SNS 共通 —
    // carriers.js の mergeSdkAttributesCarrier が正本。native pin 衝突時は W3C slot の
    // 書き込みも抑止する（fresh な W3C carrier が pin に勝つ逆向き split-brain を防ぐ）。
    carrierWroteXray = mergeSdkAttributesCarrier(attributes, carrier, {
      carrierWroteW3c,
      w3cSlotsPinned: w3cPinned || xrayPinConflict,
      xrayConflict: anyPinConflict,
      pinTraceId,
    }).wroteXray;
  }
  const wantXray =
    options.xrayHeader === true ||
    (options.xrayHeader !== false && (options.w3c === false || !globalPropagatorHasXray()));
  // tracing が suppress された context では native header も書かない
  // （suppression は計装そのものを止める合図 — carrier field だけでなく
  // AWSTraceHeader も抑止しないと suppress の意図に反する）。
  const writeXray =
    wantXray &&
    !suppressed &&
    !keepExistingXray &&
    !anyPinConflict &&
    spanContext !== undefined &&
    isSpanContextValid(spanContext);
  // fresh な xray context（carrier field または AWSTraceHeader）を書いたのに入力由来の
  // `traceparent`/`tracestate` が残ると、ADOT 既定の composite（`baggage,xray,tracecontext` —
  // tracecontext が最後に extract され勝つ）が stale な W3C context を選ぶ split-brain になる。
  // native pin 衝突で fresh 書き込みを抑止した場合も同じ — `w3c: false` の下では
  // 入力由来の W3C slot は stale 扱いなので、pin に揃えるためここで消す
  // （suppression 時は inject 全体が no-op なので scrub も走らせない）。pin は
  // active span と一致していても consumer-visible — 一致 pin でも同様に消す。
  if (
    (carrierWroteXray || writeXray || (options.w3c === false && pinnedXrayContext !== undefined)) &&
    !suppressed &&
    !carrierWroteW3c &&
    !w3cPinned
  ) {
    removeW3cSpanSlots(attributes);
  }
  // fresh な AWSTraceHeader を書くのに入力由来の `x-amzn-trace-id` が残っていると、
  // extract が messageAttributes を先に読むため stale context が勝つ split-brain になる。
  // `w3c: false` でも fresh context を書く以上は同じ — carrier が今回 fresh 値を書いた
  // 場合（xray-only propagator）はその値が生きているので消さない。
  if (writeXray && !carrierWroteXray) removeCarrierKey(attributes, XRAY_FIELD);
  const count = Object.keys(attributes).length;
  if (count > SQS_MAX_MESSAGE_ATTRIBUTES) {
    throw new SekimoriError(
      `SQS allows at most ${SQS_MAX_MESSAGE_ATTRIBUTES} message attributes but the message would carry ${count}. ` +
        "Move application data into the body, or pass { w3c: false } and rely on AWSTraceHeader.",
    );
  }

  // 書く attribute が無く入力側にも無ければ MessageAttributes を付けない
  // （EventBridge の wrote flag / Kinesis の byte-identity と同じ方針 — phantom field を避ける）。
  const out: T & SqsSendMessageLike =
    count > 0 || input.MessageAttributes !== undefined
      ? { ...input, MessageAttributes: attributes }
      : { ...input };
  if (writeXray) {
    out.MessageSystemAttributes = {
      ...(input.MessageSystemAttributes ?? {}),
      // 呼び出し側が既に AWSTraceHeader を指定している場合は上書きしない
      // （EventBridge `TraceHeader` / SFN `traceHeader` と同じ方針）。ただし
      // StringValue の無い / 空の attribute は AWS が拒否するので有効値とは数えない。
      AWSTraceHeader: keepExistingXray
        ? existingXray
        : {
            DataType: "String",
            StringValue: formatXrayTraceHeader(spanContext),
          },
    };
  }
  return out;
}
