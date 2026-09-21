/** Step Functions consumer 側 — state input からの context 抽出と CONSUMER span。 */
import { type Context, propagation, type Span } from "@opentelemetry/api";
import {
  asRecord,
  baseContext,
  consumerSpanPlan,
  objectGetter,
  preserveBaseBaggage,
} from "./carriers.js";
import { assertConsumeOptions, assertObject, SekimoriError } from "./errors.js";
import { CarrierStash } from "./object-carrier.js";
import {
  ATTR_AWS_SFN_STATE_MACHINE_ARN,
  ATTR_MESSAGING_OPERATION_TYPE,
  ATTR_MESSAGING_SYSTEM,
  ATTR_SEKIMORI_CONTEXT_SOURCE,
  MESSAGING_OPERATION_TYPE_PROCESS,
  MESSAGING_SYSTEM_AWS_SFN,
} from "./semconv.js";
import { SFN_TRACE_FIELD } from "./sfn-inject.js";
import { withConsumerSpan } from "./span.js";
import type { CarrierSource, ConsumeOptions, Extracted } from "./types.js";

/**
 * SFN task から Lambda に届く event の最小形（state input そのもの）。
 * state input は任意の JSON 値（scalar / array / null も有効）なので、公開 API は
 * `unknown` 受け。carrier を持ち得るのは JSON object のときだけ — この形はその時のドキュメント。
 */
export interface StateInputLike {
  _trace?: unknown;
  [key: string]: unknown;
}

/**
 * SFN task 経由で Lambda に届いた event の `_trace` から producer context を取り出す。
 * `_trace` が `{ traceparent: ... }` の object であれば読む（`source: "state-input"`）。
 * 見つからなければ event 直下の W3C key も見る（task の ResultSelector で flatten された
 * ケース。`source: "state-input-flattened"` で区別する）。それでも見つからなければ
 * `detail`（EventBridge→SFN envelope。`source: "body-detail"`）を読む — embedded slot は
 * inject/pin 対象の `_trace`・root を shadow しないよう最後に評価する。
 */
export function extractFromStateInput(
  event: unknown,
  options: { context?: Context } = {},
): Extracted {
  assertObject(options, "extractFromStateInput");
  const base = baseContext(options.context, "extractFromStateInput");
  // state input が object でない（scalar / array / null）場合は carrier を持ち得ない — none。
  // 他の record 系 API と違い、非 object は呼び出し側の bug ではなく有効な入力なので throw しない。
  const record = asRecord(event);
  if (record === undefined) {
    return { context: base, source: "none" };
  }
  // baggage だけを載せる carrier は即 return せず退避し、後続 carrier の実 trace context を
  // 優先する（CarrierStash 規約 — SQS と同じ）。
  const stash = new CarrierStash(base);
  const consider = (ctx: Context, source: CarrierSource): Extracted | undefined =>
    stash.consider(ctx, source);

  // `_trace`（inject slot）と root（flattened slot）は pin/inject 対象 — embedded な
  // `detail`（EventBridge→StartExecution の event envelope — SQS の body.detail と
  // 同じ構造）がこれらを shadow しないよう hit 判定を先に行い、detail は最後に
  // 評価する。detail の baggage は stash 経由で hit に merge される。
  const field = asRecord(record[SFN_TRACE_FIELD]);
  const fieldHit =
    field === undefined
      ? undefined
      : consider(propagation.extract(base, field, objectGetter), "state-input");

  // `_trace` が無い場合は event 直下も見る（task の ResultSelector で flatten されたケース）。
  const rootHit = consider(
    propagation.extract(base, record, objectGetter),
    "state-input-flattened",
  );

  const detail = asRecord(record.detail);
  const detailHit =
    detail === undefined
      ? undefined
      : consider(propagation.extract(base, detail, objectGetter), "body-detail");

  const hit = fieldHit ?? rootHit;
  if (hit !== undefined) {
    // 後続 slot の baggage-only carrier は hit の baggage に畳み込む
    // （key 衝突は先に読んだ slot が勝つ）。
    const stashedCtx = stash.stashedContext();
    return stashedCtx !== undefined
      ? { ...hit, context: preserveBaseBaggage(hit.context, stashedCtx) }
      : hit;
  }
  if (detailHit !== undefined) return detailHit;
  return stash.fallback() ?? { context: base, source: "none" };
}

/**
 * SFN task として呼ばれた Lambda で CONSUMER span を開く。
 * 親は invocation span、`input._trace` の producer へ link（DEC-002 と同じ既定）。
 */
export async function withStepFunctionsTask<T>(
  event: unknown,
  fn: (span: Span) => Promise<T> | T,
  options: ConsumeOptions & { stateMachineArn?: string } = {},
): Promise<T> {
  assertObject(options, "withStepFunctionsTask");
  assertConsumeOptions(options, "withStepFunctionsTask");
  if (
    options.stateMachineArn !== undefined &&
    (typeof options.stateMachineArn !== "string" || options.stateMachineArn === "")
  ) {
    throw new SekimoriError(
      "withStepFunctionsTask: options.stateMachineArn must be a non-empty string.",
    );
  }
  const base = baseContext(options.context, "withStepFunctionsTask");
  const extracted = extractFromStateInput(event, { context: base });
  // baggage は常に union（producer mode でも base 側の entry を消さない）。
  const { parent, link } = consumerSpanPlan(base, extracted, options.parent);
  return withConsumerSpan(
    options.name ?? "process stepfunctions-task",
    {
      parent,
      link,
      attributes: {
        [ATTR_MESSAGING_SYSTEM]: MESSAGING_SYSTEM_AWS_SFN,
        [ATTR_MESSAGING_OPERATION_TYPE]: MESSAGING_OPERATION_TYPE_PROCESS,
        ...(options.stateMachineArn !== undefined
          ? { [ATTR_AWS_SFN_STATE_MACHINE_ARN]: options.stateMachineArn }
          : {}),
        [ATTR_SEKIMORI_CONTEXT_SOURCE]: extracted.source,
        ...options.attributes,
      },
    },
    fn,
  );
}
