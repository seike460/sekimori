import { propagation, type SpanContext, SpanKind, trace } from "@opentelemetry/api";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { extractFromHttpEvent, withHttpEvent } from "../src/index.js";
import { asMalformed, type OtelHarness, setupOtel, spanNamed } from "./otel-setup.js";

const harness: OtelHarness = setupOtel("w3c");
const tracer = trace.getTracer("test");
afterAll(() => harness.teardown());
beforeEach(() => harness.reset());

/** upstream client が W3C traceparent を送った HTTP API event を組み立てる。 */
function httpRequest() {
  let upstream!: SpanContext;
  let headers!: Record<string, string>;
  tracer.startActiveSpan("client", (span) => {
    upstream = span.spanContext();
    headers = {
      traceparent: `00-${upstream.traceId}-${upstream.spanId}-01`,
      "content-type": "application/json",
    };
    span.end();
  });
  const event = {
    headers,
    requestContext: { http: { method: "POST", path: "/orders" } },
    routeKey: "POST /orders",
    rawPath: "/orders",
  };
  return { upstream, event };
}

describe("extractFromHttpEvent", () => {
  it("extracts the client context from headers (case-insensitive)", () => {
    const { upstream, event } = httpRequest();
    const extracted = extractFromHttpEvent(event);
    expect(extracted.source).toBe("headers");
    expect(extracted.spanContext).toMatchObject({
      traceId: upstream.traceId,
      spanId: upstream.spanId,
    });
  });

  it("returns none without headers or a traceparent", () => {
    expect(extractFromHttpEvent({}).source).toBe("none");
    expect(extractFromHttpEvent({ headers: { "content-type": "text/plain" } }).source).toBe("none");
  });

  it("skips undefined header values (APIGatewayProxyEventHeaders allows them)", () => {
    const { upstream } = httpRequest();
    const extracted = extractFromHttpEvent({
      headers: { traceparent: `00-${upstream.traceId}-${upstream.spanId}-01`, "x-drop": undefined },
    });
    expect(extracted.source).toBe("headers");
    expect(extracted.spanContext?.spanId).toBe(upstream.spanId);
  });
});

