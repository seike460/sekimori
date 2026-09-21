import { context, type SpanContext, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  extractFromEventBridgeEvent,
  injectEventBridgeEntry,
  type PutEventsEntryLike,
  parseXrayTraceHeader,
  withEventBridgeEvent,
} from "../src/index.js";
import { type OtelHarness, setupOtel, spanNamed } from "./otel-setup.js";

const harness: OtelHarness = setupOtel("w3c");
const tracer = trace.getTracer("test");
afterAll(() => harness.teardown());
beforeEach(() => harness.reset());

function publish(entry: { Source: string; DetailType: string; Detail?: string }) {
  let producer!: SpanContext;
  let injected!: ReturnType<typeof injectEventBridgeEntry<typeof entry>>;
  tracer.startActiveSpan("publish", (span) => {
    producer = span.spanContext();
    injected = injectEventBridgeEntry(entry);
    span.end();
  });
  return { producer, injected };
}

describe("injectEventBridgeEntry", () => {
  it("writes TraceHeader (X-Ray format) and W3C traceparent into Detail, preserving user keys", () => {
    const entry = {
      Source: "orders",
      DetailType: "created",
      Detail: JSON.stringify({ orderId: "o-1" }),
    };
    const { producer, injected } = publish(entry);
    expect(parseXrayTraceHeader(injected.TraceHeader)).toMatchObject({
      traceId: producer.traceId,
      spanId: producer.spanId,
    });
    const detail = JSON.parse(injected.Detail!);
    expect(detail.orderId).toBe("o-1");
    expect(detail.traceparent).toMatch(
      new RegExp(`^00-${producer.traceId}-${producer.spanId}-0[01]$`),
    );
    expect(entry.Detail).toBe(JSON.stringify({ orderId: "o-1" })); // input not mutated
  });

  it("leaves a non-JSON Detail untouched but still sets TraceHeader", () => {
    const { injected } = publish({ Source: "s", DetailType: "t", Detail: "not json" });
    expect(injected.Detail).toBe("not json");
    expect(injected.TraceHeader).toBeDefined();
  });

  it("removes a stale x-amzn-trace-id in Detail when a fresh traceparent is written (R8-A)", () => {
    // 古い hop の X-Ray key を残すと xray を優先する読み手（xray-only propagator /
    // xray-last 構成）が fresh な traceparent より stale context を選ぶ split-brain になるため、
    // 伝播 slot として消す。
    const { producer, injected } = publish({
      Source: "s",
      DetailType: "t",
      Detail: JSON.stringify({
        "x-amzn-trace-id":
          "Root=1-aaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb;Parent=cccccccccccccccc;Sampled=1",
        orderId: "o-1",
      }),
    });
    const detail = JSON.parse(injected.Detail!) as Record<string, unknown>;
    expect(detail["x-amzn-trace-id"]).toBeUndefined();
    expect(detail.traceparent).toContain(producer.traceId);
    expect(detail.orderId).toBe("o-1");
  });

  it("does not overwrite a traceparent the caller already put in Detail", () => {
    const own = "00-11111111111111111111111111111111-2222222222222222-01";
    const { injected } = publish({
      Source: "s",
      DetailType: "t",
      Detail: JSON.stringify({ traceparent: own }),
    });
    expect(JSON.parse(injected.Detail!).traceparent).toBe(own);
  });

  it("is a no-op without an active span", () => {
    const out = injectEventBridgeEntry({ Source: "s", DetailType: "t", Detail: "{}" });
    expect(out.TraceHeader).toBeUndefined();
    expect(out.Detail).toBe("{}");
  });

  it("honours w3c:false and xrayHeader:false", () => {
    const { injected } = publish({ Source: "s", DetailType: "t", Detail: "{}" });
    expect(injected.TraceHeader).toBeDefined();
    let quiet!: PutEventsEntryLike;
    tracer.startActiveSpan("publish2", (span) => {
      quiet = injectEventBridgeEntry({ Detail: "{}" }, { w3c: false, xrayHeader: false });
      span.end();
    });
    expect(quiet.TraceHeader).toBeUndefined();
    expect(quiet.Detail).toBe("{}");
  });
});

