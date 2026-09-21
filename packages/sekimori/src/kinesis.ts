/** Kinesis record 向け carrier — `Data` envelope への inject / 抽出と record span。 */
import { type Context, propagation, type Span } from "@opentelemetry/api";
import {
  asRecord,
  baseContext,
  consumerSpanPlan,
  isTracingSuppressed,
  objectGetter,
  preserveBaseBaggage,
  removeW3cSpanSlots,
} from "./carriers.js";
import {
  assertConsumeOptions,
  assertInjectOptions,
  assertObject,
  assertPlainObject,
  SekimoriError,
} from "./errors.js";
import {
  CarrierStash,
  injectCarrier,
  mergeObjectCarrier,
  parseJsonObject,
  planObjectCarrier,
} from "./object-carrier.js";
import {
  ATTR_AWS_KINESIS_STREAM_NAME,
  ATTR_MESSAGING_DESTINATION_NAME,
  ATTR_MESSAGING_OPERATION_TYPE,
  ATTR_MESSAGING_SYSTEM,
  ATTR_SEKIMORI_CONTEXT_SOURCE,
  MESSAGING_OPERATION_TYPE_PROCESS,
  MESSAGING_SYSTEM_AWS_KINESIS,
} from "./semconv.js";
import { withConsumerSpan } from "./span.js";
import type { ConsumeOptions, Extracted, InjectOptions } from "./types.js";

/**
 * Kinesis にはネイティブ channel が無く、record `Data` は opaque な bytes。
 * opt-in 規約（experimental）: producer が JSON payload に W3C carrier を埋め込み、
 * consumer が base64 decode → JSON parse → carrier を読む。KPL 集約は非対応。
 */
export type KinesisPayloadLike = Record<string, unknown>;

/** `PutRecordCommandInput` と構造的に互換な最小形。`Data` は Uint8Array。 */
export interface KinesisPutRecordLike {
  Data?: Uint8Array | undefined;
}

/** Lambda に届く Kinesis record の最小形。`kinesis.data` は base64。 */
export interface KinesisRecordLike {
  eventSourceARN?: string | undefined;
  kinesis?: { data?: string | undefined; sequenceNumber?: string | undefined } | undefined;
}

/**
 * JSON payload object に W3C carrier の key を直接書く（payload envelope 規約）。
 * 利用者の key は上書きない。返した object を JSON.stringify して `Data` に入れる。
 * payload は JSON 化可能な plain object のみ — spread で返すため class instance は prototype を失う。
 */
export function injectKinesisPayload<T extends object>(
  payload: T,
  options: InjectOptions = {},
): T & KinesisPayloadLike {
  assertObject(payload, "injectKinesisPayload");
  // Map / Set / Date / class instance は spread で `{}` や enumerable field だけの
  // 複製になり、payload の内容が silent に失われるため弾く。
  assertPlainObject(payload, "injectKinesisPayload", "payload");
  assertObject(options, "injectKinesisPayload");
  assertInjectOptions(options, "injectKinesisPayload");
  const ctx = baseContext(options.context, "injectKinesisPayload");
  const out: Record<string, unknown> = { ...asRecord(payload) };
  // suppress された context では carrier を書かない（計装抑止の意図に反するため）。
  if (isTracingSuppressed(ctx)) return out as T & KinesisPayloadLike;
  // pin 判定・stale slot の scrub・既存 key の保護は object carrier 共通規約
  // （EventBridge `detail` と同じ — `mergeObjectCarrier` を参照）。
  const carrier = injectCarrier(ctx, options);
  const plan = planObjectCarrier(out, carrier, ctx, options.w3c);
  const { wroteXray } = mergeObjectCarrier(out, carrier, plan);
  // xray-only propagator で fresh な xray field を書いたのに stale な traceparent/
  // tracestate が残ると、ADOT 既定の composite（tracecontext が後勝ち）が stale な
  // W3C context を選ぶ split-brain になる（SQS と同じ方針。pin 済みの対は除く）。
  if (wroteXray && !plan.w3cPinned) removeW3cSpanSlots(out);
  return out as T & KinesisPayloadLike;
}

/** `PutRecord` / `PutRecords` の per-record `Data` 上限（1 MiB）。 */
export const KINESIS_MAX_RECORD_BYTES = 1024 * 1024;

/** `PutRecord` 入力の `Data`（JSON bytes）に carrier を埋め込む。Data が JSON object でなければ変更しない。 */
export function injectKinesisRecord<T extends KinesisPutRecordLike>(
  input: T,
  options: InjectOptions = {},
): T & KinesisPutRecordLike {
  assertObject(input, "injectKinesisRecord");
  assertObject(options, "injectKinesisRecord");
  assertInjectOptions(options, "injectKinesisRecord");
  // options.context の検証は sibling API（injectSqsMessage 等）と同じく早期 return の前に行う。
  baseContext(options.context, "injectKinesisRecord");
  // Data なし / inject される key が無い場合は Data を再 serialize しない
  // （byte が変わると checksum 系の利用者が phantom write を検出するため）。
  // `w3c: false` は W3C key の抑制であって inject 自体の抑止ではない — payload 側の
  // `injectKinesisPayload` が non-W3C field（`x-amzn-trace-id`）を残す。
  if (!input.Data) return { ...input };
  // decode（Buffer.from）と JSON parse は同じ防御境界 — Data が string/bytes として
  // decode できない、または JSON object でない入力は「carrier を埋め込めない」=
  // 変更なしで返す。Buffer.from が型の想定外の Data（number / plain object）で投げる
  // ERR_INVALID_ARG_TYPE を呼び出し側へ漏らさない。
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = parseJsonObject(Buffer.from(input.Data).toString("utf8"));
  } catch {
    return { ...input };
  }
  if (parsed === undefined) return { ...input };
  // SekimoriError（context 検証）や propagator の例外はここで飲み込まない — 上流へ投げる。
  const injected = injectKinesisPayload(parsed, options);
  const serialized = JSON.stringify(injected);
  // 内容比較 — key 数だと「stale x-amzn-trace-id を消して traceparent を足す」
  // 差し替え（数が変わらない）を no-op と誤認する。
  if (serialized === JSON.stringify(parsed)) return { ...input };
  // carrier 追加で per-record 上限（1 MiB）を超えると AWS が InvalidArgumentException
  // で拒否する — EventBridge / SFN と同じく名指しの SekimoriError で事前に止める。
  const size = Buffer.byteLength(serialized, "utf8");
  if (size > KINESIS_MAX_RECORD_BYTES) {
    throw new SekimoriError(
      `injectKinesisRecord: Data is ${size} bytes, over the Kinesis PutRecord limit of ${KINESIS_MAX_RECORD_BYTES} bytes — AWS would reject the call. Reduce the record payload.`,
    );
  }
  return { ...input, Data: new TextEncoder().encode(serialized) };
}

