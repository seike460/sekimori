import { describe, expect, it } from "vitest";
import { transformSource } from "../src/index.js";
import { manualFindings } from "./helpers.js";

describe("Round-8 hardening", () => {
  it("wraps addError's two-statement expansion in a block under unbraced if/else (R8-B)", () => {
    // `if (e) seg.addError(err); else f();` を裸の 2 文に展開すると else が孤立する。
    const src = `import AWSXRay from "aws-xray-sdk-core";
const seg = AWSXRay.getSegment();
if (e) seg.addError(err); else recover();
`;
    const out = transformSource(src);
    expect(out.code).toContain("recordException(err)");
    expect(out.code).toContain("setStatus({ code:");
    // Block で包まれるので else は if に接続したまま
    expect(out.code).toMatch(/\}\s*else recover\(\)/);
    expect(out.findings.some((f) => f.kind === "manual")).toBe(false);
  });

  it("flags addError() with no argument as manual (R8-B)", () => {
    // recordException(undefined) は Exception 型に入らない。
    const src = `import AWSXRay from "aws-xray-sdk-core";
AWSXRay.getSegment().addError();
`;
    const findings = manualFindings(src);
    expect(findings.map((f) => f.construct)).toContain("segment.addError");
  });

  it("unwraps satisfies and type-assertion receivers (R8-B)", () => {
    const src = `import AWSXRay from "aws-xray-sdk-core";
const s = AWSXRay.getSegment();
(s satisfies object).close();
(<AWSXRay.Segment>s).close();
`;
    const out = transformSource(src);
    expect(out.code.match(/s\?\.end\(\)/g)).toHaveLength(2);
  });

  it("tracks member receivers via the root declaration when the member is untyped (R8-B)", () => {
    // `x: any` では member decl が解決できない — root の `x` の宣言で同一性を判定する。
    const src = `import AWSXRay from "aws-xray-sdk-core";
declare const x: any;
x.seg = AWSXRay.getSegment();
x.seg.close();
`;
    const out = transformSource(src);
    expect(out.code).toContain("x.seg?.end()");
  });

  it("does not rewrite a same-text member on an unrelated object (R8-B)", () => {
    const src = `import AWSXRay from "aws-xray-sdk-core";
declare const x: any;
declare const y: any;
x.seg = AWSXRay.getSegment();
y.seg.close();
`;
    const out = transformSource(src);
    // `y` は別オブジェクト — `x.seg` の追跡に混入せず、そのまま残る。
    expect(out.code).not.toContain("y.seg?.end()");
    expect(out.code).toContain("y.seg.close()");
    expect(out.code).toContain("x.seg = trace.getActiveSpan()");
  });

  it("detects module references in jest/vi hooks and require.resolve (R8-B)", () => {
    const src = `jest.mock("aws-xray-sdk-core");
vi.unmock("@aws-lambda-powertools/tracer");
const p = require.resolve("aws-xray-sdk-core");
`;
    const constructs = manualFindings(src).map((f) => f.construct);
    expect(constructs).toContain('jest.mock("aws-xray-sdk-core")');
    expect(constructs).toContain('vi.unmock("@aws-lambda-powertools/tracer")');
    expect(constructs).toContain('require.resolve("aws-xray-sdk-core")');
  });

  it("skips a type-only `this` parameter when picking the segment callback param (R8-B)", () => {
    // `function (this: Foo, sub)` — this param は実引数を取らないので sub が segment。
    const src = `import AWSXRay from "aws-xray-sdk-core";
AWSXRay.captureFunc("n", function (this: Foo, sub) {
  sub.close();
});
`;
    const out = transformSource(src);
    expect(out.code).toContain("sub.end()");
  });
});