describe("withHttpEvent", () => {
  it("opens a SERVER span parented on the producer by default (HTTP is synchronous)", async () => {
    const { upstream, event } = httpRequest();
    await tracer.startActiveSpan("invocation", async (inv) => {
      await withHttpEvent(event, () => "ok");
      inv.end();
    });
    const server = spanNamed(harness.spans(), "POST /orders");
    expect(server.kind).toBe(SpanKind.SERVER);
    expect(server.parentSpanContext?.spanId).toBe(upstream.spanId);
    expect(server.spanContext().traceId).toBe(upstream.traceId);
    expect(server.attributes).toMatchObject({
      "http.request.method": "POST",
      "http.route": "/orders",
      "sekimori.context.source": "headers",
    });
  });

  it("strips the method and parameter templates stay in http.route; $default has none", async () => {
    // route template（{id}）はそのまま http.route へ
    await tracer.startActiveSpan("inv", async (inv) => {
      await withHttpEvent(
        {
          headers: {},
          requestContext: { http: { method: "GET", path: "/orders/42" } },
          routeKey: "GET /orders/{id}",
          rawPath: "/orders/42",
        },
        () => "ok",
      );
      inv.end();
    });
    const templated = spanNamed(harness.spans(), "GET /orders/{id}");
    expect(templated.attributes["http.route"]).toBe("/orders/{id}");
    expect(templated.attributes["http.request.method"]).toBe("GET");

    // $default は route として意味を持たない — http.route 自体を付けない
    harness.reset();
    await tracer.startActiveSpan("inv", async (inv) => {
      await withHttpEvent(
        {
          headers: {},
          requestContext: { http: { method: "GET", path: "/anything" } },
          routeKey: "$default",
          rawPath: "/anything",
        },
        () => "ok",
      );
      inv.end();
    });
    const def = spanNamed(harness.spans(), "GET $default");
    expect(def.attributes["http.route"]).toBeUndefined();
    expect(def.attributes["http.request.method"]).toBe("GET");
  });

  it("does not put messaging.* attributes on a SERVER span", async () => {
    const { event } = httpRequest();
    await withHttpEvent(event, () => "ok");
    const server = spanNamed(harness.spans(), "POST /orders");
    for (const key of Object.keys(server.attributes)) {
      expect(key.startsWith("messaging.")).toBe(false);
    }
  });

  it("parents on the invocation span and links the producer when parent:'invocation'", async () => {
    const { upstream, event } = httpRequest();
    await tracer.startActiveSpan("invocation", async (inv) => {
      await withHttpEvent(event, () => undefined, { parent: "invocation" });
      inv.end();
    });
    const server = spanNamed(harness.spans(), "POST /orders");
    const invocation = spanNamed(harness.spans(), "invocation");
    expect(server.parentSpanContext?.spanId).toBe(invocation.spanContext().spanId);
    expect(server.links.map((l) => l.context.spanId)).toEqual([upstream.spanId]);
  });

  describe("REST API v1 events", () => {
    function v1Request() {
      let upstream!: SpanContext;
      tracer.startActiveSpan("client", (span) => {
        upstream = span.spanContext();
        span.end();
      });
      const traceparent = `00-${upstream.traceId}-${upstream.spanId}-01`;
      return {
        upstream,
        event: {
          httpMethod: "GET",
          resource: "/orders/{id}",
          path: "/prod/orders/42",
          requestContext: {
            httpMethod: "GET",
            resourcePath: "/orders/{id}",
            path: "/prod/orders/42",
          },
          // v1 は multiValueHeaders にも来る。headers を欠く形で試す。
          multiValueHeaders: { traceparent: [traceparent], "x-other": ["1", "2"] },
        },
      };
    }

    it("extracts the client context from multiValueHeaders", () => {
      const { upstream, event } = v1Request();
      const extracted = extractFromHttpEvent(event);
      expect(extracted.source).toBe("headers");
      expect(extracted.spanContext).toMatchObject({
        traceId: upstream.traceId,
        spanId: upstream.spanId,
      });
    });

    it("names the span 'METHOD /resource' and sets http attributes", async () => {
      const { upstream, event } = v1Request();
      await tracer.startActiveSpan("invocation", async (inv) => {
        await withHttpEvent(event, () => "ok");
        inv.end();
      });
      const server = spanNamed(harness.spans(), "GET /orders/{id}");
      expect(server.kind).toBe(SpanKind.SERVER);
      expect(server.parentSpanContext?.spanId).toBe(upstream.spanId);
      expect(server.attributes).toMatchObject({
        "http.request.method": "GET",
        "http.route": "/orders/{id}",
      });
    });
  });
});

describe("Round-5 hardening", () => {
  it("accepts a bare-string multiValueHeaders value instead of truncating to its first char (R5-A-3)", () => {
    // `v?.[0]` は string の先頭 1 文字を返す — traceparent が "0" に潰れて propagation が
    // silent に失敗していた。bare string はそのまま拾う。
    const { upstream } = httpRequest();
    const traceparent = `00-${upstream.traceId}-${upstream.spanId}-01`;
    const extracted = extractFromHttpEvent({
      multiValueHeaders: { traceparent: asMalformed(traceparent) },
    });
    expect(extracted.source).toBe("headers");
    expect(extracted.spanContext?.spanId).toBe(upstream.spanId);
    // 非 string 値は拾わない。
    expect(
      extractFromHttpEvent({ multiValueHeaders: { traceparent: asMalformed(42) } }).source,
    ).toBe("none");
  });

  it("does not set http.request.method from a non-string method field (R5-A-4)", async () => {
    await withHttpEvent(
      { headers: {}, httpMethod: asMalformed(42), requestContext: {} },
      () => "ok",
    );
    const server = spanNamed(harness.spans(), "HTTP request");
    expect(server.attributes["http.request.method"]).toBeUndefined();
  });

  it("rejects a null options argument with a named error (R5-A-6)", () => {
    // @ts-expect-error runtime guard の検証
    expect(() => extractFromHttpEvent({}, null)).toThrow(Error);
  });

  it("prefers `headers` over `multiValueHeaders` on case-insensitive name collisions (R9-A)", () => {
    // `multiValueHeaders: { TraceParent: <old> }` と `headers: { traceparent: <new> }` が
    // 別 key として残ると propagator がどちらを読むか不定になる — 小文字に正規化して
    // `headers`（単一値 map）を優先させる。
    const { upstream } = httpRequest();
    const fresh = `00-${upstream.traceId}-${upstream.spanId}-01`;
    const stale = "00-6999999999999999999999999999-0000000000000001-01";
    const extracted = extractFromHttpEvent({
      multiValueHeaders: { TraceParent: [stale] },
      headers: { traceparent: fresh },
    });
    expect(extracted.source).toBe("headers");
    expect(extracted.spanContext?.spanId).toBe(upstream.spanId);
  });
});

