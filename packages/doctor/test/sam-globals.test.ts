import { describe, expect, it } from "vitest";
import { mergeSamGlobals, unsupportedGlobalKeys } from "../src/sam-globals.js";

describe("unsupportedGlobalKeys", () => {
  it("lists keys SAM Globals does not accept", () => {
    expect(unsupportedGlobalKeys({ Runtime: "nodejs22.x", Bogus: 1, Another: 2 })).toEqual([
      "Bogus",
      "Another",
    ]);
  });

  it("returns [] for undefined or all-supported globals", () => {
    expect(unsupportedGlobalKeys(undefined)).toEqual([]);
    expect(unsupportedGlobalKeys({ Runtime: "nodejs22.x" })).toEqual([]);
  });
});

describe("mergeSamGlobals", () => {
  it("lets the function-side scalar win over the global", () => {
    const { props } = mergeSamGlobals(
      { Runtime: "nodejs20.x", Timeout: 30 },
      { Runtime: "nodejs22.x" },
    );
    expect(props).toEqual({ Runtime: "nodejs22.x", Timeout: 30 });
  });

  it("deep-merges Environment.Variables maps", () => {
    const { props } = mergeSamGlobals(
      { Environment: { Variables: { A: "1", B: "2" } } },
      { Environment: { Variables: { B: "3", C: "4" } } },
    );
    expect(props.Environment).toEqual({ Variables: { A: "1", B: "3", C: "4" } });
  });

  it("concatenates list values with the global first (Layers order)", () => {
    const { props } = mergeSamGlobals({ Layers: ["g1"] }, { Layers: ["o1"] });
    expect(props.Layers).toEqual(["g1", "o1"]);
  });

  it("lets the function side win over a global Ref: AWS::NoValue", () => {
    const noValue = { Ref: "AWS::NoValue" };
    const { props } = mergeSamGlobals(
      { Timeout: noValue, MemorySize: 512 },
      { Runtime: "nodejs22.x", MemorySize: noValue },
    );
    // global の NoValue はそのまま残る（下流の isNoValueRef が未設定として扱う）。
    expect(props.Timeout).toEqual(noValue);
    expect(props.MemorySize).toBe(512);
  });

  it("keeps the function side when a global value is an unresolvable intrinsic", () => {
    const { props, dropped } = mergeSamGlobals(
      { Timeout: { "Fn::If": ["C", 30, 60] } },
      { Timeout: 10 },
    );
    expect(props.Timeout).toBe(10);
    expect(dropped.has("Timeout")).toBe(true);
  });
});