describe("Round-9 hardening", () => {
  it("does not double-report outer-segment calls already rewritten inside a callback (R9-B)", () => {
    // callback 内 pass が `seg.close()` → `seg?.end()` に書き換えた後、ファイル
    // post-pass が `seg?.end` を "unknown segment method" として再報告していた。
    const src = `import AWSXRay from "aws-xray-sdk-core";
const seg = AWSXRay.getSegment();
AWSXRay.captureAsyncFunc("name", async (sub) => {
  sub.addAnnotation("k", 1);
  seg.close();
});
`;
    const out = transformSource(src);
    expect(out.code).toContain("seg?.end()");
    expect(out.code).toContain('sub.setAttribute("k", 1)');
    // 書き換え済みの `end` を manual に再計上しない。
    expect(
      out.findings.filter((f) => f.kind === "manual" && f.construct === "segment.end"),
    ).toHaveLength(0);
    expect(out.findings.some((f) => f.kind === "manual")).toBe(false);
  });

  it("inserts ?. for user-written OTel-style member calls on a tracked segment (R9-B)", () => {
    // `seg.end()` をユーザーが既に書いていた場合 — Span|undefined 用に `?.` を補う。
    const src = `import AWSXRay from "aws-xray-sdk-core";
const seg = AWSXRay.getSegment();
seg.end();
`;
    const out = transformSource(src);
    expect(out.code).toContain("seg?.end()");
    expect(
      out.findings.filter((f) => f.kind === "manual" && f.construct === "segment.end"),
    ).toHaveLength(0);
  });

  it("still flags genuinely unknown segment methods as manual (R9-B)", () => {
    // X-Ray にも OTel にも無い名前は manual のまま残る。
    const src = `import AWSXRay from "aws-xray-sdk-core";
const seg = AWSXRay.getSegment();
seg.doSomethingCustom();
`;
    const findings = manualFindings(src);
    expect(findings.map((f) => f.construct)).toContain("segment.doSomethingCustom");
  });

  it("skips OTel member calls on the callback param without findings (R9-B)", () => {
    // `(sub) => sub.end()` — param は非 undefined の Span なのでそのまま有効。
    const src = `import AWSXRay from "aws-xray-sdk-core";
AWSXRay.captureFunc("n", (sub) => {
  sub.end();
});
`;
    const out = transformSource(src);
    expect(out.code).toContain("sub.end()");
    expect(
      out.findings.filter((f) => f.kind === "manual" && f.construct === "segment.end"),
    ).toHaveLength(0);
  });
});

