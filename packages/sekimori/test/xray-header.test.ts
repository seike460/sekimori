import { propagation, ROOT_CONTEXT, TraceFlags, trace } from "@opentelemetry/api";
import { AWSXRayPropagator } from "@opentelemetry/propagator-aws-xray";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { formatXrayTraceHeader, parseXrayTraceHeader } from "../src/index.js";
import { asMalformed } from "./otel-setup.js";

const TRACE_ID = "5759e988bd862e3fe1be46a994272793";
const SPAN_ID = "53995c3f42cd8ad8";

describe("formatXrayTraceHeader", () => {
  it("formats the documented X-Ray layout with an epoch prefix of 8 hex", () => {
    expect(
      formatXrayTraceHeader({ traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: TraceFlags.SAMPLED }),
    ).toBe("Root=1-5759e988-bd862e3fe1be46a994272793;Parent=53995c3f42cd8ad8;Sampled=1");
  });

  it("marks unsampled contexts as Sampled=0", () => {
    expect(
      formatXrayTraceHeader({ traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: TraceFlags.NONE }),
    ).toContain(";Sampled=0");
  });

  it("matches @opentelemetry/propagator-aws-xray byte for byte", () => {
    const ctx = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      traceFlags: TraceFlags.SAMPLED,
    });
    const carrier: Record<string, string> = {};
    new AWSXRayPropagator().inject(ctx, carrier, {
      set: (c, k, v) => {
        c[k] = v;
      },
    });
    const injected = carrier["X-Amzn-Trace-Id"] ?? carrier["x-amzn-trace-id"];
    expect(injected).toBe(
      formatXrayTraceHeader({ traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: TraceFlags.SAMPLED }),
    );
    expect(propagation.fields()).toEqual([]); // no global propagator registered in this file
  });
});

describe("parseXrayTraceHeader", () => {
  it("parses Root/Parent/Sampled into a remote SpanContext", () => {
    expect(
      parseXrayTraceHeader(
        "Root=1-5759e988-bd862e3fe1be46a994272793;Parent=53995c3f42cd8ad8;Sampled=1",
      ),
    ).toEqual({
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    });
  });

  it("treats Sampled=? and Sampled=0 as unsampled and ignores unknown fields such as Lineage", () => {
    const sc = parseXrayTraceHeader(
      `Root=1-5759e988-bd862e3fe1be46a994272793;Parent=${SPAN_ID};Sampled=?;Lineage=1:abc:0`,
    );
    expect(sc?.traceFlags).toBe(TraceFlags.NONE);
  });

  it("returns undefined when Parent is missing (Lambda-supplied headers without a parent cannot be linked)", () => {
    expect(
      parseXrayTraceHeader("Root=1-5759e988-bd862e3fe1be46a994272793;Sampled=1"),
    ).toBeUndefined();
  });

  it.each([
    "",
    "garbage",
    "Root=1-zz;Parent=1",
    "Root=1-5759e988-bd862e3fe1be46a994272793;Parent=0000000000000000",
  ])("rejects invalid input %j", (input) => {
    expect(parseXrayTraceHeader(input)).toBeUndefined();
  });

  it("returns undefined for non-string input instead of throwing", () => {
    // Lambda event の attribute が壊れている / 型が合わない入力を安全側に倒す
    for (const bad of [undefined, null, 123, {}, []]) {
      expect(parseXrayTraceHeader(asMalformed(bad))).toBeUndefined();
    }
  });

  it("round-trips any valid SpanContext (property)", () => {
    const hex = (n: number) =>
      fc
        .array(fc.constantFrom(..."0123456789abcdef"), { minLength: n, maxLength: n })
        .map((cs) => cs.join(""))
        .filter((s) => /[1-9a-f]/.test(s));
    fc.assert(
      fc.property(hex(32), hex(16), fc.boolean(), (traceId, spanId, sampled) => {
        const sc = { traceId, spanId, traceFlags: sampled ? TraceFlags.SAMPLED : TraceFlags.NONE };
        const header = formatXrayTraceHeader(sc);
        expect(header.length).toBeLessThanOrEqual(256);
        expect(parseXrayTraceHeader(header)).toEqual({ ...sc, isRemote: true });
      }),
      { numRuns: 300 },
    );
  });
});
