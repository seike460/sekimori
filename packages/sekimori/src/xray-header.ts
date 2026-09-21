/** X-Ray `X-Amzn-Trace-Id` header の parse/serialize と `_X_AMZN_TRACE_ID` env の読み出し。 */
import {
  isSpanContextValid,
  isValidSpanId,
  isValidTraceId,
  type SpanContext,
  TraceFlags,
} from "@opentelemetry/api";
import { SekimoriError } from "./errors.js";

/** Lambda が invocation ごとに置く環境変数。ADOT layer はこれを invocation span の親にする。 */
export const XRAY_TRACE_ID_ENV = "_X_AMZN_TRACE_ID";
/** HTTP header 名。AWS SDK v3 の Smithy middleware（ADOT patch）が付ける。 */
export const XRAY_TRACE_ID_HEADER = "X-Amzn-Trace-Id";
/** EventBridge `TraceHeader` / SQS `AWSTraceHeader` の上限（文字）。 */
export const XRAY_TRACE_HEADER_MAX_LENGTH = 500;
/** Step Functions `traceHeader` の上限（ASCII 文字）。 */
export const SFN_TRACE_HEADER_MAX_LENGTH = 256;

const ROOT_RE = /^1-([0-9a-f]{8})-([0-9a-f]{24})$/;

/**
 * W3C SpanContext → X-Ray trace header（`Root=1-{epoch8}-{rand24};Parent={spanId};Sampled={0|1}`）。
 * W3C の 32 hex trace id は X-Ray の `epoch(8)+random(24)` と同じ長さなので変換は可逆。
 * X-Ray は 2023-10 から W3C 形式 trace id を受理するため、epoch 部が時刻でなくても拒否されない。
 */
export function formatXrayTraceHeader(spanContext: SpanContext): string {
  // invalid な SpanContext を書き出すと AWS が header を黙って捨てて trace が切れる。
  // null / 非 object も同じエラーに畳む（parse 側と対称の防御）。
  if (spanContext === null || typeof spanContext !== "object" || !isSpanContextValid(spanContext)) {
    throw new SekimoriError("formatXrayTraceHeader: expected a valid SpanContext.");
  }
  const traceId = spanContext.traceId.toLowerCase();
  const root = `1-${traceId.slice(0, 8)}-${traceId.slice(8)}`;
  const sampled = (spanContext.traceFlags & TraceFlags.SAMPLED) === TraceFlags.SAMPLED ? "1" : "0";
  return `Root=${root};Parent=${spanContext.spanId.toLowerCase()};Sampled=${sampled}`;
}

/**
 * X-Ray trace header → SpanContext（isRemote: true）。
 * `Parent` が無い / 形式が違う / 全ゼロ id は undefined（親にできないので黙って捨てず呼び出し側で "none" にする）。
 * `Sampled=?`（判断委譲）は unsampled として扱う。
 */
export function parseXrayTraceHeader(header: string | undefined | null): SpanContext | undefined {
  // 呼び出し側は record.attributes 等の型付きフィールドから渡すが、実 event は
  // 非 string が混ざり得る — 生 TypeError ではなく undefined で吸収する。
  if (typeof header !== "string" || header === "") return undefined;
  const parts = new Map<string, string>();
  for (const kv of header.split(";")) {
    const i = kv.indexOf("=");
    if (i <= 0) continue;
    parts.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
  }
  const root = parts.get("Root");
  const parent = parts.get("Parent")?.toLowerCase();
  // `Self=`（ALB 等が付ける自 node の id）は意図的に読まない — Root/Parent が無い header は
  // 上流 context を復元できないため親にはできない。
  if (!root || !parent) return undefined;
  const m = ROOT_RE.exec(root.toLowerCase());
  if (!m) return undefined;
  const traceId = `${m[1]}${m[2]}`;
  if (!isValidTraceId(traceId) || !isValidSpanId(parent)) return undefined;
  return {
    traceId,
    spanId: parent,
    traceFlags: parts.get("Sampled") === "1" ? TraceFlags.SAMPLED : TraceFlags.NONE,
    isRemote: true,
  };
}