describe("Round-10 codemod fixes", () => {
  it("does not alias-track a same-named receiver bound to a different declaration (R10-B)", () => {
    // 内側 scope の param `seg`（Segment ではない）を経由した `b = seg` を
    // テキスト一致だけで alias 追跡すると `b.close()` が `b?.end()` に壊れる。
    const src = `import AWSXRay from "aws-xray-sdk-core";
const seg = AWSXRay.getSegment();
function inner(seg: { close(): void }) {
  const b = seg;
  b.close();
}
seg.close();
`;
    const out = transformSource(src);
    expect(out.code).toContain("seg?.end()");
    // 内側の `b.close()` は X-Ray 由来でないので無変更のまま残る。
    expect(out.code).toContain("b.close()");
    expect(out.code).not.toContain("b?.end()");
  });

  it("tracks a tracer alias so `x.getSegment()` bindings migrate (R10-B)", () => {
    // `const x = t` で束縛された alias 上の getSegment を追わないと
    // `s.close()` が silent に残っていた。
    const src = `import { Tracer } from "@aws-lambda-powertools/tracer";
const t = new Tracer();
const x = t;
const s = x.getSegment();
s.close();
`;
    const out = transformSource(src);
    expect(out.code).toContain("x.getSegment()");
    expect(out.code).toContain("s?.end()");
  });

  it("flags an alias of a reassigned segment binding as manual (R10-B)", () => {
    const src = `import AWSXRay from "aws-xray-sdk-core";
const seg = AWSXRay.getSegment();
seg = other;
const b = seg;
b.close();
`;
    const findings = manualFindings(src).map((f) => f.construct);
    expect(findings).toContain("segment alias");
  });

  it("flags `new seg.end()` as manual instead of emitting invalid syntax (R10-B)", () => {
    // optional chain は `new` の callee になれない — `new seg?.end()` は SyntaxError。
    const src = `import AWSXRay from "aws-xray-sdk-core";
const seg = AWSXRay.getSegment();
const C = new seg.end();
`;
    const out = transformSource(src);
    expect(out.code).toContain("new seg.end()");
    expect(out.code).not.toContain("seg?.end");
    const findings = manualFindings(src).map((f) => f.construct);
    expect(findings).toContain("segment.end");
  });

  it("flags write-position member access instead of inserting `?.` (R10-B)", () => {
    // 代入 LHS / ++/-- / for-in LHS / tagged template tag / delete への `?.` 挿入は
    // すべて SyntaxError になる — manual に倒す。
    for (const line of [
      "seg.end = fn;",
      "seg.end++;",
      "for (seg.end in xs) {}",
      "for (seg.end of xs) {}",
      "seg.end`tpl`;",
      "delete seg.end;",
    ]) {
      const src = `import AWSXRay from "aws-xray-sdk-core";
const seg = AWSXRay.getSegment();
${line}
`;
      const out = transformSource(src);
      expect(out.code).toContain(line);
      expect(out.code).not.toContain("seg?.end");
      const findings = manualFindings(src);
      expect(
        findings.some(
          (f) => f.construct === "segment.end" && f.message.includes("write/call-incompatible"),
        ),
      ).toBe(true);
    }
  });

  it("does not taint the root variable on a member write like `seg.end = fn` (R10-B)", () => {
    // member 書き込みは `seg` 自体の再代入ではない — 後続の read は普通に変換される。
    const src = `import AWSXRay from "aws-xray-sdk-core";
const seg = AWSXRay.getSegment();
seg.end = fn;
seg.close();
`;
    const out = transformSource(src);
    expect(out.code).toContain("seg?.end()");
  });

  it("rewrites wrapped callback-param receivers `(sub).close()` / `sub!.close()` (R10-B)", () => {
    const src = `import AWSXRay from "aws-xray-sdk-core";
AWSXRay.captureFunc("n", (sub) => {
  (sub).close();
  sub!.close();
});
`;
    const out = transformSource(src);
    expect(out.code).toContain("(sub).end()");
    expect(out.code).toContain("sub!.end()");
    // wrapper 内の `sub` を bare 参照として二重に manual 報告しない。
    expect(out.findings.filter((f) => f.kind === "manual")).toHaveLength(0);
  });

  it("flags a rebound outer segment used inside a callback exactly once (R10-B)", () => {
    // `seg = getSegment(); seg = other` — callback 内 pass と file post-pass の
    // 二重報告を防ぎ、かつ書き換えない。
    const src = `import AWSXRay from "aws-xray-sdk-core";
const seg = AWSXRay.getSegment();
seg = other;
AWSXRay.captureFunc("n", (sub) => {
  seg.close();
});
`;
    const out = transformSource(src);
    expect(out.code).toContain("seg.close()");
    expect(out.code).not.toContain("seg?.end()");
    const manuals = out.findings.filter(
      (f) => f.kind === "manual" && f.construct === "segment.close",
    );
    expect(manuals).toHaveLength(1);
    expect(manuals[0]?.message).toContain("reassigned");
  });

  it('reports `import("aws-xray-sdk-core")` dynamic type references (R10-B)', () => {
    const src = `type T = import("aws-xray-sdk-core").Segment;
`;
    const findings = manualFindings(src).map((f) => f.construct);
    expect(findings).toContain('import("aws-xray-sdk-core")');
  });
});