describe("Round-12 hardening (multi-value carriers)", () => {
  it("joins multi-value baggage/tracestate headers per RFC 7230 instead of keeping only the first", () => {
    // `baggage` / `tracestate` は複数値が規格上合法 — 先頭値に潰すと後続 entry を失う。
    const { upstream } = httpRequest();
    const traceparent = `00-${upstream.traceId}-${upstream.spanId}-01`;
    const extracted = extractFromHttpEvent({
      multiValueHeaders: {
        traceparent: [traceparent],
        baggage: ["tenant=t1", "user=u2"],
      },
    });
    expect(extracted.source).toBe("headers");
    expect(extracted.spanContext?.spanId).toBe(upstream.spanId);
    const bag = propagation.getBaggage(extracted.context);
    expect(bag?.getEntry("tenant")?.value).toBe("t1");
    expect(bag?.getEntry("user")?.value).toBe("u2");
  });

  it("keeps only the first value for single-value headers and drops empty values", () => {
    // `traceparent` に複数値が来るのは spec 違反 — 先頭値を使う。空文字は未設定と同じ。
    const { upstream } = httpRequest();
    const traceparent = `00-${upstream.traceId}-${upstream.spanId}-01`;
    const extracted = extractFromHttpEvent({
      multiValueHeaders: {
        traceparent: ["garbage", traceparent],
        baggage: [],
      },
    });
    // 先頭は不正値なので span context は取れない（"garbage" が採用される）が、
    // none に落ちること自体が「2 番目をこっそり使わない」ことの証明になる。
    expect(extracted.spanContext).toBeUndefined();
    const ok = extractFromHttpEvent({ multiValueHeaders: { traceparent: [traceparent] } });
    expect(ok.spanContext?.spanId).toBe(upstream.spanId);
  });

  it("keeps the multiValueHeaders baggage join when headers holds only the last value (v1)", () => {
    // REST API v1 では `headers` は重複 header の最終値のみを持つ —
    // `multiValueHeaders` 側で結合した全値を単一値で潰さない（R13）。
    const extracted = extractFromHttpEvent({
      multiValueHeaders: { baggage: ["tenant=t1", "user=u2"] },
      headers: { baggage: "user=u2" },
    });
    const bag = propagation.getBaggage(extracted.context);
    expect(bag?.getEntry("tenant")?.value).toBe("t1");
    expect(bag?.getEntry("user")?.value).toBe("u2");
  });

  it("does not let an empty headers value clobber a valid multiValueHeaders entry", () => {
    const { upstream } = httpRequest();
    const traceparent = `00-${upstream.traceId}-${upstream.spanId}-01`;
    const extracted = extractFromHttpEvent({
      multiValueHeaders: { traceparent: [traceparent] },
      headers: { traceparent: "" },
    });
    expect(extracted.spanContext?.spanId).toBe(upstream.spanId);
  });
});
