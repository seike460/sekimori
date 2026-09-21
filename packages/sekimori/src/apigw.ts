/** API Gateway HTTP event 向け carrier — header の inject / 抽出と CONSUMER span。 */
import { type Context, propagation, type Span, SpanKind, trace } from "@opentelemetry/api";
import {
  BAGGAGE_KEY,
  baseContext,
  hasNewBaggage,
  mergeBaggage,
  newSpanContext,
  objectGetter,
  preserveBaseBaggage,
  TRACESTATE_KEY,
} from "./carriers.js";
import { assertConsumeOptions, assertObject } from "./errors.js";
import { ATTR_HTTP_METHOD, ATTR_HTTP_ROUTE, ATTR_SEKIMORI_CONTEXT_SOURCE } from "./semconv.js";
import { withConsumerSpan } from "./span.js";
import type { ConsumeOptions, Extracted } from "./types.js";

/**
 * API Gateway（HTTP API v2 / REST API v1）の Lambda proxy event の最小形。
 * `aws-lambda` の `APIGatewayProxyEvent(V2)` と構造的に互換。headers は HTTP API では
 * 小文字化されて届く。REST API は任意 case のため getter は case-insensitive に読む。
 * REST API では header が `headers` と `multiValueHeaders` の両方に来る（先頭値を読む）。
 */
export interface HttpEventLike {
  // `APIGatewayProxyEventHeaders` は `string | undefined` 値を許す — 実イベントの型と
  // 構造的に互換にするため値側も undefined を受ける（undefined 値は読み飛ばす）。
  headers?: Record<string, string | undefined> | undefined;
  /**
   * REST API v1: 同名 header の複数値。`baggage` / `tracestate` のような
   * list-valued header は RFC 7230 どおり `,` で結合して propagator に渡し、
   * それ以外（`traceparent` 等）は先頭値を使う。
   */
  multiValueHeaders?: Record<string, (string | undefined)[] | undefined> | undefined;
  requestContext?:
    | {
        /** HTTP API v2 */
        http?: { method?: string; path?: string };
        /** REST API v1 */
        httpMethod?: string;
        resourcePath?: string;
      }
    | undefined;
  /** HTTP API v2: `"POST /orders"` 形（method を含む）。 */
  routeKey?: string | undefined;
  /** HTTP API v2 */
  rawPath?: string | undefined;
  /** REST API v1 */
  httpMethod?: string | undefined;
  /** REST API v1: route template（`/orders/{id}`）。 */
  resource?: string | undefined;
}

/**
 * `event.headers` の `traceparent` / `tracestate` / `baggage` から upstream context を取り出す。
 * HTTP API には X-Ray active tracing が無いため、layer の invocation span は
 * `_X_AMZN_TRACE_ID` を親にしてしまい client の traceparent は link に残らない。
 * ここで取り出して SERVER span の親（または link）にする。
 */
export function extractFromHttpEvent(
  event: HttpEventLike,
  options: { context?: Context } = {},
): Extracted {
  assertObject(event, "extractFromHttpEvent");
  assertObject(options, "extractFromHttpEvent");
  const base = baseContext(options.context, "extractFromHttpEvent");
  // REST API v1 は `multiValueHeaders` にも carrier が来る。`headers` とマージする。
  // HTTP header 名は case-insensitive — 両 map で case が違う同名 header（`TraceParent` と
  // `traceparent`）が別 key として残ると propagator がどちらを読むか不定になるため、
  // 小文字に正規化して衝突を潰す。`headers`（単一値 map）を後から書いて優先させる。
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(event.multiValueHeaders ?? {})) {
    // 実イベントでは string[]。bare string も拾い、それ以外（number 等）は捨てる。
    // `baggage` / `tracestate` は複数値が規格上合法 — 先頭値に潰すと後続 entry を
    // 失うため RFC 7230 のとおり `,` で結合して渡す。`traceparent` 等の単一値
    // header に複数値が来るのは spec 違反なので先頭値を使う。
    const lower = k.toLowerCase();
    const joined = Array.isArray(v)
      ? lower === BAGGAGE_KEY || lower === TRACESTATE_KEY
        ? v.filter((s): s is string => typeof s === "string").join(",")
        : v[0]
      : typeof v === "string"
        ? v
        : undefined;
    if (typeof joined === "string" && joined !== "") headers[lower] = joined;
  }
  for (const [k, v] of Object.entries(event.headers ?? {})) {
    if (typeof v !== "string" || v === "") continue;
    const lower = k.toLowerCase();
    // REST API v1 では `headers` は重複 header の最終値のみを持つ — `multiValueHeaders`
    // 側で結合した全値を潰さないよう、結合対象の header は既に値があれば skip する。
    if ((lower === BAGGAGE_KEY || lower === TRACESTATE_KEY) && headers[lower] !== undefined) {
      continue;
    }
    headers[lower] = v;
  }
  if (Object.keys(headers).length > 0) {
    const ctx = propagation.extract(base, headers, objectGetter);
    const spanContext = newSpanContext(base, ctx);
    // carrier が baggage だけを載せる（traceparent なし）場合も source を記録する。
    // そのとき spanContext は付けない（self-link 防止）。
    if (spanContext !== undefined || hasNewBaggage(base, ctx)) {
      return {
        context: preserveBaseBaggage(ctx, base),
        source: "headers",
        ...(spanContext !== undefined ? { spanContext } : {}),
      };
    }
  }
  return { context: base, source: "none" };
}