describe("Round-11 codemod fixes", () => {
  it("reports each distinct member on an outer receiver once (dedupe is member-keyed, R11-B)", () => {
    // callback 内で `seg.unknownMethod()` が manual 報告されても、同じ receiver の
    // `seg.close` 系の報告を抑制しない — dedupe key は receiver+member。
    const src = `import AWSXRay from "aws-xray-sdk-core";
const seg = AWSXRay.getSegment();
AWSXRay.captureFunc("n", (sub) => {
  seg.unknownMethod();
  seg.alsoUnknown();
});
`;
    const manuals = manualFindings(src).map((f) => f.construct);
    expect(manuals).toContain("segment.unknownMethod");
    expect(manuals).toContain("segment.alsoUnknown");
  });

  it("keeps `?.` on an outer receiver rewritten inside a callback (R11-B)", () => {
    const src = `import AWSXRay from "aws-xray-sdk-core";
declare const x: any;
x.seg = AWSXRay.getSegment();
AWSXRay.captureFunc("n", (s) => { x?.seg.close(); });
`;
    const out = transformSource(src);
    expect(out.code).toContain("x?.seg?.end()");
  });

  it("taints an unresolved member receiver on plain and compound reassign (R11-B)", () => {
    for (const line of [
      "x.seg = otherThing;",
      "x.seg &&= otherThing;",
      "x.seg += v;",
      "x.seg++;",
    ]) {
      const src = `import AWSXRay from "aws-xray-sdk-core";
declare const x: any;
x.seg = AWSXRay.getSegment();
${line}
x.seg.close();
`;
      const out = transformSource(src);
      expect(out.code).toContain("x.seg.close()");
      expect(out.code).not.toContain("x.seg?.end()");
      const manuals = manualFindings(src);
      expect(manuals.some((f) => f.construct === "segment.close")).toBe(true);
    }
  });

  it("does not taint a sibling member when another member is reassigned (R11-B)", () => {
    // `x.other = v` は `x.seg` の再代入ではない — root への fallback は binding-site
    // の member 名が一致するときだけ。
    const src = `import AWSXRay from "aws-xray-sdk-core";
declare const x: any;
x.seg = AWSXRay.getSegment();
x.other = v;
x.seg.close();
`;
    const out = transformSource(src);
    expect(out.code).toContain("x.seg?.end()");
  });

  it("reports a wrapped decorator receiver and keeps a shadowed one untouched (R11-B)", () => {
    const src = `import { Tracer } from "@aws-lambda-powertools/tracer";
const tracer = new Tracer();
class S { @(tracer).captureMethod() m() {} }
`;
    const manuals = manualFindings(src).map((f) => f.construct);
    expect(manuals).toContain("@(tracer).captureMethod");
  });

  it("flags bare outer segment references at file level (R11-B)", () => {
    const src = `import AWSXRay from "aws-xray-sdk-core";
const seg = AWSXRay.getSegment();
helper(seg);
const { close } = seg;
return seg;
`;
    const manuals = manualFindings(src).filter((f) => f.construct === "segment seg");
    expect(manuals).toHaveLength(3);
  });

  it("flags element access on a tracked segment receiver (R11-B)", () => {
    const src = `import AWSXRay from "aws-xray-sdk-core";
declare const x: any;
x.seg = AWSXRay.getSegment();
const f = x.seg["close"];
`;
    const manuals = manualFindings(src).map((f) => f.construct);
    expect(manuals).toContain('segment["close"]');
  });

  it("reports shorthand `serviceName` in dropped Tracer options (R11-B)", () => {
    const src = `import { Tracer } from "@aws-lambda-powertools/tracer";
const serviceName = "orders";
const tracer = new Tracer({ serviceName });
`;
    const out = transformSource(src);
    expect(out.code).toContain("createTracer()");
    const manuals = out.findings.filter((f) => f.kind === "manual");
    expect(manuals.some((f) => f.message.includes("serviceName"))).toBe(true);
  });

  it("keeps object / function / class args parenthesized at statement position (R11-B)", () => {
    // `{ s3: cfg }` を文位置に裸で置くと Block として parse され crash する —
    // 式 statement 化するため括弧で包む。
    const src = `import AWSXRay from "aws-xray-sdk-core";
declare const cfg: any;
AWSXRay.captureAWS({ s3: cfg });
`;
    const out = transformSource(src);
    expect(out.code).toContain("({ s3: cfg });");
  });

  it("sorts findings by source order (R11-B)", () => {
    const src = `import AWSXRay from "aws-xray-sdk-core";
const seg = AWSXRay.getSegment();
helper(seg);
AWSXRay.captureFunc("n", (sub) => {
  seg.unknownMethod();
});
`;
    const findings = transformSource(src).findings;
    const lines = findings.map((f) => f.line);
    const sorted = [...lines].sort((a, b) => a - b);
    expect(lines).toEqual(sorted);
  });
});
