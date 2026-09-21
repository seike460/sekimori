import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeTemplateFile, formatDoctorReport, formatFunctionReport } from "../src/index.js";

const tmp = () => mkdtempSync(join(tmpdir(), "sekimori-doctor-"));

describe("analyzeTemplateFile", () => {
  it("rejects invalid JSON with a hint about cdk.out", async () => {
    const path = join(tmp(), "bad.json");
    writeFileSync(path, "{ not json");
    await expect(analyzeTemplateFile(path)).rejects.toThrow(/not valid JSON/);
  });

  it("rejects a JSON array as not a CloudFormation template", async () => {
    const path = join(tmp(), "arr.json");
    writeFileSync(path, "[]");
    await expect(analyzeTemplateFile(path)).rejects.toThrow(/not a CloudFormation template/);
  });

  it("analyzes a valid template object", async () => {
    const path = join(tmp(), "template.json");
    writeFileSync(path, JSON.stringify({ Resources: {} }));
    const report = await analyzeTemplateFile(path);
    expect(report.functions).toEqual([]);
  });
});

describe("formatDoctorReport", () => {
  const report = {
    functions: [
      {
        name: "fn-a",
        checks: [
          { id: "tracing", status: "pass" as const, message: "ok" },
          { id: "xray-iam", status: "fail" as const, message: "denied" },
        ],
      },
    ],
    notes: ["one note"],
  };

  it("renders check status marks and notes", () => {
    const out = formatDoctorReport(report);
    expect(out).toContain("PASS tracing");
    expect(out).toContain("FAIL xray-iam");
    expect(out).toContain("- one note");
  });

  it("omits the notes block when empty", () => {
    expect(formatDoctorReport({ functions: [], notes: [] })).not.toContain("notes:");
  });

  it("formatFunctionReport pads check ids", () => {
    const out = formatFunctionReport(report.functions[0]!);
    expect(out.split("\n")[0]).toBe("fn-a");
  });
});
