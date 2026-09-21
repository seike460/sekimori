import { type SpanContext, trace } from "@opentelemetry/api";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { formatXrayTraceHeader, injectSqsMessage, SekimoriError } from "../src/index.js";
import { type OtelHarness, setupOtel } from "./otel-setup.js";

const harness: OtelHarness = setupOtel("w3c");
const tracer = trace.getTracer("test");
afterAll(() => harness.teardown());
beforeEach(() => harness.reset());

function send(
  input: Parameters<typeof injectSqsMessage>[0] = {},
  options?: Parameters<typeof injectSqsMessage>[1],
) {
  let producer!: SpanContext;
  let injected!: ReturnType<typeof injectSqsMessage>;
  tracer.startActiveSpan("send", (span) => {
    producer = span.spanContext();
    injected = injectSqsMessage(input, options);
    span.end();
  });
  return { producer, injected };
}

describe("injectSqsMessage", () => {
  it("adds W3C message attributes and, outside the ADOT layer, the AWSTraceHeader system attribute", () => {
    const { producer, injected } = send({
      MessageAttributes: { kind: { DataType: "String", StringValue: "order" } },
    });
    expect(injected.MessageAttributes?.kind?.StringValue).toBe("order");
    expect(injected.MessageAttributes?.traceparent).toMatchObject({ DataType: "String" });
    expect(injected.MessageAttributes?.traceparent?.StringValue).toContain(producer.traceId);
    expect(
      Object.keys(injected.MessageAttributes ?? {}).some(
        (k) => k.toLowerCase() === "x-amzn-trace-id",
      ),
    ).toBe(false);
    expect(injected.MessageSystemAttributes?.AWSTraceHeader?.StringValue).toBe(
      formatXrayTraceHeader(producer),
    );
  });

  it("omits AWSTraceHeader when xrayHeader:false", () => {
    const { injected } = send({}, { xrayHeader: false });
    expect(injected.MessageSystemAttributes).toBeUndefined();
  });

  it("never overwrites a caller-supplied AWSTraceHeader", () => {
    const caller = { DataType: "String", StringValue: "Root=1-dead-beef;Parent=1;Sampled=1" };
    const { injected } = send({ MessageSystemAttributes: { AWSTraceHeader: caller } });
    expect(injected.MessageSystemAttributes?.AWSTraceHeader).toBe(caller);
  });

  it("refuses to exceed the 10 message attribute quota with a named error", () => {
    const many = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`k${i}`, { DataType: "String", StringValue: "v" }]),
    );
    expect(() => send({ MessageAttributes: many })).toThrow(SekimoriError);
  });

  it("never overwrites a caller-supplied propagation key (case-insensitive)", () => {
    const caller = { DataType: "String", StringValue: "caller-owned" };
    const { injected } = send({
      MessageAttributes: { TraceParent: caller }, // 別 case — 上書きしない
    });
    expect(injected.MessageAttributes?.TraceParent).toBe(caller);
    expect(injected.MessageAttributes?.traceparent).toBeUndefined();
  });

  it("rejects non-object input with a named error", () => {
    // @ts-expect-error runtime guard の検証
    expect(() => injectSqsMessage(null)).toThrow(SekimoriError);
    // @ts-expect-error runtime guard の検証
    expect(() => injectSqsMessage("x")).toThrow(SekimoriError);
  });
});
