import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatReport, migrateFile, migratePaths } from "../src/index.js";
import { MANUAL_SOURCE, tmpTestDir, XRAY_SOURCE } from "./file-seams.js";

describe("migrateFile", () => {
  it("dry-run reports the change without writing", async () => {
    const file = join(tmpTestDir(), "handler.ts");
    writeFileSync(file, XRAY_SOURCE);
    const result = await migrateFile(file);
    expect(result.changed).toBe(true);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(readFileSync(file, "utf8")).toBe(XRAY_SOURCE);
  });

  it("write:true rewrites the file", async () => {
    const file = join(tmpTestDir(), "handler.ts");
    writeFileSync(file, XRAY_SOURCE);
    const result = await migrateFile(file, { write: true });
    expect(result.changed).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("trace.getActiveSpan()");
  });

  it("untouched source reports changed=false", async () => {
    const file = join(tmpTestDir(), "clean.ts");
    writeFileSync(file, "export const x = 1;\n");
    const result = await migrateFile(file);
    expect(result.changed).toBe(false);
    expect(result.findings).toHaveLength(0);
  });
});

describe("migratePaths", () => {
  it("collects .ts recursively, skipping node_modules/dist/.d.ts/.js", async () => {
    const root = tmpTestDir();
    writeFileSync(join(root, "a.ts"), XRAY_SOURCE);
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", "b.ts"), XRAY_SOURCE);
    mkdirSync(join(root, "node_modules", "x"), { recursive: true });
    writeFileSync(join(root, "node_modules", "x", "inner.ts"), XRAY_SOURCE);
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist", "built.ts"), XRAY_SOURCE);
    writeFileSync(join(root, "types.d.ts"), XRAY_SOURCE);
    writeFileSync(join(root, "script.js"), XRAY_SOURCE);

    const result = await migratePaths([root]);
    expect(result.files).toHaveLength(2);
    expect(result.files.map((f) => f.path).sort()).toEqual(
      [join(root, "a.ts"), join(root, "sub", "b.ts")].sort(),
    );
    for (const f of result.findings) {
      expect(typeof f.file).toBe("string");
    }
  });

  it("respects .gitignore files in the scanned directory", async () => {
    const root = tmpTestDir();
    writeFileSync(join(root, ".gitignore"), "generated/\n");
    writeFileSync(join(root, "a.ts"), XRAY_SOURCE);
    mkdirSync(join(root, "generated"));
    writeFileSync(join(root, "generated", "skip-me.ts"), XRAY_SOURCE);
    const result = await migratePaths([root]);
    expect(result.files.map((f) => f.path)).toEqual([join(root, "a.ts")]);
  });

  it("respects .gitignore files nested in subdirectories", async () => {
    const root = tmpTestDir();
    writeFileSync(join(root, "a.ts"), XRAY_SOURCE);
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", ".gitignore"), "ignored.ts\n");
    writeFileSync(join(root, "sub", "ignored.ts"), XRAY_SOURCE);
    writeFileSync(join(root, "sub", "kept.ts"), XRAY_SOURCE);
    const result = await migratePaths([root]);
    expect(result.files.map((f) => f.path).sort()).toEqual(
      [join(root, "a.ts"), join(root, "sub", "kept.ts")].sort(),
    );
  });

  it("accepts a single file path", async () => {
    const file = join(tmpTestDir(), "handler.ts");
    writeFileSync(file, XRAY_SOURCE);
    const result = await migratePaths([file]);
    expect(result.files).toHaveLength(1);
  });

  it("aggregates findings across files", async () => {
    const root = tmpTestDir();
    writeFileSync(join(root, "a.ts"), XRAY_SOURCE);
    writeFileSync(join(root, "b.ts"), MANUAL_SOURCE);
    const result = await migratePaths([root]);
    expect(result.files).toHaveLength(2);
    expect(result.findings.some((f) => f.kind === "manual")).toBe(true);
  });
});

describe("formatReport", () => {
  it("summarises files and marks manual findings", async () => {
    const root = tmpTestDir();
    writeFileSync(join(root, "a.ts"), XRAY_SOURCE);
    writeFileSync(join(root, "b.ts"), MANUAL_SOURCE);
    const report = formatReport(await migratePaths([root]));
    expect(report).toContain("2 file(s) scanned");
    expect(report).toContain("manual");
    expect(report).toContain("need manual work");
  });

  it("empty result renders a header only", () => {
    const report = formatReport({ files: [], findings: [], scanned: 0 });
    expect(report).toContain("0 file(s) scanned");
  });
});
