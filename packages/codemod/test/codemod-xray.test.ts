import { describe, expect, it } from "vitest";
import { transformSource } from "../src/index.js";
import { manualFindings } from "./helpers.js";

describe("aws-xray-sdk-core → OpenTelemetry API", () => {
  it("unwraps capture helpers and drops the import", () => {
    const src = `import AWSXRay from "aws-xray-sdk-core";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
const client = AWSXRay.captureAWSv3Client(new DynamoDBClient({}));
`;
    const out = transformSource(src);
    expect(out.code).not.toContain("aws-xray-sdk-core");
    expect(out.code).toContain("const client = new DynamoDBClient({})");
    expect(manualFindings(src)).toHaveLength(0);
  });

  it("maps getSegment() to trace.getActiveSpan() and adds the OTel import", () => {
    const src = `import AWSXRay from "aws-xray-sdk-core";
const seg = AWSXRay.getSegment();
`;
    const out = transformSource(src);
    expect(out.code).toContain('import { trace } from "@opentelemetry/api"');
    expect(out.code).toContain("const seg = trace.getActiveSpan()");
  });

  it("rewrites captureAsyncFunc into startActiveSpan with segment methods mapped", () => {
    const src = `import AWSXRay from "aws-xray-sdk-core";
await AWSXRay.captureAsyncFunc("job", async (sub) => {
  sub.addAnnotation("id", "x");
  sub.addMetadata("cfg", 5);
  sub.close();
});
`;
    const out = transformSource(src);
    expect(out.code).toContain('startActiveSpan("job"');
    expect(out.code).toContain('sub.setAttribute("id", "x")');
    // primitive literal は型を保って写す（`5` を `"5"` にしない）
    expect(out.code).toContain('sub.setAttribute("metadata.cfg", 5)');
    expect(out.code).toContain("sub.end()");
    // X-Ray の auto-close を再現する wrapper: 例外で recordException + setStatus(ERROR)、
    // finally で必ず end（二重 end は isRecording() ガードで防ぐ）
    expect(out.code).toContain("span.recordException(e instanceof Error ? e : String(e))");
    expect(out.code).toContain("code: SpanStatusCode.ERROR");
    expect(out.code).toContain("if (span.isRecording()) span.end()");
    expect(out.code).toContain('import { trace, SpanStatusCode } from "@opentelemetry/api"');
    expect(out.code).not.toContain("close()");
  });

  it("flags unknown AWSXRay calls and leftover references", () => {
    const src = `import AWSXRay from "aws-xray-sdk-core";
AWSXRay.setSegment(seg);
const mw = AWSXRay.express.openSegment("app");
`;
    const findings = manualFindings(src);
    expect(findings.map((f) => f.construct)).toContain("AWSXRay.setSegment");
    expect(findings.some((f) => f.construct === "AWSXRay")).toBe(true);
  });

  it("flags segment methods with no OTel equivalent", () => {
    const src = `import AWSXRay from "aws-xray-sdk-core";
AWSXRay.captureAsyncFunc("x", (sub) => { sub.addNewSubsegment("inner"); });
`;
    expect(manualFindings(src).map((f) => f.construct)).toContain("segment.addNewSubsegment");
  });

  it("rewrites segment methods only on the callback's segment parameter", () => {
    const src = `import AWSXRay from "aws-xray-sdk-core";
const conn = { close: () => {} };
AWSXRay.captureAsyncFunc("x", (seg) => {
  conn.close();
  metrics.incrementCounter("c");
  seg.close();
});
`;
    const out = transformSource(src);
    expect(out.code).toContain("conn.close()");
    expect(out.code).toContain("metrics.incrementCounter");
    expect(out.code).toContain("seg.end()");
    const manual = manualFindings(src).map((f) => f.construct);
    expect(manual).not.toContain("segment.incrementCounter");
  });

  it("reuses the Tracer serviceName for generated getTracer calls", () => {
    const src = `import { Tracer } from "@aws-lambda-powertools/tracer";
import AWSXRay from "aws-xray-sdk-core";
const tracer = new Tracer({ serviceName: "orders" });
AWSXRay.captureAsyncFunc("x", (seg) => { seg.close(); });
`;
    const out = transformSource(src);
    expect(out.code).toContain('trace.getTracer("orders")');
  });

  it("honours the tracerName option for generated getTracer calls", () => {
    const src = `import AWSXRay from "aws-xray-sdk-core";
AWSXRay.captureAsyncFunc("x", (seg) => { seg.close(); });
`;
    const out = transformSource(src, "f.ts", { tracerName: "custom" });
    expect(out.code).toContain('trace.getTracer("custom")');
  });

  it("flags CJS require of the X-Ray SDK", () => {
    const src = `const AWSXRay = require("aws-xray-sdk-core");\n`;
    expect(manualFindings(src).map((f) => f.construct)).toContain('require("aws-xray-sdk-core")');
  });

  it("rewrites segment methods on a getSegment() receiver", () => {
    const src = `import AWSXRay from "aws-xray-sdk-core";
const seg = AWSXRay.getSegment();
seg.addAnnotation("k", "v");
seg.close();
seg.incrementCounter("c");
`;
    const out = transformSource(src);
    expect(out.code).toContain("const seg = trace.getActiveSpan()");
    expect(out.code).toContain('seg?.setAttribute("k", "v")');
    expect(out.code).toContain("seg?.end()");
    // incrementCounter は OTel に直行しない — manual に残る
    expect(manualFindings(src).map((f) => f.construct)).toContain("segment.incrementCounter");
  });

  it("flags Powertools decorators instead of silently passing them through", () => {
    const src = `import { Tracer } from "@aws-lambda-powertools/tracer";
const tracer = new Tracer();
class Service {
  @tracer.captureMethod()
  work() {}
}
`;
    const out = transformSource(src);
    expect(out.code).toContain("@tracer.captureMethod()"); // 壊して書き換えない
    expect(manualFindings(src).map((f) => f.construct)).toContain("@tracer.captureMethod");
  });

  it("tracks this.prop = new Tracer() assignments for method checks", () => {
    const src = `import { Tracer } from "@aws-lambda-powertools/tracer";
class Service {
  private tracer = new Tracer();
  run() {
    this.tracer.annotateColdStart();
  }
}
`;
    const out = transformSource(src);
    expect(out.code).toContain("createTracer()");
    expect(manualFindings(src).map((f) => f.construct)).toContain("tracer.annotateColdStart");
  });

  it("rewrites segment methods on a property receiver (`this.seg.close()`)", () => {
    const src = `import AWSXRay from "aws-xray-sdk-core";
class S {
  seg = AWSXRay.getSegment();
  run() {
    this.seg.close();
  }
}
`;
    const out = transformSource(src);
    expect(out.code).toContain("this.seg?.end()");
    expect(out.code).not.toContain("this.seg.close()");
  });

  it("unwraps a non-null assertion receiver (`seg!.close()`)", () => {
    const src = `import AWSXRay from "aws-xray-sdk-core";
const seg = AWSXRay.getSegment();
seg!.close();
`;
    const out = transformSource(src);
    expect(out.code).toContain("seg?.end()");
  });

  it("flags element-access segment calls (`seg['close']()`) instead of rewriting them", () => {
    const src = `import AWSXRay from "aws-xray-sdk-core";
const seg = AWSXRay.getSegment();
seg["close"]();
`;
    const out = transformSource(src);
    expect(out.code).toContain('seg["close"]()'); // 壊して書き換えない
    expect(manualFindings(src).map((f) => f.construct)).toContain('segment["close"]');
  });

  it("tracks an aliased X-Ray named import (`getSegment as gs`)", () => {
    const src = `import { getSegment as gs } from "aws-xray-sdk-core";
const seg = gs();
`;
    const out = transformSource(src);
    expect(out.code).toContain("const seg = trace.getActiveSpan()");
    expect(out.code).toContain('import { trace } from "@opentelemetry/api"');
  });

  it("flags getSegment(arg) / resolveSegment(arg) instead of dropping the argument", () => {
    const src = `import AWSXRay from "aws-xray-sdk-core";
const seg = AWSXRay.resolveSegment(candidate);
`;
    const out = transformSource(src);
    expect(out.code).toContain("AWSXRay.resolveSegment(candidate)"); // 引き捨てない
    expect(manualFindings(src).map((f) => f.construct)).toContain("AWSXRay.resolveSegment(arg)");
  });

  it("does not rewrite a shadowed `seg` inside an inner scope", () => {
    const src = `import AWSXRay from "aws-xray-sdk-core";
const seg = AWSXRay.getSegment();
function inner(seg: { close(): void }) {
  seg.close(); // 別 binding — 触らない
}
seg.close();
`;
    const out = transformSource(src);
    // 外側の seg.close() は書き換え、内側（param の seg）は残る
    expect(out.code).toContain("seg?.end()");
    expect(out.code).toContain("seg.close(); // 別 binding");
  });

  it("aliases the generated `trace` import when the name is taken", () => {
    const src = `import AWSXRay from "aws-xray-sdk-core";
const trace = { custom: true };
const seg = AWSXRay.getSegment();
`;
    const out = transformSource(src);
    // `trace` が既に使われているので alias を引く — 既存 binding を壊さない
    expect(out.code).toContain("import { trace as otelTrace }");
    expect(out.code).toContain("otelTrace.getActiveSpan()");
    expect(out.code).toContain("const trace = { custom: true }");
  });

  it("flags re-exports of the migrated modules", () => {
    const src = `export { getSegment } from "aws-xray-sdk-core";
export { Tracer } from "@aws-lambda-powertools/tracer";
`;
    const constructs = manualFindings(src).map((f) => f.construct);
    expect(constructs).toContain('export ... from "aws-xray-sdk-core"');
    expect(constructs).toContain('export ... from "@aws-lambda-powertools/tracer"');
  });

  it("flags unknown methods and non-call member access on the callback segment param", () => {
    const src = `import AWSXRay from "aws-xray-sdk-core";
AWSXRay.captureAsyncFunc("x", (sub) => {
  sub.mysteryMethod();
  console.log(sub.id);
});
`;
    const constructs = manualFindings(src).map((f) => f.construct);
    expect(constructs).toContain("segment.mysteryMethod");
    expect(constructs).toContain("segment.id");
  });

  it("tracks a bare named import (`import { getSegment }`) and its receiver", () => {
    const src = `import { getSegment } from "aws-xray-sdk-core";
const seg = getSegment();
seg.close();
`;
    const out = transformSource(src);
    expect(out.code).toContain("const seg = trace.getActiveSpan()");
    expect(out.code).toContain("seg?.end()");
  });

  it("flags close(err) — rewriting to end(err) would silently lose the error", () => {
    const src = `import AWSXRay from "aws-xray-sdk-core";
const seg = AWSXRay.getSegment();
seg.close(err);
await AWSXRay.captureAsyncFunc("x", (sub) => { sub.close(err); });
`;
    const out = transformSource(src);
    // どちらの close(err) も span.end(err) には書き換わらない（Error を endTime に渡す壊れたコードを出さない）
    expect(out.code).not.toContain(".end(err)");
    const constructs = manualFindings(src).map((f) => f.construct);
    expect(constructs.filter((c) => c === "segment.close(err)")).toHaveLength(2);
  });

  it("unwraps parenthesized and as-cast receivers", () => {
    const src = `import AWSXRay from "aws-xray-sdk-core";
const seg = AWSXRay.getSegment();
(seg).close();
(seg as unknown as { addAnnotation(k: string, v: string): void }).addAnnotation("k", "v");
`;
    const out = transformSource(src);
    expect(out.code).toContain("seg?.end()");
    expect(out.code).toContain('seg?.setAttribute("k", "v")');
  });

  it("does not crash when a replaced new-expression forgets nested type references", () => {
    const src = `import { Tracer } from "@aws-lambda-powertools/tracer";
const t = new Tracer<Tracer>();
`;
    // 外側の new Tracer() が text 置換されると内側の TypeReference `Tracer` が forget される。
    // wasForgotten() ガード無しだと後続 pass がその node を触って crash する。
    const out = transformSource(src);
    expect(out.code).toContain("createTracer()");
  });

  it("keeps the directive prologue first when the xray import is the only import", () => {
    const src = `"use client";
import AWSXRay from "aws-xray-sdk-core";
const seg = AWSXRay.getSegment();
`;
    const out = transformSource(src);
    // xray import が除去されて import が 0 件になっても、生成 import は "use client" の後ろに来る
    expect(out.code.indexOf('"use client"')).toBeLessThan(
      out.code.indexOf('from "@opentelemetry/api"'),
    );
    expect(out.code.indexOf("const seg")).toBeGreaterThan(
      out.code.indexOf('from "@opentelemetry/api"'),
    );
  });

  it("flags a destructured callback parameter instead of tracking it", () => {
    const src = `import AWSXRay from "aws-xray-sdk-core";
AWSXRay.captureAsyncFunc("x", ({ close }) => { close(); });
`;
    const out = transformSource(src);
    expect(out.code).toContain("close()"); // 内側は触らない
    expect(manualFindings(src).map((f) => f.construct)).toContain("segment callback param");
  });

  it("flags an untracked binding shape for `new Tracer()`", () => {
    const src = `import { Tracer } from "@aws-lambda-powertools/tracer";
const service = { tracer: new Tracer() };
`;
    const out = transformSource(src);
    // object literal 内の new は束縛先を追跡できない — 後続の service.tracer.* が
    // silent に残るので manual に挙げる。
    expect(out.code).toContain("createTracer()");
    expect(manualFindings(src).map((f) => f.construct)).toContain("new Tracer binding");
  });

  it("leaves unrelated sources untouched", () => {
    const src = `import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
const c = new DynamoDBClient({});
`;
    const out = transformSource(src);
    expect(out.changed).toBe(false);
    expect(out.findings).toHaveLength(0);
  });

  it("does not crash on addMetadata with a call-expression argument", () => {
    // `sub.addMetadata("k", compute())` — 非 literal 値は JSON.stringify で文字列化せず
    // manual に倒す（OTel attribute は primitive のみ）。crash しないことを確認する。
    const src = `import { captureAsyncFunc } from "aws-xray-sdk-core";
captureAsyncFunc("x", (sub) => { sub.addMetadata("k", compute()); });
`;
    const out = transformSource(src);
    expect(out.code).toContain('sub.addMetadata("k", compute())');
    expect(
      out.findings.some((f) => f.construct === "segment.addMetadata" && f.kind === "manual"),
    ).toBe(true);
  });

  it("flags spread arguments instead of emitting invalid syntax", () => {
    // `captureAWSv3Client(...c)` を機械的に unwrap すると `...c;` で構文不正になる。
    const src = `import AWSXRay from "aws-xray-sdk-core";
AWSXRay.captureAWSv3Client(...c);
`;
    const out = transformSource(src);
    expect(out.code).toContain("AWSXRay.captureAWSv3Client(...c)");
    expect(manualFindings(src).map((f) => f.construct)).toContain(
      "AWSXRay.captureAWSv3Client(...args)",
    );
  });

  it("flags a non-literal addMetadata namespace instead of silently dropping it", () => {
    const src = `import AWSXRay from "aws-xray-sdk-core";
AWSXRay.captureAsyncFunc("x", (sub) => { sub.addMetadata(ns, "k", v); });
`;
    const out = transformSource(src);
    expect(out.code).toContain('sub.addMetadata(ns, "k", v)');
    expect(manualFindings(src).map((f) => f.construct)).toContain("segment.addMetadata");
  });

  it("flags captureAsyncFunc/captureFunc with a parent argument", () => {
    // 第 3 引数の parent segment は OTel に直接の対応物がない — 黙って落とすと
    // trace hierarchy が変わるので manual にする。
    const src = `import AWSXRay from "aws-xray-sdk-core";
AWSXRay.captureAsyncFunc("x", (s) => s.close(), parent);
AWSXRay.captureFunc("y", (s) => s.close(), parent);
`;
    const out = transformSource(src);
    expect(out.code).toContain('captureAsyncFunc("x"');
    const constructs = manualFindings(src).map((f) => f.construct);
    expect(constructs).toContain("AWSXRay.captureAsyncFunc(name, fn, parent)");
    expect(constructs).toContain("AWSXRay.captureFunc(name, fn, parent)");
  });

  it("does not rewrite `new Tracer()` when Tracer is shadowed by a parameter", () => {
    const src = `import { Tracer } from "@aws-lambda-powertools/tracer";
function f(Tracer: any) { return new Tracer(); }
`;
    const out = transformSource(src);
    // param の Tracer は Powertools ではない — `new` を触らない。
    expect(out.code).toContain("new Tracer()");
    expect(out.code).not.toContain("createTracer");
  });

  it("does not rewrite a shadowed type parameter named Tracer", () => {
    const src = `import { Tracer } from "@aws-lambda-powertools/tracer";
function g<Tracer>(x: Tracer): Tracer { return x; }
const t = new Tracer();
`;
    const out = transformSource(src);
    // generic `Tracer` は type param — SekimoriTracer に書き換えない。
    expect(out.code).toContain("function g<Tracer>(x: Tracer): Tracer");
    expect(out.code).toContain("createTracer()");
  });

  it("aliases createTracer when the name is already bound in the file", () => {
    const src = `import { Tracer } from "@aws-lambda-powertools/tracer";
declare function createTracer(): void;
const t = new Tracer();
`;
    const out = transformSource(src);
    // 既存の `createTracer` binding と衝突しないよう alias import に逃げる。
    expect(out.code).toContain("createTracer as sekimoriCreateTracer");
    expect(out.code).toContain("sekimoriCreateTracer()");
  });

  it("reuses an existing otel `trace` import and aliases when it is shadowed", () => {
    const bound = transformSource(
      `import { trace } from "@opentelemetry/api";
import AWSXRay from "aws-xray-sdk-core";
AWSXRay.captureFunc("f", (s) => s.close());
`,
    );
    // 既存の `trace` import を再利用する — import を重複して挿さない。
    expect(bound.code.match(/from "@opentelemetry\/api"/g)).toHaveLength(1);
    expect(bound.code).toContain("trace.getTracer");

    const shadowed = transformSource(
      `import { trace } from "@opentelemetry/api";
import AWSXRay from "aws-xray-sdk-core";
function g(trace: any) { return trace.x; }
AWSXRay.captureFunc("f", (s) => s.close());
`,
    );
    // `trace` が param に shadow されている — 生成コードは fresh 名で参照する。
    expect(shadowed.code).toContain("trace as otelTrace");
    expect(shadowed.code).toContain("otelTrace.getTracer");
  });
});
