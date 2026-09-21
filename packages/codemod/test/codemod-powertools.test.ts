import { describe, expect, it } from "vitest";
import { transformSource } from "../src/index.js";
import { manualFindings } from "./helpers.js";

describe("Powertools Tracer → sekimori/tracer (DEC-003)", () => {
  it("swaps the import and new Tracer() for createTracer()", () => {
    const src = `import { Tracer } from "@aws-lambda-powertools/tracer";
const tracer = new Tracer({ serviceName: "orders" });
tracer.putAnnotation("k", 1);
`;
    const out = transformSource(src);
    expect(out.code).toContain('from "sekimori/tracer"');
    expect(out.code).toContain('createTracer("orders")');
    expect(out.code).toContain('tracer.putAnnotation("k", 1)');
    expect(out.code).not.toContain("@aws-lambda-powertools/tracer");
    expect(manualFindings(src)).toHaveLength(0);
  });

  it("keeps other Powertools specifiers on the original import", () => {
    const src = `import { Tracer, captureLambdaHandler } from "@aws-lambda-powertools/tracer";
const tracer = new Tracer();
`;
    const out = transformSource(src);
    expect(out.code).toContain(
      'import { captureLambdaHandler } from "@aws-lambda-powertools/tracer"',
    );
    expect(out.code).toContain('from "sekimori/tracer"');
  });

  it("flags dropped Tracer options", () => {
    const src = `import { Tracer } from "@aws-lambda-powertools/tracer";
const tracer = new Tracer({ serviceName: "s", captureHTTPsGlobal: true });
`;
    expect(manualFindings(src).map((f) => f.construct)).toContain("new Tracer(options)");
  });

  it("flags shim-unsupported methods", () => {
    const src = `import { Tracer } from "@aws-lambda-powertools/tracer";
const tracer = new Tracer();
tracer.annotateColdStart();
tracer.addResponseAsMetadata({ a: 1 });
`;
    const constructs = manualFindings(src).map((f) => f.construct);
    expect(constructs).toContain("tracer.annotateColdStart");
    expect(constructs).toContain("tracer.addResponseAsMetadata");
  });

  it("maps the Tracer type annotation to SekimoriTracer", () => {
    const src = `import { Tracer } from "@aws-lambda-powertools/tracer";
const t: Tracer = new Tracer();
`;
    const out = transformSource(src);
    expect(out.code).toContain("SekimoriTracer");
    expect(out.code).toContain("type SekimoriTracer");
  });

  it("does not rewrite `new Tracer` when it is not bound to Powertools", () => {
    const src = `class Tracer { constructor(public name: string) {} }
const t = new Tracer("mine");
`;
    const out = transformSource(src);
    expect(out.code).toContain('new Tracer("mine")');
    expect(out.code).not.toContain("createTracer");
    expect(out.findings).toHaveLength(0);
  });

  it("flags a default-imported Powertools Tracer without breaking the code", () => {
    const src = `import Tracer from "@aws-lambda-powertools/tracer";
const t = new Tracer({ serviceName: "s" });
`;
    const out = transformSource(src);
    expect(out.code).toContain('new Tracer({ serviceName: "s" })');
    expect(out.code).not.toContain("createTracer");
    expect(manualFindings(src).map((f) => f.construct)).toContain("new Tracer");
  });

  it("flags namespace-imported Tracer (new pt.Tracer)", () => {
    const src = `import * as pt from "@aws-lambda-powertools/tracer";
const t = new pt.Tracer();
`;
    const out = transformSource(src);
    expect(out.code).toContain("new pt.Tracer()");
    expect(out.code).not.toContain("createTracer");
    expect(manualFindings(src).map((f) => f.construct)).toContain("new pt.Tracer");
  });

  it("flags an aliased Powertools Tracer import and its new expression", () => {
    const src = `import { Tracer as PT } from "@aws-lambda-powertools/tracer";
const t = new PT({ serviceName: "s" });
`;
    const out = transformSource(src);
    expect(out.code).toContain('new PT({ serviceName: "s" })');
    expect(out.code).not.toContain("createTracer");
    expect(manualFindings(src).map((f) => f.construct)).toContain("new PT");
  });

  it("flags `new` on a type-only Tracer import while still mapping the type annotation", () => {
    const src = `import { type Tracer } from "@aws-lambda-powertools/tracer";
let t: Tracer;
const u = new Tracer();
`;
    const out = transformSource(src);
    expect(out.code).toContain("let t: SekimoriTracer");
    expect(out.code).toContain("new Tracer()");
    expect(out.code).not.toContain("createTracer(");
    expect(manualFindings(src).map((f) => f.construct)).toContain("new Tracer");
  });

  it("adds the shim import only once for duplicate Powertools import declarations", () => {
    const src = `import { Tracer } from "@aws-lambda-powertools/tracer";
import { Tracer } from "@aws-lambda-powertools/tracer";
const t = new Tracer();
`;
    const out = transformSource(src);
    expect(out.code.match(/from "sekimori\/tracer"/g)).toHaveLength(1);
    expect(out.code).toContain("createTracer()");
  });

  it("inserts generated imports with the import block, not at the end of the file", () => {
    const src = `import { Tracer } from "@aws-lambda-powertools/tracer";
const t = new Tracer();
export const answer = 42;
`;
    const out = transformSource(src);
    expect(out.code.indexOf('from "sekimori/tracer"')).toBeLessThan(out.code.indexOf("const t"));
  });
});
