/** `captureMethod` — 関数呼び出しを INTERNAL span で包み、thenable は settle まで追跡する。 */
import {
  type Context,
  context as otelContext,
  type Span,
  SpanStatusCode,
  type Tracer,
} from "@opentelemetry/api";
import { isTracingSuppressed } from "./carriers.js";
import { diagWarn } from "./diag.js";
import { exceptionMessage, toException } from "./errors.js";

/** `span.end()` の失敗（custom Span 実装等）で呼び出し結果・元の error を隠さない。 */
function endQuietly(span: Span): void {
  try {
    span.end();
  } catch (error) {
    // 呼び出し側の結果を守るため throw はしないが、diag（OTel の診断チャネル）には残す。
    diagWarn("sekimori: span.end() failed", error);
  }
}

/**
 * native Promise 以外の thenable（独自 promise・cross-realm）も非同期として扱うため、
 * `then` を構造的に検査する。`in` ではなく `Reflect.get` で読む — `get` trap で
 * `then` を供給する Proxy 製 thenable は `has` trap が true を返さないため、
 * `in` 判定では同期値に誤判定されて span が settle 前に閉じる。
 * getter が throw した場合は呼び出し側の catch で failSpan に落ちる。
 */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  return typeof Reflect.get(value, "then") === "function";
}

/** span 内で error を記録し、記録自体の失敗や end の失敗で元の error を隠さず再送出する。 */
function failSpan(span: Span, error: unknown): never {
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
  } finally {
    // recordException / setStatus が投げても span を leak させない。
    endQuietly(span);
  }
  throw error;
}

/** thenable な戻り値を settle まで追跡し、resolve で閉じ / reject で記録して再送出する。 */
function settleAsync<R>(span: Span, result: PromiseLike<unknown>): PromiseLike<R> {
  return Promise.resolve(result).then(
    (value) => {
      endQuietly(span);
      return value as R;
    },
    (error: unknown) => failSpan(span, error),
  );
}

/**
 * `fn` を `name` の INTERNAL span で包む。戻り値が thenable なら settle まで span を
 * 開いたままにし、reject 時は exception を記録してから再送出する。
 */
export function captureMethod<A extends unknown[], R>(
  otelTracer: Tracer,
  name: string,
  fn: (...args: A) => R,
): (...args: A) => R {
  // `this` を引き回すため arrow ではなく function で返す
  // （`captureMethod("x", obj.method)` や class method 直渡しで receiver を失わない）。
  return function (this: unknown, ...args: A): R {
    const ctx: Context = otelContext.active();
    // suppressTracing された context では span を開かない — withConsumerSpan / inject
    // 側の抑止と対称（upstream が抑制した scope で span が漏れない）。
    if (isTracingSuppressed(ctx)) return fn.apply(this, args);
    return otelTracer.startActiveSpan(name, {}, ctx, (span) => {
      try {
        const result = fn.apply(this, args);
        if (isThenable(result)) return settleAsync(span, result) as R;
        endQuietly(span);
        return result;
      } catch (error) {
        return failSpan(span, error);
      }
    });
  };
}
