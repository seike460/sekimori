import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";
import { insertImport, pickFreshName, resolveImportedName } from "../src/transform-imports.js";

const project = new Project({ useInMemoryFileSystem: true });
const sf = (source: string) =>
  project.createSourceFile(`t${Math.random().toString(36).slice(2)}.ts`, source, {
    overwrite: true,
  });

describe("pickFreshName", () => {
  it("returns the first candidate when nothing collides", () => {
    expect(pickFreshName(sf("const x = 1;\n"), "trace", ["trace", "otelTrace"])).toBe("trace");
  });

  it("skips candidates that collide with an identifier", () => {
    const f = sf("const trace = 1;\n");
    expect(pickFreshName(f, "trace", ["trace", "otelTrace"])).toBe("otelTrace");
  });

  it("falls back to base2/base3 when every candidate is taken", () => {
    const f = sf("const trace = 1;\nconst otelTrace = 2;\nconst trace2 = 3;\n");
    expect(pickFreshName(f, "trace", ["trace", "otelTrace"])).toBe("trace3");
  });
});

describe("insertImport", () => {
  it("appends after the last existing import", () => {
    const f = sf('import a from "a";\nconst x = 1;\n');
    insertImport(f, "@opentelemetry/api", ["trace"]);
    expect(f.getFullText()).toBe(
      'import a from "a";\nimport { trace } from "@opentelemetry/api";\n\nconst x = 1;\n',
    );
  });

  it("keeps a shebang as the first line", () => {
    const f = sf("#!/usr/bin/env node\nconst x = 1;\n");
    insertImport(f, "mod", ["m"]);
    expect(f.getFullText().startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(f.getFullText()).toContain('import { m } from "mod";');
  });

  it("does not insert before the directive prologue", () => {
    const f = sf('"use strict";\nconst x = 1;\n');
    insertImport(f, "mod", ["m"]);
    const text = f.getFullText();
    expect(text.indexOf('"use strict"')).toBeLessThan(text.indexOf("import"));
  });
});

describe("resolveImportedName", () => {
  it("reuses an existing bound named import", () => {
    const f = sf('import { trace } from "@opentelemetry/api";\ntrace();\n');
    expect(resolveImportedName(f, "@opentelemetry/api", "trace", ["otelTrace"])).toEqual({
      name: "trace",
      bound: true,
      exportName: "trace",
    });
  });

  it("reuses the alias of an existing aliased import", () => {
    const f = sf('import { trace as t } from "@opentelemetry/api";\nt();\n');
    expect(resolveImportedName(f, "@opentelemetry/api", "trace", ["otelTrace"])).toEqual({
      name: "t",
      bound: true,
      exportName: "trace",
    });
  });

  it("skips a type-only named import — it binds no value", () => {
    const f = sf('import { type trace } from "@opentelemetry/api";\n');
    const r = resolveImportedName(f, "@opentelemetry/api", "trace", ["otelTrace"]);
    expect(r.bound).toBe(false);
  });

  it("returns a fresh name when the imported name is shadowed in an inner scope", () => {
    const f = sf(
      'import { trace } from "@opentelemetry/api";\nfunction f(trace: number) { return trace; }\n',
    );
    const r = resolveImportedName(f, "@opentelemetry/api", "trace", ["otelTrace"]);
    expect(r).toEqual({ name: "otelTrace", bound: false, exportName: "trace" });
  });
});
