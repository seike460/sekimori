import { type Context, propagation, ROOT_CONTEXT, TraceFlags, trace } from "@opentelemetry/api";
import { afterEach, describe, expect, it } from "vitest";
import {
  CarrierStash,
  EMPTY_CARRIER_PLAN,
  injectCarrier,
  mergeObjectCarrier,
  type ObjectCarrierPlan,
  parseJsonObject,
  planObjectCarrier,
} from "../src/object-carrier.js";
import { setupOtel } from "./otel-setup.js";

const harness = setupOtel("w3c");
afterEach(() => harness.reset());

const SPAN = {
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  spanId: "00f067aa0ba902b7",
  traceFlags: TraceFlags.SAMPLED,
  isRemote: true,
};
const OTHER_TRACE = "000000000000000000000000000000ff";
const TP = `00-${SPAN.traceId}-${SPAN.spanId}-01`;

const spanCtx = (traceId = SPAN.traceId): Context =>
  trace.setSpanContext(ROOT_CONTEXT, { ...SPAN, traceId });

const baggageCtx = (entries: Record<string, string>): Context =>
  propagation.setBaggage(
    ROOT_CONTEXT,
    propagation.createBaggage(
      Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, { value: v }])),
    ),
  );

const plan = (p: Partial<ObjectCarrierPlan>): ObjectCarrierPlan => ({
  ...EMPTY_CARRIER_PLAN,
  ...p,
});

describe("parseJsonObject", () => {
  it.each([undefined, "", "not json", "[1,2]", "null", '"x"', "42"])(
    "object でない入力 %j は undefined",
    (input) => {
      expect(parseJsonObject(input)).toBeUndefined();
    },
  );
  it("plain object は中身を保って返す", () => {
    expect(parseJsonObject('{"a":1,"b":{"c":2}}')).toEqual({ a: 1, b: { c: 2 } });
  });
});

describe("injectCarrier", () => {
  it("active span の W3C carrier を書く", () => {
    const carrier = injectCarrier(spanCtx(), {});
    expect(carrier.traceparent).toBe(TP);
  });
  it("w3c:false で W3C key を書かない", () => {
    const carrier = injectCarrier(spanCtx(), { w3c: false });
    expect(carrier.traceparent).toBeUndefined();
  });
});

describe("planObjectCarrier", () => {
  it("carrier が W3C を持ち target が pin 無しなら carrierWroteW3c のみ", () => {
    const p = planObjectCarrier({}, { traceparent: TP }, spanCtx(), undefined);
    expect(p).toEqual({ carrierWroteW3c: true, w3cPinned: false, pinnedConflict: false });
  });
  it("呼び出し側 pin + 別 trace で pinnedConflict", () => {
    const pinnedTp = `00-${OTHER_TRACE}-aaaaaaaaaaaaaaaa-01`;
    const p = planObjectCarrier(
      { traceparent: pinnedTp },
      { traceparent: TP },
      spanCtx(),
      undefined,
    );
    expect(p.w3cPinned).toBe(true);
    expect(p.pinnedConflict).toBe(true);
  });
  it("pin が active span と同じ trace なら conflict ではない", () => {
    const p = planObjectCarrier({ traceparent: TP }, { traceparent: TP }, spanCtx(), undefined);
    expect(p).toMatchObject({ w3cPinned: true, pinnedConflict: false });
  });
  it("w3c:false 指定では既存 W3C key を pin とみなさない", () => {
    const p = planObjectCarrier(
      { traceparent: TP },
      { "x-amzn-trace-id": "Root=1-x" },
      spanCtx(),
      false,
    );
    expect(p.w3cPinned).toBe(false);
  });
});

