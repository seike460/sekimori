import { describe, expect, it } from "vitest";
import {
  consumeReportedOuter,
  type Report,
  recordReportedOuter,
  report,
} from "../src/transform-ctx.js";

describe("report", () => {
  it("appends a finding in call order", () => {
    const r: Report = { findings: [] };
    report(r, 3, "manual", "AWSXRay.getSegment", "map by hand");
    report(r, 1, "auto", "import x", "removed");
    expect(r.findings).toEqual([
      { kind: "manual", construct: "AWSXRay.getSegment", line: 3, message: "map by hand" },
      { kind: "auto", construct: "import x", line: 1, message: "removed" },
    ]);
  });
});

describe("recordReportedOuter / consumeReportedOuter", () => {
  it("consumes each recorded key exactly once", () => {
    const map = new Map<string, number>();
    recordReportedOuter(map, "seg|close");
    recordReportedOuter(map, "seg|close");
    expect(consumeReportedOuter(map, "seg|close")).toBe(true);
    expect(consumeReportedOuter(map, "seg|close")).toBe(true);
    expect(consumeReportedOuter(map, "seg|close")).toBe(false);
    // 消費しきった key は 0 に留まり、負数へ行かない。
    expect(map.get("seg|close")).toBe(0);
  });

  it("treats an absent map as a no-op for both record and consume", () => {
    expect(() => recordReportedOuter(undefined, "k")).not.toThrow();
    expect(consumeReportedOuter(undefined, "k")).toBe(false);
  });

  it("keeps unrelated keys independent", () => {
    const map = new Map<string, number>();
    recordReportedOuter(map, "seg|close");
    expect(consumeReportedOuter(map, "seg|end")).toBe(false);
    expect(consumeReportedOuter(map, "seg|close")).toBe(true);
  });
});
