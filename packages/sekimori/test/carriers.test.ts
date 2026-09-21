import {
  type Context,
  context,
  propagation,
  ROOT_CONTEXT,
  type SpanContext,
  TraceFlags,
  trace,
} from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import { describe, expect, it } from "vitest";
import {
  baseContext,
  carrierHasW3c,
  globalPropagatorHasXray,
  hasCarrierKey,
  hasNewBaggage,
  isTracingSuppressed,
  mergeBaggage,
  mergeSdkAttributesCarrier,
  newSpanContext,
  objectGetter,
  pinnedW3cTraceConflicts,
  pinnedW3cTraceId,
  preserveBaseBaggage,
  recordAttributesGetter,
  removeCarrierKey,
  removeW3cSpanSlots,
  type SdkMessageAttributes,
  scrubStaleSdkXrayAttribute,
  scrubStaleXrayField,
  sdkPinnedW3cTraceConflicts,
  sdkPinnedW3cTraceId,
  snsEnvelopeAttributesGetter,
  stripW3cCarrierKeys,
  w3cSpanPairPinned,
} from "../src/carriers.js";
import { asMalformed, setupOtel } from "./otel-setup.js";

setupOtel("w3c");

const TRACE_A = "4bf92f3577b34da6a3ce929d0e0e4736";
const TRACE_B = "000000000000000000000000000000ff";
const TP_A = `00-${TRACE_A}-00f067aa0ba902b7-01`;
const sc = (traceId: string): SpanContext => ({
  traceId,
  spanId: "00f067aa0ba902b7",
  traceFlags: TraceFlags.SAMPLED,
});
const spanCtx = (traceId = TRACE_A): Context =>
  trace.setSpanContext(ROOT_CONTEXT, { ...sc(traceId), isRemote: true });
const baggageCtx = (entries: Record<string, string>): Context =>
  propagation.setBaggage(
    ROOT_CONTEXT,
    propagation.createBaggage(
      Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, { value: v }])),
    ),
  );
const baggageValue = (ctx: Context, key: string): string | undefined =>
  propagation.getBaggage(ctx)?.getEntry(key)?.value;

describe("carrier key helpers", () => {
  it("hasCarrierKey は case-insensitive", () => {
    expect(hasCarrierKey({ TraceParent: "x" }, "traceparent")).toBe(true);
    expect(hasCarrierKey({}, "traceparent")).toBe(false);
  });
  it("removeCarrierKey は大文字小文字を吸収して消す", () => {
    const c: Record<string, unknown> = { "X-Amzn-Trace-Id": "v", other: 1 };
    expect(removeCarrierKey(c, "x-amzn-trace-id")).toBe(true);
    expect(c).toEqual({ other: 1 });
    expect(removeCarrierKey(c, "missing")).toBe(false);
  });
});

describe("baseContext / suppression", () => {
  it("未指定なら active context、不正値は SekimoriError", () => {
    expect(baseContext(undefined, "t")).toBe(context.active());
    expect(() => baseContext({} as Context, "t")).toThrow(/Context/);
  });
  it("suppressTracing した context を検出する", () => {
    expect(isTracingSuppressed(ROOT_CONTEXT)).toBe(false);
    expect(isTracingSuppressed(suppressTracing(ROOT_CONTEXT))).toBe(true);
  });
});

describe("TextMapGetter 群", () => {
  it("recordAttributesGetter は stringValue/StringValue を読み、非 string は undefined", () => {
    const attrs = asMalformed({
      tp: { stringValue: "a" },
      up: { StringValue: "b" },
      both: { stringValue: "", StringValue: "fallback" },
      bad: { StringValue: 5 },
    });
    expect(recordAttributesGetter.get(attrs, "TP")).toBe("a");
    expect(recordAttributesGetter.get(attrs, "up")).toBe("b");
    expect(recordAttributesGetter.get(attrs, "both")).toBe("fallback");
    expect(recordAttributesGetter.get(attrs, "bad")).toBeUndefined();
    expect(recordAttributesGetter.get(attrs, "nope")).toBeUndefined();
  });
  it("snsEnvelopeAttributesGetter は Value を読む", () => {
    const attrs = { traceparent: { Type: "String", Value: TP_A } };
    expect(snsEnvelopeAttributesGetter.get(attrs, "TraceParent")).toBe(TP_A);
    expect(snsEnvelopeAttributesGetter.get({}, "x")).toBeUndefined();
  });
  it("objectGetter は string 値だけを読む", () => {
    expect(objectGetter.get({ a: "s", n: 1, o: {} }, "a")).toBe("s");
    expect(objectGetter.get({ n: 1 }, "n")).toBeUndefined();
  });
});

