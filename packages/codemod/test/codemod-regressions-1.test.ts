import { describe, expect, it } from "vitest";
import { transformSource } from "../src/index.js";
import { manualFindings } from "./helpers.js";

describe("Round-5 codemod fixes", () => {
  it("flags named-import member calls like plugins.whitelist() (R5-B-1)", () => {
    // named import の `name.method(...)` は call ループの対象外 — leftover finding に落とす。
    const src = `import { plugins } from "aws-xray-sdk-core";
plugins.whitelist(["x"]);
`;
    const out = transformSource(src);
    expect(out.findings.some((f) => f.kind === "manual" && f.construct === "plugins")).toBe(true);
  });

  it("flags named-import member access like captureFunc.bind (R5-B-1)", () => {
    const src = `import { captureFunc } from "aws-xray-sdk-core";
const f = captureFunc.bind(null);
`;
    const out = transformSource(src);
    expect(out.findings.some((f) => f.kind === "manual")).toBe(true);
    // コードは残る — import 削除で broken reference にならないよう finding で通知する。
    expect(out.code).toContain("captureFunc.bind");
  });

  it("does not reuse a type-only `trace` specifier for generated code (R5-B-5)", () => {
    const src = `import { type trace } from "@opentelemetry/api";
import AWSXRay from "aws-xray-sdk-core";
AWSXRay.captureFunc("f", (s) => s.close());
`;
    const out = transformSource(src);
    // type-only specifier は value binding を作らない — fresh 名で参照する。
    expect(out.code).toContain("trace as otelTrace");
    expect(out.code).toContain("otelTrace.getTracer");
  });

  it("flags dynamic import() of migrated modules (R5-B-7)", () => {
    const src = `export async function f() {
  const xray = await import("aws-xray-sdk-core");
  const pt = await import("@aws-lambda-powertools/tracer");
}
`;
    const constructs = manualFindings(src).map((f) => f.construct);
    expect(constructs).toContain('import("aws-xray-sdk-core")');
    expect(constructs).toContain('import("@aws-lambda-powertools/tracer")');
  });

  it("does not rewrite a same-text receiver bound in another scope (R5-B-8)", () => {
    // `x.seg` は member 名が any 上で解決不能 — root の `x` は別 param。
    const src = `import AWSXRay from "aws-xray-sdk-core";
function a(x: any) { x.seg = AWSXRay.getSegment(); }
function b(x: any) { x.seg.close(); }
`;
    const out = transformSource(src);
    // b の `x.seg` は別 binding — `x.seg?.end()` に書き換えない。
    expect(out.code).toContain("x.seg.close()");
    expect(out.code).not.toContain("x.seg?.end()");
  });

  it("still rewrites a same-text receiver when the root binding matches (R5-B-8)", () => {
    // 同一関数内の `x.seg` は同じ root binding — rewrite してよい。
    const src = `import AWSXRay from "aws-xray-sdk-core";
function a(x: any) {
  x.seg = AWSXRay.getSegment();
  x.seg.close();
}
`;
    const out = transformSource(src);
    expect(out.code).toContain("x.seg?.end()");
  });

  it("does not track bindings of a resolveSegment left for manual migration (R5-B-9)", () => {
    // `resolveSegment(arg)` は manual — X-Ray のまま残る。束縛先の `seg.close()` を
    // `seg?.end()` にすると manual 解決（X-Ray のまま残す）が壊れる。
    const src = `import AWSXRay from "aws-xray-sdk-core";
const seg = AWSXRay.resolveSegment(parent);
seg.close();
`;
    const out = transformSource(src);
    expect(out.code).toContain("seg.close()");
    expect(out.code).not.toContain("seg?.end()");
  });

  it("does not double-report a bare decorator member access (R5-B-12)", () => {
    const src = `import { Tracer } from "@aws-lambda-powertools/tracer";
const tracer = new Tracer();
class S {
  @tracer.captureLambdaHandler
  m() {}
}
`;
    const out = transformSource(src);
    const count = out.findings.filter((f) => f.construct.includes("captureLambdaHandler")).length;
    expect(count).toBe(1);
  });

  it("does not flag a member NAME matching an xray alias (obj.AWSXRay) (R5-B-12)", () => {
    const src = `import AWSXRay from "aws-xray-sdk-core";
AWSXRay.getSegment();
const obj = { AWSXRay: 1 };
console.log(obj.AWSXRay);
`;
    const out = transformSource(src);
    // `obj.AWSXRay` の member 名位置は X-Ray の binding 参照ではない。
    const leftovers = out.findings.filter(
      (f) => f.kind === "manual" && f.message.includes("leftover"),
    );
    expect(leftovers).toHaveLength(0);
  });
});

