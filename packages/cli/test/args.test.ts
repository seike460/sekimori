import { describe, expect, it, vi } from "vitest";
import { failWith, tryParse } from "../src/args.js";

describe("tryParse", () => {
  const options = { force: { type: "boolean" }, target: { type: "string" } } as const;

  it("returns parsed values and positionals", () => {
    const result = tryParse(["--force", "--target", "prod", "file.ts"], options);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.parsed.values).toEqual({ force: true, target: "prod" });
      expect(result.parsed.positionals).toEqual(["file.ts"]);
    }
  });

  it("returns the error message instead of throwing on unknown flags", () => {
    const result = tryParse(["--nope"], options);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("nope");
  });

  it("rejects a boolean flag given a value type mismatch", () => {
    const result = tryParse(["--target"], options);
    expect(result.ok).toBe(false);
  });
});

describe("failWith", () => {
  it("writes one stderr line and returns exit code 2", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(failWith("boom", "sekimori doctor")).toBe(2);
      expect(write).toHaveBeenCalledWith("sekimori doctor: boom\n");
    } finally {
      write.mockRestore();
    }
  });
});