describe("W3C slot helpers", () => {
  it("carrierHasW3c / w3cSpanPairPinned / removeW3cSpanSlots", () => {
    expect(carrierHasW3c({ traceparent: TP_A })).toBe(true);
    expect(carrierHasW3c({ "x-amzn-trace-id": "Root=1-x" })).toBe(false);
    expect(w3cSpanPairPinned({ tracestate: "k=v" })).toBe(true);
    const t: Record<string, unknown> = { traceparent: TP_A, tracestate: "x", keep: 1 };
    expect(removeW3cSpanSlots(t)).toBe(true);
    expect(t).toEqual({ keep: 1 });
    expect(removeW3cSpanSlots({ keep: 1 })).toBe(false);
  });
  it("stripW3cCarrierKeys は W3C key だけを落とす", () => {
    const c = { traceparent: TP_A, tracestate: "x", baggage: "b", "x-amzn-trace-id": "Root=1" };
    stripW3cCarrierKeys(c);
    expect(c).toEqual({ "x-amzn-trace-id": "Root=1" });
  });
});

describe("pin / conflict / scrub", () => {
  it("pinnedW3cTraceId は valid な pin の trace-id を返す", () => {
    expect(pinnedW3cTraceId({ traceparent: TP_A })).toBe(TRACE_A);
    expect(pinnedW3cTraceId({ traceparent: "garbage" })).toBeUndefined();
    expect(pinnedW3cTraceId({})).toBeUndefined();
  });
  it("pinnedW3cTraceConflicts は別 trace の pin で true", () => {
    expect(pinnedW3cTraceConflicts({ traceparent: TP_A }, sc(TRACE_B))).toBe(true);
    expect(pinnedW3cTraceConflicts({ traceparent: TP_A }, sc(TRACE_A))).toBe(false);
    expect(pinnedW3cTraceConflicts({ traceparent: "bad" }, sc(TRACE_B))).toBe(false);
  });
  it("sdk 版は StringValue / stringValue を unwrap する", () => {
    const attrs = { traceparent: { DataType: "String", StringValue: TP_A } };
    expect(sdkPinnedW3cTraceId(attrs)).toBe(TRACE_A);
    expect(sdkPinnedW3cTraceConflicts(attrs, sc(TRACE_B))).toBe(true);
  });
  it("scrubStaleXrayField は pin と別 trace の値だけ消す", () => {
    const stale = `Root=1-${TRACE_B.slice(0, 8)}-${TRACE_B.slice(8)};Parent=00f067aa0ba902b7`;
    const match = `Root=1-${TRACE_A.slice(0, 8)}-${TRACE_A.slice(8)};Parent=00f067aa0ba902b7`;
    const t1 = { "x-amzn-trace-id": stale };
    expect(scrubStaleXrayField(t1, TRACE_A)).toBe(true);
    expect(t1["x-amzn-trace-id"]).toBeUndefined();
    const t2 = { "x-amzn-trace-id": match };
    expect(scrubStaleXrayField(t2, TRACE_A)).toBe(false);
    const t3 = { "x-amzn-trace-id": "not-parseable" };
    expect(scrubStaleXrayField(t3, TRACE_A)).toBe(false);
  });
  it("scrubStaleSdkXrayAttribute は SDK attribute map 版", () => {
    const stale = `Root=1-${TRACE_B.slice(0, 8)}-${TRACE_B.slice(8)};Parent=00f067aa0ba902b7`;
    const t = { "x-amzn-trace-id": { DataType: "String", StringValue: stale } };
    expect(scrubStaleSdkXrayAttribute(t, TRACE_A)).toBe(true);
    expect(t["x-amzn-trace-id"]).toBeUndefined();
  });
});

