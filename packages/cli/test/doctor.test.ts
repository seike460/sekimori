import { describe, expect, it } from "vitest";
import { main } from "../src/index.js";
import { BARE_TEMPLATE, READY_TEMPLATE } from "./fixtures.js";
import { captureStdio, fixture, tmpDir } from "./helpers.js";

describe("sekimori doctor", () => {
  it("no target exits 2", async () => {
    const io = captureStdio();
    const code = await main(["doctor"]);
    io.restore();
    expect(code).toBe(2);
    expect(io.stderr()).toContain("--template");
  });

  it("a fully configured template exits 0", async () => {
    const dir = tmpDir();
    const tpl = fixture(dir, "template.json", JSON.stringify(READY_TEMPLATE));
    const io = captureStdio();
    const code = await main(["doctor", "--template", tpl]);
    io.restore();
    expect(code).toBe(0);
    expect(io.stdout()).toContain("ready-fn");
  });

  it("a failing function exits 1", async () => {
    const dir = tmpDir();
    const tpl = fixture(dir, "template.json", JSON.stringify(BARE_TEMPLATE));
    const io = captureStdio();
    const code = await main(["doctor", "--template", tpl]);
    io.restore();
    expect(code).toBe(1);
    expect(io.stdout()).toContain("adot-layer");
  });

  it("--json prints the doctor report", async () => {
    const dir = tmpDir();
    const tpl = fixture(dir, "template.json", JSON.stringify(BARE_TEMPLATE));
    const io = captureStdio();
    const code = await main(["doctor", "--template", tpl, "--json"]);
    io.restore();
    expect(code).toBe(1);
    const report = JSON.parse(io.stdout()) as { functions: { name: string }[] };
    expect(report.functions[0]?.name).toBe("bare-fn");
  });

  it("an unknown flag exits 2 with usage", async () => {
    const io = captureStdio();
    const code = await main(["doctor", "--bogus"]);
    io.restore();
    expect(code).toBe(2);
    expect(io.stderr()).toContain("Usage: sekimori doctor");
  });

  it("--help prints subcommand usage and exits 0", async () => {
    const io = captureStdio();
    const code = await main(["doctor", "--help"]);
    io.restore();
    expect(code).toBe(0);
    expect(io.stdout()).toContain("Usage: sekimori doctor");
  });

  it("an empty --function exits 2 without calling AWS", async () => {
    const io = captureStdio();
    const code = await main(["doctor", "--function="]);
    io.restore();
    expect(code).toBe(2);
  });

  it("a missing template file exits 2 with a normalized error (R5-B-6)", async () => {
    const io = captureStdio();
    const code = await main(["doctor", "--template", "/no/such/template.json"]);
    io.restore();
    expect(code).toBe(2);
    expect(io.stderr().trim()).toMatch(/^sekimori doctor: /);
    expect(io.stderr().trim().split("\n")).toHaveLength(1);
  });
});
