import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { main } from "../src/index.js";
import { MANUAL_SOURCE, XRAY_SOURCE } from "./fixtures.js";
import { captureStdio, fixture, tmpDir } from "./helpers.js";

describe("sekimori migrate", () => {
  it("no paths exits 2", async () => {
    const io = captureStdio();
    const code = await main(["migrate"]);
    io.restore();
    expect(code).toBe(2);
    expect(io.stderr()).toContain("no paths given");
  });

  it("dry-run reports changes without writing", async () => {
    const dir = tmpDir();
    const file = fixture(dir, "handler.ts", XRAY_SOURCE);
    const io = captureStdio();
    const code = await main(["migrate", dir]);
    io.restore();
    expect(code).toBe(0);
    expect(io.stdout()).toContain("Dry-run");
    expect(readFileSync(file, "utf8")).toBe(XRAY_SOURCE);
  });

  it("--write rewrites the file", async () => {
    const dir = tmpDir();
    const file = fixture(dir, "handler.ts", XRAY_SOURCE);
    const io = captureStdio();
    const code = await main(["migrate", dir, "--write"]);
    io.restore();
    expect(code).toBe(0);
    const after = readFileSync(file, "utf8");
    expect(after).toContain("trace.getActiveSpan()");
    expect(after).not.toContain("aws-xray-sdk-core");
  });

  it("manual findings exit 1", async () => {
    const dir = tmpDir();
    fixture(dir, "handler.ts", MANUAL_SOURCE);
    const io = captureStdio();
    const code = await main(["migrate", dir]);
    io.restore();
    expect(code).toBe(1);
    expect(io.stdout()).toContain("manual");
  });

  it("--json prints the migration report", async () => {
    const dir = tmpDir();
    fixture(dir, "handler.ts", XRAY_SOURCE);
    const io = captureStdio();
    const code = await main(["migrate", dir, "--json"]);
    io.restore();
    expect(code).toBe(0);
    const report = JSON.parse(io.stdout()) as { files: unknown[] };
    expect(report.files).toHaveLength(1);
  });

  it("an unknown flag exits 2 with usage instead of crashing", async () => {
    const io = captureStdio();
    const code = await main(["migrate", "src", "--bogus"]);
    io.restore();
    expect(code).toBe(2);
    expect(io.stderr()).toContain("Usage: sekimori migrate");
  });

  it("--help prints subcommand usage and exits 0", async () => {
    const io = captureStdio();
    const code = await main(["migrate", "--help"]);
    io.restore();
    expect(code).toBe(0);
    expect(io.stdout()).toContain("Usage: sekimori migrate");
  });

  it("a missing path exits 2 with a normalized error instead of an uncaught ENOENT (R5-B-6)", async () => {
    const io = captureStdio();
    const code = await main(["migrate", "/no/such/dir/exists"]);
    io.restore();
    expect(code).toBe(2);
    // 例外がそのまま uncaught になるのではなく `sekimori migrate:` prefix の1行エラーに正規化される。
    expect(io.stderr().trim()).toMatch(/^sekimori migrate: /);
    expect(io.stderr().trim().split("\n")).toHaveLength(1);
  });
});