describe("mergeSdkAttributesCarrier", () => {
  const carrier = { traceparent: TP_A, baggage: "k=v" };
  it("空 attributes へ書き込み、wroteXray=false", () => {
    const attrs: SdkMessageAttributes = {};
    const r = mergeSdkAttributesCarrier(attrs, carrier, {
      carrierWroteW3c: true,
      w3cSlotsPinned: false,
      xrayConflict: false,
    });
    expect(attrs.traceparent).toEqual({ DataType: "String", StringValue: TP_A });
    expect(attrs.baggage).toEqual({ DataType: "String", StringValue: "k=v" });
    expect(r.wroteXray).toBe(false);
  });
  it("W3C carrier ありで stale な x-amzn-trace-id を消す", () => {
    const attrs: SdkMessageAttributes = {
      "x-amzn-trace-id": { DataType: "String", StringValue: "Root=1-old" },
    };
    mergeSdkAttributesCarrier(attrs, carrier, {
      carrierWroteW3c: true,
      w3cSlotsPinned: false,
      xrayConflict: false,
    });
    expect(attrs["x-amzn-trace-id"]).toBeUndefined();
  });
  it("W3C が無い carrier の x-amzn-trace-id は唯一の context として書く", () => {
    const attrs: SdkMessageAttributes = {};
    const r = mergeSdkAttributesCarrier(
      attrs,
      { "x-amzn-trace-id": "Root=1-fresh" },
      { carrierWroteW3c: false, w3cSlotsPinned: false, xrayConflict: false },
    );
    expect(attrs["x-amzn-trace-id"]).toEqual({
      DataType: "String",
      StringValue: "Root=1-fresh",
    });
    expect(r.wroteXray).toBe(true);
  });
  it("pin 済みでは carrier の traceparent/tracestate を書かない", () => {
    const pinned = `00-${TRACE_B}-bbbbbbbbbbbbbbbb-01`;
    const attrs: SdkMessageAttributes = {
      TraceParent: { DataType: "String", StringValue: pinned },
    };
    mergeSdkAttributesCarrier(
      attrs,
      { ...carrier, tracestate: "s=1" },
      {
        carrierWroteW3c: true,
        w3cSlotsPinned: true,
        xrayConflict: true,
      },
    );
    expect(attrs.TraceParent?.StringValue).toBe(pinned);
    expect(attrs.tracestate).toBeUndefined();
  });
  it("pinTraceId と別 trace の stale x-amzn-trace-id を消す", () => {
    const stale = `Root=1-${TRACE_B.slice(0, 8)}-${TRACE_B.slice(8)};Parent=00f067aa0ba902b7`;
    const attrs: SdkMessageAttributes = {
      "x-amzn-trace-id": { DataType: "String", StringValue: stale },
    };
    mergeSdkAttributesCarrier(attrs, carrier, {
      carrierWroteW3c: true,
      w3cSlotsPinned: true,
      xrayConflict: true,
      pinTraceId: TRACE_A,
    });
    expect(attrs["x-amzn-trace-id"]).toBeUndefined();
  });
  it("既存の利用者 key（非 carrier）は上書きしない", () => {
    const attrs: SdkMessageAttributes = {
      Baggage: { DataType: "String", StringValue: "user=1" },
    };
    mergeSdkAttributesCarrier(
      attrs,
      { baggage: "k=v" },
      {
        carrierWroteW3c: false,
        w3cSlotsPinned: false,
        xrayConflict: false,
      },
    );
    expect(attrs.Baggage?.StringValue).toBe("user=1");
  });
});

describe("context merge helpers", () => {
  it("newSpanContext は別の valid span context だけを返す", () => {
    const extracted = spanCtx();
    expect(newSpanContext(ROOT_CONTEXT, extracted)?.spanId).toBe("00f067aa0ba902b7");
    expect(newSpanContext(ROOT_CONTEXT, ROOT_CONTEXT)).toBeUndefined();
  });
  it("hasNewBaggage / mergeBaggage / preserveBaseBaggage", () => {
    const extracted = baggageCtx({ team: "a" });
    expect(hasNewBaggage(ROOT_CONTEXT, extracted)).toBe(true);
    expect(hasNewBaggage(ROOT_CONTEXT, ROOT_CONTEXT)).toBe(false);
    const merged = mergeBaggage(baggageCtx({ base: "x" }), extracted);
    expect(baggageValue(merged, "team")).toBe("a");
    expect(baggageValue(merged, "base")).toBe("x");
    // key 衝突は merge 先（extracted）が勝つ
    const conflicted = mergeBaggage(baggageCtx({ team: "base" }), extracted);
    expect(baggageValue(conflicted, "team")).toBe("a");
    // preserveBaseBaggage は base 側の entry を union で残す（衝突は carrier 側 onto が勝つ）
    const preserved = preserveBaseBaggage(extracted, baggageCtx({ team: "base", b: "1" }));
    expect(baggageValue(preserved, "b")).toBe("1");
    expect(baggageValue(preserved, "team")).toBe("a");
  });
});

describe("globalPropagatorHasXray", () => {
  it("w3c 構成では false", () => {
    expect(globalPropagatorHasXray()).toBe(false);
  });
});