describe("Round-6 codemod fixes", () => {
  it("keeps captureFunc synchronous while auto-closing the span (R6-B-1)", () => {
    // X-Ray の captureFunc は同期で値を返す — async wrapper にすると壊れる。
    const src = `import AWSXRay from "aws-xray-sdk-core";
const v = AWSXRay.captureFunc("job", (sub) => compute(sub));
`;
    const out = transformSource(src);
    expect(out.code).toContain('startActiveSpan("job", (span) => {');
    expect(out.code).not.toContain("async (span)");
    expect(out.code).toContain("return ((sub) => compute(sub))(span)");
    expect(out.code).toContain("if (span.isRecording()) span.end()");
  });

  it("auto-closes captureAsyncFunc spans on success and error (R6-B-1)", () => {
    // startActiveSpan は span を自動 end しない — wrapper が X-Ray の auto-close を再現する。
    const src = `import { captureAsyncFunc } from "aws-xray-sdk-core";
await captureAsyncFunc("job", async (sub) => { sub.close(); });
`;
    const out = transformSource(src);
    expect(out.code).toContain("async (span) => {");
    expect(out.code).toContain("return await (async (sub) => { sub.end(); })(span)");
    expect(out.code).toContain("span.recordException(e instanceof Error ? e : String(e))");
    expect(out.code).toContain("if (span.isRecording()) span.end()");
  });

  it("expands segment.addError into recordException + setStatus(ERROR) (R6-B-2)", () => {
    // recordException だけでは span が error にならない — X-Ray の addError は
    // error flag を立てるため 2 文に展開する。
    const src = `import AWSXRay from "aws-xray-sdk-core";
const seg = AWSXRay.getSegment();
seg.addError(new Error("boom"));
`;
    const out = transformSource(src);
    expect(out.code).toContain('seg?.recordException(new Error("boom"))');
    expect(out.code).toContain("seg?.setStatus({ code: SpanStatusCode.ERROR })");
    expect(out.code).toContain('SpanStatusCode } from "@opentelemetry/api"');
  });

  it("does not rewrite addError's second `remote` flag into recordException's timestamp (R6-B-2)", () => {
    const src = `import AWSXRay from "aws-xray-sdk-core";
const seg = AWSXRay.getSegment();
seg.addError(new Error("x"), true);
`;
    const out = transformSource(src);
    expect(out.code).toContain('seg.addError(new Error("x"), true)');
    expect(manualFindings(src).map((f) => f.construct)).toContain("segment.addError");
  });

  it("flags expression-position addError instead of inlining a broken expansion (R6-B-2)", () => {
    const src = `import AWSXRay from "aws-xray-sdk-core";
const seg = AWSXRay.getSegment();
const r = [seg.addError(new Error("x"))];
`;
    expect(manualFindings(src).map((f) => f.construct)).toContain("segment.addError");
  });

  it("preserves primitive metadata types instead of stringifying (R6-B-3)", () => {
    const src = `import AWSXRay from "aws-xray-sdk-core";
AWSXRay.captureFunc("x", (sub) => {
  sub.addMetadata("n", 42);
  sub.addMetadata("s", "v");
  sub.addMetadata("b", true);
});
`;
    const out = transformSource(src);
    expect(out.code).toContain('sub.setAttribute("metadata.n", 42)');
    expect(out.code).toContain('sub.setAttribute("metadata.s", "v")');
    expect(out.code).toContain('sub.setAttribute("metadata.b", true)');
    expect(out.code).not.toContain("JSON.stringify");
  });

  it("flags bare segment references and element access inside capture callbacks (R6-B-4)", () => {
    const src = `import AWSXRay from "aws-xray-sdk-core";
AWSXRay.captureFunc("x", (sub) => {
  helper(sub);
  sub["close"]();
});
`;
    const findings = manualFindings(src);
    expect(findings.map((f) => f.construct)).toContain("segment sub");
    expect(findings.map((f) => f.construct)).toContain("sub[...]");
  });

  it("flags arguments-object access on the segment parameter (R6-B-4)", () => {
    const src = `import AWSXRay from "aws-xray-sdk-core";
AWSXRay.captureFunc("x", function (sub) {
  arguments[0].close();
});
`;
    const out = transformSource(src);
    expect(manualFindings(src).map((f) => f.construct)).toContain("arguments[0]");
    expect(out.code).toContain("arguments[0].close()");
  });

  it("does not treat a nested function's arguments as the segment parameter (R6-B-4)", () => {
    const src = `import AWSXRay from "aws-xray-sdk-core";
AWSXRay.captureFunc("x", function (sub) {
  function inner() { return arguments[0]; }
  inner();
});
`;
    const findings = manualFindings(src);
    expect(findings.map((f) => f.construct)).not.toContain("arguments[0]");
  });

  it("does not rewrite segment methods after the receiver is reassigned (R6-B-5)", () => {
    // `seg = getSegment(); seg = other; seg.close()` — 再代入後の close は
    // 追跡した segment を指さないので書き換えず manual に倒す。
    const src = `import AWSXRay from "aws-xray-sdk-core";
let seg = AWSXRay.getSegment();
seg = other;
seg.close();
`;
    const out = transformSource(src);
    expect(out.code).toContain("seg.close()");
    expect(out.code).not.toContain("seg?.end()");
    expect(manualFindings(src).map((f) => f.construct)).toContain("segment.close");
  });

  it("still rewrites when the only assignment is the getSegment binding (R6-B-5)", () => {
    const src = `import AWSXRay from "aws-xray-sdk-core";
let seg;
seg = AWSXRay.getSegment();
seg.close();
`;
    const out = transformSource(src);
    expect(out.code).toContain("seg?.end()");
  });

  it("detects require/import with template literals (R6-B-6)", () => {
    const src = `const x = require(\`aws-xray-sdk-core\`);
const y = await import(\`@aws-lambda-powertools/tracer\`);
`;
    const findings = manualFindings(src);
    expect(findings.map((f) => f.construct)).toContain('require("aws-xray-sdk-core")');
    expect(findings.map((f) => f.construct)).toContain('import("@aws-lambda-powertools/tracer")');
  });
});

