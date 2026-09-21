import { describe, expect, it } from "vitest";
import { assertProbeId, PROBE_ID_PATTERN } from "./probe-id.js";

describe("assertProbeId", () => {
  it("accepts ids within the safe character set", () => {
    for (const id of ["probe-123", "abc_DEF-9", "A0_-z", "0".repeat(128)]) {
      expect(() => assertProbeId(id)).not.toThrow();
      expect(PROBE_ID_PATTERN.test(id)).toBe(true);
    }
  });

  it("rejects characters that would break query syntax or filenames", () => {
    // `"` は Logs Insights の filter 文字列を、空白・`/`・`;` は filename を壊す。
    for (const id of ['x" | drop', "a b", "a/b", "a;b", "a`b", "probe\tid"]) {
      expect(() => assertProbeId(id)).toThrow(/unsafe characters/);
      expect(PROBE_ID_PATTERN.test(id)).toBe(false);
    }
  });

  it("rejects empty, overlong, and non-alphanumeric-leading ids", () => {
    for (const id of ["", "-lead", "_lead", "0".repeat(129)]) {
      expect(() => assertProbeId(id)).toThrow(/unsafe characters/);
    }
  });
});