/**
 * Kinesis record の `kinesis.data`（base64 JSON）から W3C carrier を取り出す（experimental）。
 * payload envelope を付けて Put された record だけに効く。
 */
export function extractFromKinesisRecord(
  record: KinesisRecordLike,
  options: { context?: Context } = {},
): Extracted {
  assertObject(record, "extractFromKinesisRecord");
  assertObject(options, "extractFromKinesisRecord");
  const base = baseContext(options.context, "extractFromKinesisRecord");
  const data = record.kinesis?.data;
  // base64 decode（Buffer.from）と JSON parse は同じ防御境界 — 型の想定外の data
  // （number / plain object）で Buffer.from が投げても「carrier なし」に倒す。
  // propagator 等の例外はこの境界の外で上流へ伝播させる — extract の throw を
  // ここで飲むと `none` への silent degrade になる（`injectKinesisRecord` と同じ方針）。
  let parsed: Record<string, unknown> | undefined;
  if (data) {
    try {
      parsed = parseJsonObject(Buffer.from(data, "base64").toString("utf8"));
    } catch {
      parsed = undefined;
    }
  }
  if (parsed === undefined) return { context: base, source: "none" };

  // baggage だけを載せる carrier は即 return せず退避し、後続 carrier の実
  // trace context を優先する（SQS / SNS と同じ規約）。
  const stash = new CarrierStash(base);
  // root は inject/pin 対象 slot — embedded な `detail` が shadow しないよう
  // hit 判定は root を先に行う（detail-first だと inject した carrier や
  // root pin が embedded carrier に負ける）。`detail`（EventBridge→Kinesis の
  // event envelope — SQS の body.detail と同じ構造）の baggage は stash 経由で
  // hit に merge するため引き続き extract する。
  const rootHit = stash.consider(propagation.extract(base, parsed, objectGetter), "record-data");
  const detail = asRecord(parsed.detail);
  const detailHit =
    detail === undefined
      ? undefined
      : stash.consider(propagation.extract(base, detail, objectGetter), "body-detail");
  if (rootHit !== undefined) {
    // detail の baggage-only carrier は hit の baggage に畳み込む
    // （key 衝突は先に読んだ root が勝つ）。
    const stashed = stash.stashedContext();
    return stashed !== undefined
      ? { ...rootHit, context: preserveBaseBaggage(rootHit.context, stashed) }
      : rootHit;
  }
  if (detailHit !== undefined) return detailHit;
  return stash.fallback() ?? { context: base, source: "none" };
}

function streamNameFromArn(arn: string | undefined): string | undefined {
  if (typeof arn !== "string" || arn === "") return undefined;
  // arn:aws:kinesis:region:account:stream/name（enhanced fan-out では
  // `.../consumer/<name>:<timestamp>` が続く — 最初の path segment までに留める）
  const m = /:stream\/([^/]+)/.exec(arn);
  return m?.[1];
}

/**
 * Kinesis record 1 件を処理する CONSUMER span を開く（experimental）。
 * 親は invocation span、producer へは link。
 */
export async function withKinesisRecord<T>(
  record: KinesisRecordLike,
  fn: (span: Span) => Promise<T> | T,
  options: ConsumeOptions = {},
): Promise<T> {
  assertObject(record, "withKinesisRecord");
  assertObject(options, "withKinesisRecord");
  assertConsumeOptions(options, "withKinesisRecord");
  const base = baseContext(options.context, "withKinesisRecord");
  const extracted = extractFromKinesisRecord(record, { context: base });
  // baggage は常に union（producer mode でも base 側の entry を消さない）。
  const { parent, link } = consumerSpanPlan(base, extracted, options.parent);
  const stream = streamNameFromArn(record.eventSourceARN);
  return withConsumerSpan(
    options.name ?? `process ${stream ?? "kinesis"}`,
    {
      parent,
      link,
      attributes: {
        [ATTR_MESSAGING_SYSTEM]: MESSAGING_SYSTEM_AWS_KINESIS,
        [ATTR_MESSAGING_OPERATION_TYPE]: MESSAGING_OPERATION_TYPE_PROCESS,
        ...(stream !== undefined
          ? {
              [ATTR_AWS_KINESIS_STREAM_NAME]: stream,
              [ATTR_MESSAGING_DESTINATION_NAME]: stream,
            }
          : {}),
        [ATTR_SEKIMORI_CONTEXT_SOURCE]: extracted.source,
        ...options.attributes,
      },
    },
    fn,
  );
}