describe("extractFromEventBridgeEvent / withEventBridgeEvent", () => {
  function eventFrom(injected: { Detail?: string }) {
    return {
      id: "evt-1",
      source: "orders",
      "detail-type": "created",
      detail: JSON.parse(injected.Detail ?? "{}"),
    };
  }

  it("extracts the producer context from detail", () => {
    const { producer, injected } = publish({
      Source: "orders",
      DetailType: "created",
      Detail: "{}",
    });
    const extracted = extractFromEventBridgeEvent(eventFrom(injected));
    expect(extracted.source).toBe("detail");
    expect(extracted.spanContext).toMatchObject({
      traceId: producer.traceId,
      spanId: producer.spanId,
    });
  });

  it("reports none when detail carries nothing", () => {
    expect(extractFromEventBridgeEvent({ detail: { orderId: 1 } }).source).toBe("none");
    expect(extractFromEventBridgeEvent({ detail: "string detail" }).source).toBe("none");
  });

  it("opens a CONSUMER span under the invocation span with a link to the producer (DEC-002)", async () => {
    const { producer, injected } = publish({
      Source: "orders",
      DetailType: "created",
      Detail: "{}",
    });
    await tracer.startActiveSpan("invocation", async (inv) => {
      const result = await withEventBridgeEvent(eventFrom(injected), async (span) => {
        span.setAttribute("handled", true);
        return "ok";
      });
      expect(result).toBe("ok");
      inv.end();
    });
    const spans = harness.spans();
    const consumer = spanNamed(spans, "process orders");
    const invocation = spanNamed(spans, "invocation");
    expect(consumer.kind).toBe(SpanKind.CONSUMER);
    expect(consumer.parentSpanContext?.spanId).toBe(invocation.spanContext().spanId);
    expect(consumer.links.map((l) => l.context.spanId)).toEqual([producer.spanId]);
    expect(consumer.attributes).toMatchObject({
      "messaging.system": "aws_eventbridge",
      "messaging.operation.type": "process",
      "aws.eventbridge.source": "orders",
      "aws.eventbridge.detail_type": "created",
      "aws.eventbridge.event_id": "evt-1",
      "sekimori.context.source": "detail",
      handled: true,
    });
  });

  it("parents on the producer when parent:'producer' is requested", async () => {
    const { producer, injected } = publish({
      Source: "orders",
      DetailType: "created",
      Detail: "{}",
    });
    await tracer.startActiveSpan("invocation", async (inv) => {
      await withEventBridgeEvent(eventFrom(injected), () => undefined, {
        parent: "producer",
        name: "custom",
      });
      inv.end();
    });
    const consumer = spanNamed(harness.spans(), "custom");
    expect(consumer.parentSpanContext?.spanId).toBe(producer.spanId);
    expect(consumer.spanContext().traceId).toBe(producer.traceId);
    expect(consumer.links).toEqual([]);
  });

  it("records the exception, sets ERROR status, ends the span and rethrows", async () => {
    await expect(
      withEventBridgeEvent({ source: "s", detail: {} }, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const consumer = spanNamed(harness.spans(), "process s");
    expect(consumer.status.code).toBe(SpanStatusCode.ERROR);
    expect(consumer.events.some((e) => e.name === "exception")).toBe(true);
    expect(consumer.ended).toBe(true);
  });
});

describe("Round-5 hardening", () => {
  it("does not set event attributes from non-string fields (R5-A-4)", async () => {
    await withEventBridgeEvent(
      { source: 42 as never, "detail-type": [] as never, id: {} as never, detail: {} },
      () => undefined,
    );
    const consumer = spanNamed(harness.spans(), "process eventbridge");
    expect(consumer.attributes["aws.eventbridge.source"]).toBeUndefined();
    expect(consumer.attributes["aws.eventbridge.detail_type"]).toBeUndefined();
    expect(consumer.attributes["aws.eventbridge.event_id"]).toBeUndefined();
  });

  it("rejects a null options argument with a named error (R5-A-6)", () => {
    // @ts-expect-error runtime guard の検証
    expect(() => extractFromEventBridgeEvent({}, null)).toThrow(Error);
  });
});

describe("Round-9 hardening", () => {
  it("rejects entries over the 256 KiB PutEvents limit instead of letting AWS reject them (R9-A)", async () => {
    const { SekimoriError } = await import("../src/index.js");
    const big = "x".repeat(300 * 1024);
    expect(() => injectEventBridgeEntry({ Detail: JSON.stringify({ d: big }) })).toThrow(
      SekimoriError,
    );
  });
});

describe("suppression (R11-A)", () => {
  it("writes no TraceHeader and keeps Detail untouched when the context is suppressed", () => {
    tracer.startActiveSpan("eb-sup", (span) => {
      const injected = injectEventBridgeEntry(
        { Detail: JSON.stringify({ a: 1 }) },
        { context: suppressTracing(context.active()) },
      );
      span.end();
      expect(injected.TraceHeader).toBeUndefined();
      expect(injected.Detail).toBe(JSON.stringify({ a: 1 }));
    });
  });
});

describe("Round-12 hardening (pinned traceparent conflict)", () => {
  const PIN_A = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
  const XRAY_A = "Root=1-aaaaaaaa-aaaaaaaaaaaaaaaaaaaaaaaa;Parent=bbbbbbbbbbbbbbbb;Sampled=1";

  it("suppresses TraceHeader and keeps the caller's xray field on a detail pin conflict", () => {
    // pin が active span と別 trace を指すのに fresh な TraceHeader を書くと、
    // detail の pin を読む側と X-Ray channel を読む側で trace が分かれる。
    tracer.startActiveSpan("eb-pin-conflict", (span) => {
      const injected = injectEventBridgeEntry({
        Detail: JSON.stringify({
          orderId: "o-1",
          traceparent: PIN_A,
          "x-amzn-trace-id": XRAY_A,
        }),
      });
      span.end();
      const detail = JSON.parse(injected.Detail ?? "{}") as Record<string, unknown>;
      expect(detail.traceparent).toBe(PIN_A);
      expect(detail["x-amzn-trace-id"]).toBe(XRAY_A);
      expect(injected.TraceHeader).toBeUndefined();
    });
  });

  it("still writes TraceHeader when the detail pin matches the active trace", () => {
    tracer.startActiveSpan("eb-pin-same", (span) => {
      const sc = span.spanContext();
      const injected = injectEventBridgeEntry({
        Detail: JSON.stringify({ traceparent: `00-${sc.traceId}-${sc.spanId}-01` }),
      });
      span.end();
      expect(injected.TraceHeader).toContain(`Parent=${sc.spanId}`);
    });
  });

  it("removes a stale x-amzn-trace-id in Detail that disagrees with the pin (R19)", () => {
    // pin（trace A）と別 trace（C）の xray field が残ると xray を優先する読み手が
    // pin に勝つ — pin の trace に照合して消す。pin と同じ trace の値は残す。
    const XRAY_C = "Root=1-cccccccc-cccccccccccccccccccccccc;Parent=dddddddddddddddd;Sampled=1";
    tracer.startActiveSpan("eb-pin-stale-xray", (span) => {
      const injected = injectEventBridgeEntry({
        Detail: JSON.stringify({
          traceparent: PIN_A,
          "x-amzn-trace-id": XRAY_C,
        }),
      });
      span.end();
      const detail = JSON.parse(injected.Detail ?? "{}") as Record<string, unknown>;
      expect(detail.traceparent).toBe(PIN_A);
      expect(detail["x-amzn-trace-id"]).toBeUndefined();
    });
  });
});