/**
 * HTTP 境界の SERVER span を開く。
 * messaging 系（DEC-002）と違い、HTTP は同期 request/response なので既定の親は producer
 * （client の traceparent）。`parent: "invocation"` にすると layer の invocation span を親にし、
 * producer へは link になる。
 */
export async function withHttpEvent<T>(
  event: HttpEventLike,
  fn: (span: Span) => Promise<T> | T,
  options: ConsumeOptions = {},
): Promise<T> {
  assertObject(event, "withHttpEvent");
  assertObject(options, "withHttpEvent");
  assertConsumeOptions(options, "withHttpEvent");
  const base = baseContext(options.context, "withHttpEvent");
  const extracted = extractFromHttpEvent(event, { context: base });
  // baggage は常に union（producer 親でも base 側の entry を消さない）。
  const merged = mergeBaggage(base, extracted.context);
  const parentOnProducer =
    options.parent !== "invocation" &&
    extracted.source !== "none" &&
    extracted.spanContext !== undefined;
  const parent =
    parentOnProducer && extracted.spanContext !== undefined
      ? trace.setSpanContext(merged, extracted.spanContext)
      : merged;
  const link = parentOnProducer ? undefined : extracted.spanContext;
  // 空文字は未設定と同じ（`??` は `""` を通してしまうため空文字も除いて探す）。
  const method = [
    event.requestContext?.http?.method,
    event.httpMethod,
    event.requestContext?.httpMethod,
  ].find((m): m is string => typeof m === "string" && m !== "");
  // `http.route` は route template（method を含まない・実パスは入れない — concrete path は
  // 高 cardinality で semconv 違反）。v2 は routeKey から method を剥がす。`$default` は
  // route としては意味を持たないので undefined にし、span 名側だけで使う。
  const routeKey =
    typeof event.routeKey === "string" && event.routeKey !== "" ? event.routeKey : undefined;
  const routeTemplate = (() => {
    if (routeKey !== undefined) {
      const r = routeKey.replace(/^\S+\s+/, "");
      // method のみ（"POST"）/ 空 / `$default` は route にならない。
      // "/" 始まりの単 token は path-only の routeKey として残す。
      if (r === "" || r === "$default" || (r === routeKey && !r.startsWith("/"))) {
        return undefined;
      }
      return r;
    }
    const resource =
      typeof event.resource === "string" && event.resource !== "" ? event.resource : undefined;
    const resourcePath =
      typeof event.requestContext?.resourcePath === "string" &&
      event.requestContext.resourcePath !== ""
        ? event.requestContext.resourcePath
        : undefined;
    return resource ?? resourcePath;
  })();
  const name =
    options.name ??
    `${method ?? "HTTP"} ${routeTemplate ?? (routeKey === "$default" ? "$default" : "request")}`;
  return withConsumerSpan(
    name,
    {
      parent,
      link,
      kind: SpanKind.SERVER,
      attributes: {
        // SERVER span に messaging.* は付けない（semconv 上 messaging span の属性のため）。
        // 境界の識別は sekimori.context.source が担う。
        ...(method !== undefined ? { [ATTR_HTTP_METHOD]: method } : {}),
        ...(routeTemplate !== undefined ? { [ATTR_HTTP_ROUTE]: routeTemplate } : {}),
        [ATTR_SEKIMORI_CONTEXT_SOURCE]: extracted.source,
        ...options.attributes,
      },
    },
    fn,
  );
}
