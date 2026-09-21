import { describe, expect, it } from "vitest";
import { linkedFromRows, linkSpanIds, type SpanRow } from "./transaction-search.js";

const emitter = (spanId: string, traceId = "t1"): SpanRow => ({
  name: "emit",
  spanId,
  traceId,
});

const consumer = (over: Partial<SpanRow> = {}): SpanRow => ({
  name: "process queue",
  spanId: "c1",
  traceId: "t1",
  ...over,
});

describe("linkSpanIds", () => {
  it("collects link0 and every spanId/id inside the links JSON", () => {
    const ids = linkSpanIds({
      link0: "a",
      links: JSON.stringify([{ spanId: "b" }, { id: "c" }, { other: "x" }]),
    });
    expect(ids).toEqual(new Set(["a", "b", "c"]));
  });

  it("accepts a single-object links value", () => {
    expect(linkSpanIds({ links: `{"spanId":"x"}` })).toEqual(new Set(["x"]));
  });

  it("falls back to link0 when links is not JSON", () => {
    expect(linkSpanIds({ link0: "a", links: "not-json" })).toEqual(new Set(["a"]));
  });

  it("returns an empty set when no link fields exist", () => {
    expect(linkSpanIds({})).toEqual(new Set());
  });
});

describe("linkedFromRows", () => {
  it("detects a consumer linked via links JSON to an emitter span", () => {
    const result = linkedFromRows([
      emitter("e1"),
      consumer({ links: JSON.stringify([{ spanId: "e1" }]) }),
    ]);
    expect(result.linked).toBe(true);
  });

  it("detects a consumer parented directly on the emitter span", () => {
    const result = linkedFromRows([emitter("e1"), consumer({ parentSpanId: "e1" })]);
    expect(result.linked).toBe(true);
  });

  it("matches the producerSpanId returned by the emitter response", () => {
    const result = linkedFromRows([consumer({ link0: "injected" })], "injected");
    expect(result.linked).toBe(true);
  });

  it("does not count same-trace membership without a link as linked", () => {
    const result = linkedFromRows([emitter("e1"), consumer({})]);
    expect(result.linked).toBe(false);
    expect(result.sameTrace).toBe(true);
  });

  it("ignores empty-string field collisions", () => {
    const result = linkedFromRows([emitter("e1"), consumer({ parentSpanId: "", link0: "" })]);
    expect(result.linked).toBe(false);
  });

  it("reports linkFieldsPresent=false when no consumer row has link data", () => {
    const result = linkedFromRows([emitter("e1"), consumer({})]);
    expect(result.linkFieldsPresent).toBe(false);
    expect(linkedFromRows([emitter("e1"), consumer({ link0: "e1" })]).linkFieldsPresent).toBe(true);
  });
});