describe("Round-7 hardening", () => {
  it("addError emits a block so a following `(`-statement is not merged (R7-B)", () => {
    // `setStatus({...})\n(foo)()` は ASI が効かず `setStatus({...})(foo)()` に結合する。
    // 2 文展開は Block で包む — `}` は文を終えるため後続の `(`-statement と結合しない。
    const src = `import AWSXRay from "aws-xray-sdk-core";
const seg = AWSXRay.getSegment();
seg.addError(err);
(foo)();
`;
    const out = transformSource(src);
    expect(out.code).toContain("setStatus({ code:");
    expect(out.code).toMatch(/setStatus\(\{ code: [A-Za-z]+\.ERROR \}\);\n\}\n\(foo\)\(\)/);
  });

  it("captureAsyncFunc picks a fresh span param name when `span` is taken (R7-B)", () => {
    // 生成 param `span` が callback 内の自由変数 `span` を capture しないよう改名する。
    const src = `import AWSXRay from "aws-xray-sdk-core";
const span = outerThing;
AWSXRay.captureAsyncFunc("x", async (sub) => {
  span.doThing();
  sub.close();
});
`;
    const out = transformSource(src);
    expect(out.code).not.toContain("(span) =>");
    // callback 内の自由変数 `span` はそのまま残る
    expect(out.code).toContain("span.doThing()");
    expect(out.code).toMatch(/\(otelSpan\) =>/);
  });

  it("flags extra arguments to captureHTTPsGlobal as manual (R7-B)", () => {
    const src = `import AWSXRay from "aws-xray-sdk-core";
AWSXRay.captureHTTPsGlobal(http, true, cb);
`;
    const findings = manualFindings(src);
    expect(findings.map((f) => f.construct)).toContain("AWSXRay.captureHTTPsGlobal(arg, ...)");
  });

  it("rewrites `getSegment()!.close()` chain receivers (R7-B)", () => {
    const src = `import AWSXRay from "aws-xray-sdk-core";
AWSXRay.getSegment()!.close();
`;
    const out = transformSource(src);
    expect(out.code).toContain("getActiveSpan()?.end()");
  });
});
