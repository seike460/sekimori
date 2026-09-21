/** `withConsumerSpan` — 抽出済み context を parent/link に据えて CONSUMER span を開く共有ヘルパー。 */
import {
  type Attributes,
  type Context,
  INVALID_SPAN_CONTEXT,
  isSpanContextValid,
  type Link,
  context as otelContext,
  type Span,
  type SpanContext,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { isTracingSuppressed } from "./carriers.js";
import { diagWarn } from "./diag.js";
import {
  assertAttributes,
  assertObject,
  exceptionMessage,
  SekimoriError,
  toException,
} from "./errors.js";
import { TRACER_NAME } from "./semconv.js";

export interface ConsumerSpanOptions {
  /** 親にする context。 */
  readonly parent: Context;
  /** producer 側 SpanContext。親と同一なら link は付けない。 */
  readonly link?: SpanContext | undefined;
  readonly attributes?: Attributes | undefined;
  /** span kind。既定は CONSUMER。HTTP 境界は SERVER を渡す。 */
  readonly kind?: SpanKind | undefined;
}

function sameSpan(a: SpanContext | undefined, b: SpanContext): boolean {
  return a !== undefined && a.traceId === b.traceId && a.spanId === b.spanId;
}

/**
 * CONSUMER span を開き、fn を実行し、例外を記録して必ず end する。
 * DEC-002: 親 = 呼び出し側が渡した context、producer へは span link。
 */
export async function withConsumerSpan<T>(
  name: string,
  options: ConsumerSpanOptions,
  fn: (span: Span) => Promise<T> | T,
): Promise<T> {
  assertObject(options, "withConsumerSpan");
  // `name` は span 名 — 非 string / 空文字は SDK が silent に保持するため弾く。
  if (typeof name !== "string" || name === "") {
    throw new SekimoriError("withConsumerSpan: name must be a non-empty string.");
  }
  const kind: unknown = options.kind;
  if (kind !== undefined && (typeof kind !== "number" || !(kind in SpanKind))) {
    throw new SekimoriError("withConsumerSpan: options.kind must be a SpanKind enum value.");
  }
  assertAttributes(options.attributes, "withConsumerSpan");
  // `parent` は必須の Context — null / `{}` / undefined をそのまま propagator・
  // trace.getSpanContext に渡すと raw TypeError になるためここで弾く。
  const parent = options.parent;
  if (
    parent === null ||
    parent === undefined ||
    typeof parent !== "object" ||
    typeof parent.getValue !== "function" ||
    typeof parent.setValue !== "function" ||
    typeof parent.deleteValue !== "function"
  ) {
    throw new SekimoriError("withConsumerSpan: options.parent must be an OpenTelemetry Context.");
  }
  if (typeof fn !== "function") {
    throw new SekimoriError("withConsumerSpan: expected a function argument.");
  }
  // suppressTracing された context では span を開かない — inject 側の抑止と対称にし、
  // 上流 instrumentation が抑制した scope で consumer span だけが生えるのを防ぐ。
  // fn は NonRecordingSpan（API は全て no-op）を渡し、normal path と同じく
  // `options.parent`（+ その span）を active にして実行する — ambient context の
  // ままだと fn 内の getActiveSpan / nested inject が抑制されない ambient を見る。
  if (isTracingSuppressed(options.parent)) {
    const span = trace.wrapSpanContext(INVALID_SPAN_CONTEXT);
    return otelContext.with(trace.setSpan(options.parent, span), () => fn(span));
  }
  const links: Link[] = [];
  const parentSpanContext = trace.getSpanContext(options.parent);
  if (
    options.link &&
    isSpanContextValid(options.link) &&
    !sameSpan(parentSpanContext, options.link)
  ) {
    links.push({ context: options.link });
  }
  const tracer = trace.getTracer(TRACER_NAME);
  return tracer.startActiveSpan(
    name,
    {
      kind: options.kind ?? SpanKind.CONSUMER,
      links,
      attributes: options.attributes ?? {},
    },
    options.parent,
    async (span) => {
      try {
        return await fn(span);
      } catch (error) {
        try {
          // Exception は string | Error | {code,name,message,stack} — 構造を満たす
          // object はそのまま渡し、それ以外は文字列化して記録する（String() に潰すと
          // name/message/stack が "[object Object]" で失われる）。
          const exception = toException(error);
          span.recordException(exception);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: exceptionMessage(exception, error),
          });
        } catch (recordError) {
          // 記録の失敗（custom Span 実装等）で元の error を隠さない。
          diagWarn("sekimori: failed to record span error", recordError);
        }
        throw error;
      } finally {
        try {
          span.end();
        } catch (endError) {
          // end の失敗でも元の結果・error を隠さない。
          diagWarn("sekimori: span.end() failed", endError);
        }
      }
    },
  );
}
