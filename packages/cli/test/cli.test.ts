import { describe, expect, it } from "vitest";
import { main } from "../src/index.js";
import { captureStdio } from "./helpers.js";

describe("sekimori cli", () => {
  it("no command prints usage and exits 2", async () => {
    const io = captureStdio();
    const code = await main([]);
    io.restore();
    expect(code).toBe(2);
    expect(io.stdout()).toContain("Usage: sekimori");
  });

  it("--help prints usage and exits 0", async () => {
    const io = captureStdio();
    const code = await main(["--help"]);
    io.restore();
    expect(code).toBe(0);
    expect(io.stdout()).toContain("Usage: sekimori");
  });

  it("unknown command exits 2", async () => {
    const io = captureStdio();
    const code = await main(["bogus"]);
    io.restore();
    expect(code).toBe(2);
    expect(io.stderr()).toContain('unknown command "bogus"');
  });

  it("probe prints the how-to and exits 0", async () => {
    const io = captureStdio();
    const code = await main(["probe"]);
    io.restore();
    expect(code).toBe(0);
    expect(io.stdout()).toContain("pnpm --filter @sekimori/probe run deploy");
  });
});

describe("command dispatch hardening", () => {
  it.each(["__proto__", "constructor", "toString", "hasOwnProperty"])(
    "inherited property name %s is not a command (exits 2)",
    async (command) => {
      const io = captureStdio();
      const code = await main([command]);
      io.restore();
      expect(code).toBe(2);
      expect(io.stderr()).toContain(`unknown command "${command}"`);
    },
  );
});