describe("mergeObjectCarrier", () => {
  it("空の target へ carrier を書き込む", () => {
    const target: Record<string, unknown> = {};
    const r = mergeObjectCarrier(
      target,
      { traceparent: TP, baggage: "k=v" },
      plan({ carrierWroteW3c: true }),
    );
    expect(r.wrote).toBe(true);
    expect(target.traceparent).toBe(TP);
    expect(target.baggage).toBe("k=v");
  });
  it("W3C carrier があるとき stale な x-amzn-trace-id を消す", () => {
    const target: Record<string, unknown> = { "x-amzn-trace-id": "Root=1-stale" };
    const r = mergeObjectCarrier(target, { traceparent: TP }, plan({ carrierWroteW3c: true }));
    expect(target["x-amzn-trace-id"]).toBeUndefined();
    expect(r.wrote).toBe(true);
    expect(r.wroteXray).toBe(false);
  });
  it("W3C が無い carrier では x-amzn-trace-id を唯一の context として書く", () => {
    const target: Record<string, unknown> = {};
    const r = mergeObjectCarrier(target, { "x-amzn-trace-id": "Root=1-fresh" }, plan({}));
    expect(target["x-amzn-trace-id"]).toBe("Root=1-fresh");
    expect(r.wroteXray).toBe(true);
  });
  it("w3cPinned のとき carrier の traceparent は書かない（pin 優先）", () => {
    const pinned = `00-${OTHER_TRACE}-bbbbbbbbbbbbbbbb-01`;
    const target: Record<string, unknown> = { traceparent: pinned };
    mergeObjectCarrier(
      target,
      { traceparent: TP },
      plan({ carrierWroteW3c: true, w3cPinned: true }),
    );
    expect(target.traceparent).toBe(pinned);
  });
  it("利用者の既存 key（case-insensitive）は上書きしない", () => {
    const target: Record<string, unknown> = { Baggage: "user=1" };
    mergeObjectCarrier(target, { baggage: "k=v" }, plan({}));
    expect(target.Baggage).toBe("user=1");
    expect(target.baggage).toBeUndefined();
  });
  it("pinnedConflict では pin と別 trace の stale x-amzn-trace-id を消す", () => {
    const pinned = `00-${SPAN.traceId}-bbbbbbbbbbbbbbbb-01`;
    const staleXray = `Root=1-${OTHER_TRACE.slice(0, 8)}-${OTHER_TRACE.slice(8)};Parent=00f067aa0ba902b7`;
    const target: Record<string, unknown> = { traceparent: pinned, "x-amzn-trace-id": staleXray };
    const r = mergeObjectCarrier(
      target,
      { traceparent: TP },
      plan({ carrierWroteW3c: true, w3cPinned: true, pinnedConflict: true }),
    );
    expect(target["x-amzn-trace-id"]).toBeUndefined();
    expect(r.wrote).toBe(true);
  });
  it("変更が無ければ wrote=false", () => {
    const target: Record<string, unknown> = { baggage: "k=v" };
    const r = mergeObjectCarrier(target, { baggage: "k=v" }, plan({}));
    expect(r.wrote).toBe(false);
  });
});

describe("CarrierStash", () => {
  it("span context のある carrier は即 hit", () => {
    const stash = new CarrierStash(ROOT_CONTEXT);
    const hit = stash.consider(spanCtx(), "detail");
    expect(hit?.source).toBe("detail");
    expect(hit?.spanContext?.spanId).toBe(SPAN.spanId);
    expect(stash.fallback()).toBeUndefined();
  });
  it("baggage だけの carrier は退避され fallback で返る", () => {
    const stash = new CarrierStash(ROOT_CONTEXT);
    expect(stash.consider(baggageCtx({ team: "a" }), "body")).toBeUndefined();
    const fb = stash.fallback();
    expect(fb?.source).toBe("body");
    expect(fb?.spanContext).toBeUndefined();
    expect(propagation.getBaggage(fb?.context ?? ROOT_CONTEXT)?.getEntry("team")?.value).toBe("a");
  });
  it("退避済み baggage は後続 hit の context に merge される", () => {
    const stash = new CarrierStash(ROOT_CONTEXT);
    stash.consider(baggageCtx({ team: "a" }), "body");
    const hit = stash.consider(spanCtx(), "detail");
    expect(propagation.getBaggage(hit?.context ?? ROOT_CONTEXT)?.getEntry("team")?.value).toBe("a");
  });
  it("context を持たない carrier は退避も hit もしない", () => {
    const stash = new CarrierStash(ROOT_CONTEXT);
    expect(stash.consider(ROOT_CONTEXT, "none")).toBeUndefined();
    expect(stash.fallback()).toBeUndefined();
  });
});
