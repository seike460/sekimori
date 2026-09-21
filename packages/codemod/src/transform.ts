/** codemod の主 pass — ts-morph で aws-xray-sdk-core / Powertools Tracer を OTel API へ書き換える。 */
import {
  type CallExpression,
  Node,
  Project,
  type PropertyAccessExpression,
  SyntaxKind,
} from "ts-morph";
import {
  consumeReportedOuter,
  type EmitCtx,
  type LineOf,
  type MigrationFinding,
  type Report,
  report,
} from "./transform-ctx.js";
import {
  ensureOtelImport,
  pickFreshName,
  resolveImportedName,
  resolveOtelTraceName,
  resolveShimName,
} from "./transform-imports.js";
import {
  reportLeftoverTracerRefs,
  reportLeftoverXrayRefs,
  reportModuleSpecifierCalls,
  rewritePowertoolsImports,
  scanModuleRefs,
} from "./transform-module-refs.js";
import {
  boundTarget,
  boundToAny,
  canonicalReceiverText,
  collectAliasReceivers,
  collectTaintedReceivers,
  getSegmentReceiverKind,
  receiverMatch,
  type TrackedReceiver,
  trackReceiver,
  unwrapReceiver,
} from "./transform-receiver.js";
import {
  isMigratedSpanMember,
  mapTracerArgs,
  rewriteSegmentCalls,
  rewriteSegmentMethod,
} from "./transform-segments.js";
import { OTEL_MODULE, SHIM_MODULE, SHIM_SUPPORTED, XRAY_UNWRAP } from "./transform-tables.js";

export type { MigrationFinding } from "./transform-ctx.js";

export interface TransformResult {
  readonly code: string;
  readonly changed: boolean;
  readonly findings: MigrationFinding[];
}

export interface TransformOptions {
  /**
   * `captureAsyncFunc` 等が生成する `trace.getTracer(<name>)` の名前。
   * 未指定なら同じファイルの `new Tracer({ serviceName })` のリテラル、それも無ければ `"app"`。
   */
  readonly tracerName?: string;
}

/** 変換を試みる。戻り値: "otel"（OTel import が要る）/ "done" / false（未対応）。 */
function handleXrayCall(
  call: CallExpression,
  method: string,
  r: Report,
  tracerName: string,
  ctx: EmitCtx,
  lineOf: LineOf,
): "otel" | "done" | false {
  const line = lineOf(call);
  if (XRAY_UNWRAP.has(method)) {
    const arg = call.getArguments()[0];
    if (arg === undefined) {
      report(r, line, "manual", `AWSXRay.${method}()`, "no argument to unwrap — remove by hand");
      return "done";
    }
    // `captureHTTPsGlobal(http, true, callback)` のように第 2・第 3 引数を取る形がある。
    // unwrap で丸ごと消えると callback 内の annotation/metadata 収集が silent に失われる。
    if (call.getArguments().length > 1) {
      report(
        r,
        line,
        "manual",
        `AWSXRay.${method}(arg, ...)`,
        "extra arguments (options / callback) would be dropped — map by hand",
      );
      return "done";
    }
    // `captureAWSv3Client(...c)` の spread はそのまま出力すると `...c;` で構文不正になる。
    if (Node.isSpreadElement(arg)) {
      report(
        r,
        line,
        "manual",
        `AWSXRay.${method}(...args)`,
        "spread argument cannot be unwrapped mechanically — expand by hand",
      );
      return "done";
    }
    // 文位置（`captureAWS({ s3: cfg });`）で `{ ... }` / `function` / `class` を
    // 剥き出しで置くと object literal が Block / declaration として parse されて
    // 構文が壊れる — 式のまま保つため括弧で包む。
    const bare =
      Node.isExpressionStatement(call.getParent()) &&
      (Node.isObjectLiteralExpression(arg) ||
        Node.isFunctionExpression(arg) ||
        Node.isClassExpression(arg));
    call.replaceWithText(bare ? `(${arg.getText()})` : arg.getText());
    report(r, line, "auto", `AWSXRay.${method}`, "unwrapped — contrib instrumentation covers it");
    return "done";
  }
  if (method === "getSegment" || method === "resolveSegment") {
    // 引数ありの getSegment(sub)/resolveSegment(segment) は「特定の segment を解決する」
    // 意味で getActiveSpan() と等価ではない — 引き捨てず manual にする。
    if (call.getArguments().length > 0) {
      report(
        r,
        line,
        "manual",
        `AWSXRay.${method}(arg)`,
        `${method} with an argument resolves a specific segment — map by hand`,
      );
      return "done";
    }
    call.replaceWithText(`${ctx.otelTraceName}.getActiveSpan()`);
    report(r, line, "auto", `AWSXRay.${method}`, "replaced with trace.getActiveSpan()");
    return "otel";
  }
  if (method === "captureAsyncFunc" || method === "captureFunc") {
    const args = call.getArguments();
    const [name, fn] = args;
    // 3 引数目の `parent`（親にする segment）は startActiveSpan に対応物が無い —
    // 引き捨てると trace の親子関係が壊れるので manual にする。
    if (args.length > 2) {
      report(
        r,
        line,
        "manual",
        `AWSXRay.${method}(name, fn, parent)`,
        "the parent argument has no OTel equivalent — set the parent context by hand",
      );
      return "done";
    }
    if (fn && (Node.isArrowFunction(fn) || Node.isFunctionExpression(fn))) {
      rewriteSegmentCalls(fn, ctx, r, lineOf, ctx.outerSegments);
      // X-Ray の capture*Func は callback の正常終了・例外の両方で subsegment を
      // 自動 close するが、OTel の startActiveSpan は span を自動 end しない —
      // span leak を防ぐため wrapper で end を保証する。callback 内の
      // `sub.close()`（→ `sub.end()`）済みでも isRecording() ガードで二重 end しない。
      // `captureFunc`（sync 値を返す）と `captureAsyncFunc`（Promise）の sync/async
      // 意味はそのまま保つ。
      const isAsync = method === "captureAsyncFunc";
      const ssc = ctx.spanStatusCode();
      // callback の body が外側 scope の `span` という名の変数を参照していると、
      // 生成 param `span` に capture されて意味が変わる — ファイル内で使われない名を選ぶ。
      const sp = ctx.spanParam();
      call.replaceWithText(
        `${ctx.otelTraceName}.getTracer(${JSON.stringify(tracerName)}).startActiveSpan(` +
          `${name?.getText() ?? '"xray"'}, ${isAsync ? "async " : ""}(${sp}) => {\n` +
          `  try {\n` +
          `    return ${isAsync ? "await " : ""}(${fn.getText()})(${sp});\n` +
          `  } catch (e) {\n` +
          `    if (${sp}.isRecording()) {\n` +
          `      ${sp}.recordException(e instanceof Error ? e : String(e));\n` +
          `      ${sp}.setStatus({ code: ${ssc}.ERROR, message: e instanceof Error ? e.message : String(e) });\n` +
          `    }\n` +
          `    throw e;\n` +
          `  } finally {\n` +
          `    if (${sp}.isRecording()) ${sp}.end();\n` +
          `  }\n` +
          `})`,
      );
      report(
        r,
        line,
        "auto",
        `AWSXRay.${method}`,
        "replaced with tracer.startActiveSpan (auto-closes the span like X-Ray)",
      );
      return "otel";
    }
    report(r, line, "manual", `AWSXRay.${method}`, "non-inline callback — wrap by hand");
    return "done";
  }
  return false;
}

// ts-morph の Project 生成は TypeScript lib の読み込みで重い。
// migratePaths がファイルごとに transformSource を呼ぶため、Project はモジュール単位で
// 共有し、各呼び出しでは source file の差し替えだけ行う（結果取出し後に破棄）。
let sharedProject: Project | undefined;

function projectFor(): Project {
  sharedProject ??= new Project({
    useInMemoryFileSystem: true,
    skipAddingFilesFromTsConfig: true,
  });
  return sharedProject;
}

/**
 * 1 ファイル分の codemod。aws-xray-sdk-core と @aws-lambda-powertools/tracer の
 * 代表的構文を OTel API / sekimori/tracer へ書き換え、写せない構文は findings に残す。
 */
export function transformSource(
  source: string,
  fileName = "source.ts",
  options: TransformOptions = {},
): TransformResult {
  const project = projectFor();
  const sf = project.createSourceFile(fileName, source, { overwrite: true });
  const r: Report = { findings: [] };

  // findings の行番号は変換前ファイルの位置で報告する。import 削除等で行がずれるため、
  // mutation に先立って全 node の位置を snapshot する。
  const lines = new Map<Node, number>();
  lines.set(sf, sf.getStartLineNumber());
  for (const n of sf.getDescendants()) lines.set(n, n.getStartLineNumber());
  // replaceWithText で生成された新 node は snapshot に無い — 最も近い既存祖先の位置に倒す。
  const lineOf: LineOf = (n) => {
    let cur: Node | undefined = n;
    while (cur !== undefined) {
      const line = lines.get(cur);
      if (line !== undefined) return line;
      cur = cur.getParent();
    }
    return n.getStartLineNumber();
  };

  // import / export / require / dynamic import type を走査し、X-Ray / Powertools の
  // 束縛表を組み立てる。X-Ray の import declaration はここで除去される。
  const bindings = scanModuleRefs(sf, r, lineOf);
  const {
    xrayAliases,
    xrayAliasDecls,
    xrayNamedImports,
    xraySegmentImports,
    xrayNamedSpecs,
    powertoolsNamespaces,
    powertoolsBoundTracer,
    powertoolsTypeTracer,
    powertoolsManualTracer,
  } = bindings;
  let tracerTypeUsed = false;

  // 生成コードが参照する shim 識別子を rewrite 前に決める — 同名 binding との衝突時は
  // alias import に逃げる（`createTracer` をローカル定義しているファイルでも壊れない）。
  const shimCreateTracer = resolveShimName(sf);
  const shimSekimoriTracer = resolveImportedName(sf, SHIM_MODULE, "SekimoriTracer", [
    "SekimoriTracer",
  ]);

  // `new Tracer(...)` → `createTracer(...)`。Powertools import に束縛された識別子だけを対象にする
  // （ユーザー定義や他モジュールの同名 class は触らない）。代入先を記録してメソッド互換を検査する。
  // 値は束縛の宣言 node — 同名の別 binding（shadow された変数等）を誤変換しないための scope 情報。
  const tracerReceivers = new Map<string, TrackedReceiver>();
  const segmentReceivers = new Map<string, TrackedReceiver>();
  // 追跡中 decl → 束縛を行った node。束縛後の再代入を collectTaintedReceivers で検出する。
  const bindingSites = new Map<Node, Node>();
  // 束縛後に別式で再代入された decl — receiverMatch が "unresolved" に倒す。
  const taintedReceivers = new Set<Node>();
  // `this.tracer = new Tracer()` の左辺のように、代入先そのものは member-access 検査から外す。
  const assignTargets = new Set<PropertyAccessExpression>();
  let tracerServiceName: string | undefined;
  let tracerConstructed = false;
  for (const expr of sf.getDescendantsOfKind(SyntaxKind.NewExpression)) {
    // 外側の `new Tracer(...)` を replaceWithText すると引数内の nested `new`/`as`
    // node が forget される — 触る前に確認する。
    if (expr.wasForgotten()) continue;
    const callee = expr.getExpression();
    const line = lineOf(expr);
    // `new ns.Tracer()` — namespace import 経由の Powertools は手作業案件。
    // 同名の param 等に shadow された `ns` は Powertools ではないので触らない。
    const nsIdent = Node.isPropertyAccessExpression(callee) ? callee.getExpression() : undefined;
    const nsDecls =
      nsIdent !== undefined && Node.isIdentifier(nsIdent)
        ? powertoolsNamespaces.get(nsIdent.getText())
        : undefined;
    if (
      Node.isPropertyAccessExpression(callee) &&
      callee.getName() === "Tracer" &&
      nsDecls !== undefined &&
      Node.isIdentifier(nsIdent) &&
      boundToAny(nsIdent, nsDecls)
    ) {
      report(
        r,
        line,
        "manual",
        `new ${callee.getExpression().getText()}.Tracer`,
        "namespace-imported Powertools Tracer — convert to createTracer by hand",
      );
      continue;
    }
    if (!Node.isIdentifier(callee)) continue;
    // `Tracer` という名が Powertools import に実際に束縛されているときだけ触る —
    // 同名の param / type param / 変数に shadow されているならユーザーの binding なので skip。
    const typeDecls = powertoolsTypeTracer.get(callee.getText());
    const manualDecls = powertoolsManualTracer.get(callee.getText());
    const boundDecls = powertoolsBoundTracer.get(callee.getText());
    if (typeDecls !== undefined && boundToAny(callee, typeDecls)) {
      report(
        r,
        line,
        "manual",
        `new ${callee.getText()}`,
        "Tracer bound to a type-only Powertools import — `new` on it is invalid; convert to createTracer by hand",
      );
      continue;
    }
    if (manualDecls !== undefined && boundToAny(callee, manualDecls)) {
      report(
        r,
        line,
        "manual",
        `new ${callee.getText()}`,
        "Tracer bound to a default/aliased Powertools import — convert to createTracer by hand",
      );
      continue;
    }
    if (boundDecls === undefined || !boundToAny(callee, boundDecls)) continue;
    const init = expr.getArguments()[0];
    // serviceName リテラルは captureAsyncFunc が生成する getTracer 名の既定値に使う。
    if (init !== undefined && Node.isObjectLiteralExpression(init)) {
      const sn = init.getProperty("serviceName");
      if (sn !== undefined && Node.isPropertyAssignment(sn)) {
        const v = sn.getInitializer();
        if (v !== undefined && Node.isStringLiteral(v)) tracerServiceName ??= v.getLiteralValue();
      }
    }
    const target = boundTarget(expr);
    const args = mapTracerArgs(init, r, lineOf);
    // `this.t = new Tracer()` の左辺 `this.t` は代入先なので member-access 検査から外す。
    // replaceWithText で expr は forget されるため parent は先に取る。
    const parent = expr.getParent();
    if (Node.isBinaryExpression(parent)) {
      const left = parent.getLeft();
      if (Node.isPropertyAccessExpression(left)) assignTargets.add(left);
    }
    expr.replaceWithText(`${shimCreateTracer.name}(${args})`);
    tracerConstructed = true;
    report(r, line, "auto", "new Tracer", "replaced with createTracer() from sekimori/tracer");
    if (target !== undefined) {
      trackReceiver(tracerReceivers, target, bindingSites);
    } else if (!Node.isExpressionStatement(parent)) {
      // `{ t: new Tracer() }` / `return new Tracer()` / 分割代入等は束縛を追跡できない —
      // 後続の `o.t.method()` が silent に残るので manual に挙げる。
      report(
        r,
        line,
        "manual",
        "new Tracer binding",
        "binding shape not tracked — downstream tracer.<method> uses may need manual mapping",
      );
    }
  }

  // Tracer の型注釈は SekimoriTracer に差し替える。Powertools import に実際に束縛された
  // 参照だけ（`function f<Tracer>(x: Tracer)` のような shadow type param は触らない）。
  for (const ref of sf.getDescendantsOfKind(SyntaxKind.TypeReference)) {
    if (ref.wasForgotten()) continue;
    const typeName = ref.getTypeName();
    if (!Node.isIdentifier(typeName)) continue;
    const specDecls =
      powertoolsBoundTracer.get(typeName.getText()) ?? powertoolsTypeTracer.get(typeName.getText());
    if (specDecls !== undefined && boundToAny(typeName, specDecls)) {
      typeName.replaceWithText(shimSekimoriTracer.name);
      tracerTypeUsed = true;
    }
  }

  const spanTracerName = options.tracerName ?? tracerServiceName ?? "app";
  // 生成コードが参照する `trace` binding の名前。同名 binding があると shadow で壊れるため選び直す。
  const otelTrace = resolveOtelTraceName(sf);
  // `trace` の import は getter を読んだ経路でのみ立つ — SpanStatusCode だけを
  // 使う shim 経路で `trace` を余計に import して noUnusedLocals を落とさない。
  let usedOtelTrace = false;
  // `SpanStatusCode` は capture wrapper / addError 展開が使う — 使われたときだけ lazy に
  // 解決して import 対象に積む（参照が無いファイルには import を増やさない）。
  let otelSpanStatusCode: { name: string; bound: boolean; exportName: string } | undefined;
  // capture wrapper が生成する `span` param 名 — callback body が外側の `span`
  // 変数を参照していても capture しないよう、ファイル内で未使用の名を一度だけ選ぶ。
  let spanParamName: string | undefined;
  const emitCtx: EmitCtx = {
    get otelTraceName() {
      usedOtelTrace = true;
      return otelTrace.name;
    },
    spanStatusCode() {
      otelSpanStatusCode ??= resolveImportedName(sf, OTEL_MODULE, "SpanStatusCode", [
        "SpanStatusCode",
        "otelSpanStatusCode",
      ]);
      return otelSpanStatusCode.name;
    },
    spanParam() {
      spanParamName ??= pickFreshName(sf, "span", ["span", "otelSpan", "span2"]);
      return spanParamName;
    },
  };

  // decorator（`@tracer.captureMethod()` / `@tracer.captureLambdaHandler`）は shim が
  // 高階関数として実装していても decorator としては動かない — 一律 manual finding。
  // call 側で拾うと SHIM_SUPPORTED で素通りしてしまうため先に検査する。
  const decoratedCalls = new Set<CallExpression>();
  // decorator 内の PA — decorator pass で報告済みなので member-access pass で二重計上しない。
  const decoratedAccesses = new Set<PropertyAccessExpression>();
  for (const dec of sf.getDescendantsOfKind(SyntaxKind.Decorator)) {
    const outer = dec.getExpression();
    const inner = Node.isCallExpression(outer) ? outer.getExpression() : outer;
    if (!Node.isPropertyAccessExpression(inner)) continue;
    // `@(tracer).captureMethod()` / `@this.tracer.captureLambdaHandler` — paren・`!`・
    // `as` 等の包みを剥がして canonical text で照合する（生 text だと `(tracer)` が
    // `tracer` に一致せず decorator が silent に残る）。
    const recv = unwrapReceiver(inner.getExpression());
    const recvText = canonicalReceiverText(recv);
    const isTracerReceiver = receiverMatch(recv, tracerReceivers, taintedReceivers) !== false;
    const ptNsDecls = powertoolsNamespaces.get(recvText);
    const isModuleReceiver =
      (ptNsDecls !== undefined && (!Node.isIdentifier(recv) || boundToAny(recv, ptNsDecls))) ||
      (xrayAliases.has(recvText) && (!Node.isIdentifier(recv) || boundToAny(recv, xrayAliasDecls)));
    if (!isTracerReceiver && !isModuleReceiver) continue;
    report(
      r,
      lineOf(dec),
      "manual",
      `@${inner.getText()}`,
      "decorator form is not covered by the sekimori/tracer shim — wrap the method by hand",
    );
    if (Node.isCallExpression(outer)) decoratedCalls.add(outer);
    decoratedAccesses.add(inner);
  }

  // X-Ray call の変換。内側（callback 内の segment method）から書くため位置の降順で処理する。
  // 同じ開始位置を持つ nested call（`AWSXRay.getSegment().close()` 等）は end が大きい
  // 外側を先にする — sort の安定性に依存せず明示的に tie-break する。
  const calls = sf
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .sort((a, b) => b.getStart() - a.getStart() || b.getEnd() - a.getEnd());
  // chain でまとめて処理した inner call（`AWSXRay.getSegment(sub).close()` の内側等）は
  // 二重に報告しないよう記録する。
  const handledCalls = new Set<CallExpression>();
  // `x = <0 引数の getSegment/resolveSegment>` の束縛 decl を mutation 前に収集する。
  // call ループは位置降順のため、capture callback 内の `seg.close()` は束縛記録より先に
  // 通り過ぎ、その後 callback ごと replaceWithText で forget されて silent に残る。
  // 0 引数の call は必ず rewrite が成立するので、decl だけ先に確定させて
  // rewriteSegmentCalls が callback 内の外側束縛 receiver を拾えるようにする。
  // bindingSites にも登録する — 束縛後の再代入（`seg = other`）を callback 内の
  // use でも検出できるよう、collectTaintedReceivers より先に確定させる。
  const outerSegmentDecls = new Set<Node>();
  const outerSegmentTexts = new Set<string>();
  for (const call of calls) {
    const expr = call.getExpression();
    let isSegmentCall = false;
    if (Node.isPropertyAccessExpression(expr)) {
      const method = expr.getName();
      if (
        (method === "getSegment" || method === "resolveSegment") &&
        call.getArguments().length === 0
      ) {
        const recv = unwrapReceiver(expr.getExpression());
        isSegmentCall =
          (Node.isIdentifier(recv) &&
            xrayAliases.has(recv.getText()) &&
            boundToAny(recv, xrayAliasDecls)) ||
          (method === "getSegment" &&
            receiverMatch(recv, tracerReceivers, taintedReceivers) === "match");
      }
    } else if (Node.isIdentifier(expr)) {
      const m = xrayNamedImports.get(expr.getText());
      const spec = xrayNamedSpecs.get(expr.getText());
      isSegmentCall =
        (m === "getSegment" || m === "resolveSegment") &&
        call.getArguments().length === 0 &&
        (spec === undefined || boundToAny(expr, new Set([spec])));
    }
    if (!isSegmentCall) continue;
    const bound = boundTarget(call);
    if (bound === undefined) continue;
    outerSegmentTexts.add(bound.text);
    for (const d of bound.decls) {
      outerSegmentDecls.add(d);
      bindingSites.set(d, bound.site);
    }
  }
  emitCtx.outerSegments = { decls: outerSegmentDecls, texts: outerSegmentTexts };
  emitCtx.taintedReceivers = taintedReceivers;
  emitCtx.reportedOuterSegments = new Map();
  // `new Tracer()` / outer segment の束縛先はこの時点で確定済み — `t = x` のような
  // 再代入を call ループより先に検出する。segmentReceivers は call ループで
  // 確定するため、ループ後にもう一度収集する。
  collectTaintedReceivers(sf, bindingSites, taintedReceivers);
  // `const x = t` のような tracer alias — LHS を追跡しないと `x.getSegment()` が
  // silent に残る。tracerReceivers は確定済みなので call ループの前に収集する。
  collectAliasReceivers(sf, tracerReceivers, taintedReceivers, bindingSites, r, lineOf, "tracer");
  // alias LHS（`x = t` の `x`）も bindingSites に登録された — その再代入も検出する。
  collectTaintedReceivers(sf, bindingSites, taintedReceivers);
  // `seg = <getSegment呼び出し>` の束縛先を記録し、追跡不能な形は manual に挙げる。
  // replaceWithText で call が forget されるため、束縛と parent は置換前に取る。
  const trackSegmentBinding = (
    call: CallExpression,
    parent: Node | undefined,
    rewritten: boolean,
  ) => {
    // manual に倒した getSegment/resolveSegment（引数あり等）は X-Ray のまま残る —
    // 束縛先を追跡して `seg.close()` → `seg?.end()` にすると、manual 解決で
    // X-Ray のまま残したコードが壊れる。追跡するのは書き換えが成立したときだけ。
    if (!rewritten) return;
    const bound = boundTarget(call);
    if (bound !== undefined) {
      trackReceiver(segmentReceivers, bound, bindingSites);
      return;
    }
    // 戻り値を捨てる裸の文以外（`return` / object literal / 分割代入等）は後続の
    // `x.close()` が silent に残るので manual に挙げる。
    if (parent !== undefined && !Node.isExpressionStatement(parent)) {
      report(
        r,
        lineOf(call),
        "manual",
        "getSegment() binding",
        "binding shape not tracked — downstream segment.<method> uses may need manual mapping",
      );
    }
  };
  for (const call of calls) {
    if (call.wasForgotten()) continue;
    if (decoratedCalls.has(call) || handledCalls.has(call)) continue;
    const expr = call.getExpression();
    const line = lineOf(call);
    if (Node.isPropertyAccessExpression(expr)) {
      const receiverNode = expr.getExpression();
      const method = expr.getName();

      // `<recv>.getSegment()?.<segMethod>(...)` の chain — 外側 call をまとめて書き換える。
      // `getSegment()!.close()` のような `!`/`()`/`as` 包み receiver も剥がしてから判定する。
      const receiverUnwrapped = unwrapReceiver(receiverNode);
      if (Node.isCallExpression(receiverUnwrapped)) {
        const kind = getSegmentReceiverKind(receiverUnwrapped, {
          xrayAliases,
          xrayAliasDecls,
          xraySegmentImports,
          tracerReceivers,
          tainted: taintedReceivers,
        });
        if (kind !== undefined) {
          // 束縛が解決不能な receiver（`x.t` で x 未解決等）は同一 binding と証明できない —
          // テキスト一致で書き換えると別 binding を壊すので manual に倒す。
          if (kind === "tracer-unresolved") {
            handledCalls.add(receiverUnwrapped);
            report(
              r,
              line,
              "manual",
              `${receiverNode.getText()}.${expr.getName()}`,
              "receiver binding could not be resolved — verify it is the migrated tracer by hand",
            );
            continue;
          }
          // 引数ありの getSegment(sub)/resolveSegment(segment) は特定の segment を解決する — manual。
          // inner call はここで報告済みなので、後の iteration で二重計上しないよう記録する。
          if (receiverUnwrapped.getArguments().length > 0) {
            handledCalls.add(receiverUnwrapped);
            report(
              r,
              line,
              "manual",
              `${receiverUnwrapped.getText()}`,
              "getSegment/resolveSegment with an argument resolves a specific segment — map by hand",
            );
            continue;
          }
          const base =
            kind === "xray" ? `${otelTrace.name}.getActiveSpan()` : `${receiverNode.getText()}`;
          if (kind === "xray") usedOtelTrace = true;
          rewriteSegmentMethod(call, expr, base, emitCtx, r, lineOf);
          continue;
        }
      }

      const recvNorm = unwrapReceiver(receiverNode);
      if (
        Node.isIdentifier(recvNorm) &&
        xrayAliases.has(recvNorm.getText()) &&
        boundToAny(recvNorm, xrayAliasDecls)
      ) {
        // `seg = AWSXRay.getSegment()` の束縛先を記録し、後続の `seg.close()` 等を拾う。
        // handleXrayCall の replaceWithText で node が forget され得るため先に取る。
        const isSegmentCall = method === "getSegment" || method === "resolveSegment";
        const callParent = isSegmentCall ? call.getParent() : undefined;
        const result = handleXrayCall(call, method, r, spanTracerName, emitCtx, lineOf);
        if (result === false) {
          report(r, line, "manual", `AWSXRay.${method}`, "no mechanical mapping — review by hand");
          continue;
        }
        if (isSegmentCall) trackSegmentBinding(call, callParent, result === "otel");
        continue;
      }

      const tracerMatch = receiverMatch(recvNorm, tracerReceivers, taintedReceivers);
      if (tracerMatch === "unresolved") {
        report(
          r,
          line,
          "manual",
          `${recvNorm.getText()}.${method}`,
          "receiver binding could not be resolved — verify it is the migrated tracer by hand",
        );
      } else if (tracerMatch === "match") {
        // shim の getSegment() は Span|undefined を返す — 束縛先の segment method を拾う。
        if (method === "getSegment") {
          trackSegmentBinding(call, call.getParent(), true);
        } else if (!SHIM_SUPPORTED.has(method)) {
          report(
            r,
            line,
            "manual",
            `tracer.${method}`,
            "not covered by the sekimori/tracer shim — check Powertools RFC #90 or rewrite to OTel API",
          );
        }
      }
      continue;
    }
    if (Node.isIdentifier(expr)) {
      const xrayMethod = xrayNamedImports.get(expr.getText());
      // 同名の別 binding（shadow された param 等）を誤って書き換えない — import の
      // specifier に束縛される call だけを対象にする。解決不能なら従来どおり扱う。
      const spec = xrayNamedSpecs.get(expr.getText());
      const isOurs =
        xrayMethod !== undefined && (spec === undefined || boundToAny(expr, new Set([spec])));
      if (xrayMethod !== undefined && isOurs) {
        const isSegmentCall = xrayMethod === "getSegment" || xrayMethod === "resolveSegment";
        const callParent = isSegmentCall ? call.getParent() : undefined;
        const result = handleXrayCall(call, xrayMethod, r, spanTracerName, emitCtx, lineOf);
        if (result === false) {
          report(
            r,
            line,
            "manual",
            `${expr.getText()}()`,
            "no mechanical mapping — review by hand",
          );
        } else {
          if (isSegmentCall) trackSegmentBinding(call, callParent, result === "otel");
        }
      }
    }
  }

  // `seg = AWSXRay.getSegment()` / `tracer.getSegment()` に束縛された変数・プロパティ上の
  // segment method / member access を span 相当へ書き換える（見つからなければ manual）。
  // あわせて `tracer.provider` 等の shim が持たない非 call member access も manual にする。
  // segmentReceivers が確定したので再代入の収集をもう一度回す。
  collectTaintedReceivers(sf, bindingSites, taintedReceivers);
  // `const b = seg` / `a = b` のような alias 束縛 — RHS が追跡中 receiver なら LHS も追跡に
  // 積む。積まないと `b.close()` が Span|undefined 化した receiver のまま silent に残る。
  // 文書順に処理すれば chain（`c = b`）も追える。RHS の binding identity は
  // receiverMatch で検証する — テキスト一致だけだと内側 scope の同名 param を誤変換する。
  collectAliasReceivers(sf, segmentReceivers, taintedReceivers, bindingSites, r, lineOf, "segment");
  // alias LHS（`b = seg` の `b`）も bindingSites に登録された — その再代入も検出する。
  collectTaintedReceivers(sf, bindingSites, taintedReceivers);
  // callback 内 pass が既に manual 報告した外側束縛 receiver の member —
  // callback ごとの replaceWithText で再 parse された新 node を二重報告しない。
  const reported = emitCtx.reportedOuterSegments;
  for (const pa of sf.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
    if (pa.wasForgotten()) continue;
    if (decoratedAccesses.has(pa)) continue;
    // `this.seg`（PA）や `seg!`（NonNullExpression）の receiver も拾う。
    const recv = unwrapReceiver(pa.getExpression());
    const recvText = recv.getText();
    const parent = pa.getParent();
    const isCallee = Node.isCallExpression(parent) && parent.getExpression() === pa;
    if (consumeReportedOuter(reported, `${canonicalReceiverText(recv)}|${pa.getName()}`)) {
      continue;
    }
    const segMatch = receiverMatch(recv, segmentReceivers, taintedReceivers);
    if (segMatch === "match") {
      if (isCallee && Node.isCallExpression(parent)) {
        rewriteSegmentMethod(parent, pa, recvText, emitCtx, r, lineOf);
      } else if (!isMigratedSpanMember(pa, recvText, r, lineOf)) {
        report(
          r,
          lineOf(pa),
          "manual",
          `segment.${pa.getName()}`,
          "member access on a segment variable — map to OTel Span API by hand",
        );
      }
      continue;
    }
    if (segMatch === "unresolved") {
      // 束縛側が解決不能なテキスト一致 — 別 binding の同名 member を壊さないよう manual に倒す。
      report(
        r,
        lineOf(pa),
        "manual",
        `segment.${pa.getName()}`,
        "receiver binding could not be resolved — verify it is a migrated segment by hand",
      );
      continue;
    }
    const tracerMatch = receiverMatch(recv, tracerReceivers, taintedReceivers);
    if (tracerMatch !== false && !assignTargets.has(pa) && !isCallee) {
      report(
        r,
        lineOf(pa),
        "manual",
        `tracer.${pa.getName()}`,
        tracerMatch === "unresolved"
          ? "receiver binding could not be resolved — verify it is the migrated tracer by hand"
          : "member access is not covered by the sekimori/tracer shim — check by hand",
      );
    }
  }

  // `seg["close"]()` / `const f = seg["close"]` のような element access — rename 規則が
  // 文字列 key には機械適用できないので manual にする。call ループは位置降順（束縛より
  // 先に use を見ることがある）なので、束縛収集が終わった後のこの pass で拾う。
  // call 形に限らない — `const f = seg["close"]` のようなメソッド参照の取り出しも
  // rename されずに残るため manual にする。
  const boundSiteNodes = new Set(bindingSites.values());
  for (const ea of sf.getDescendantsOfKind(SyntaxKind.ElementAccessExpression)) {
    if (ea.wasForgotten()) continue;
    // `x.seg["k"] = getSegment()` のような束縛 site 自身の EA は use ではない。
    if (boundSiteNodes.has(ea)) continue;
    const recv = unwrapReceiver(ea.getExpression());
    // callback 内 pass が既に報告した外側束縛 receiver の member は二重報告しない。
    if (
      consumeReportedOuter(
        reported,
        `${canonicalReceiverText(recv)}|[${ea.getArgumentExpression()?.getText() ?? "?"}]`,
      )
    ) {
      continue;
    }
    if (receiverMatch(recv, segmentReceivers, taintedReceivers) === false) continue;
    report(
      r,
      lineOf(ea),
      "manual",
      `segment[${ea.getArgumentExpression()?.getText() ?? "?"}]`,
      "element access on a segment variable — map to OTel Span API by hand",
    );
  }

  // `helper(seg)` / `return seg` / `const { close } = seg` のような member access を
  // 伴わない segment 変数の参照 — Span|undefined 化した値をそのまま引き回す形は
  // 追跡できないので manual にする。宣言位置・member 名位置・call/PA/EA の receiver
  // 位置・束縛式の LHS・追跡済み alias の RHS は他 pass が処理済みなので除外する。
  // PA 束縛（`x.seg`）の root decl 一致で bare `x` を誤検出しないよう、text が
  // tracked entry と一致する identifier だけを対象にする。
  for (const ident of sf.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (ident.wasForgotten()) continue;
    const entry = segmentReceivers.get(ident.getText());
    if (entry === undefined) continue;
    const decls = ident.getSymbol()?.getDeclarations();
    if (decls === undefined || !decls.some((d) => entry.decls.has(d))) continue;
    // `const seg = getSegment()` の name 位置 — 宣言そのもの。
    let cur: Node = ident;
    let parent = cur.getParent();
    if (Node.isVariableDeclaration(parent) && parent.getNameNode() === cur) continue;
    // 包み（`(seg)` / `seg!` / `seg as T`）を登って外側の構文位置で判定する。
    while (
      (Node.isParenthesizedExpression(parent) ||
        Node.isNonNullExpression(parent) ||
        Node.isAsExpression(parent) ||
        Node.isSatisfiesExpression(parent) ||
        Node.isTypeAssertion(parent)) &&
      parent.getExpression() === cur
    ) {
      cur = parent;
      parent = cur.getParent();
    }
    // `x.seg` の member 名位置 — `x` の binding の話であって `seg` 変数の参照ではない。
    if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === cur) continue;
    // `seg.close` / `seg["close"]` の receiver 位置 — PA/EA pass が処理済み。
    if (
      (Node.isPropertyAccessExpression(parent) || Node.isElementAccessExpression(parent)) &&
      parent.getExpression() === cur
    ) {
      continue;
    }
    // 束縛式の LHS（`seg = getSegment()` の `seg`）は宣言相当 — 再代入 use はここで
    // 拾いたいので、site の LHS と一致するときだけ除外する。
    const site = decls.map((d) => bindingSites.get(d)).find((s) => s !== undefined);
    if (
      site !== undefined &&
      Node.isBinaryExpression(site) &&
      unwrapReceiver(site.getLeft()) === cur
    ) {
      continue;
    }
    // 追跡済み alias の束縛 RHS（`const b = seg` の `seg`）— LHS が追跡に積まれている
    // ので alias 経路で処理済み。ここで報告すると alias と二重計上になる。
    if (Node.isVariableDeclaration(parent) && parent.getInitializer() === cur) {
      const lhs = parent.getNameNode();
      if (Node.isIdentifier(lhs) && segmentReceivers.has(lhs.getText())) continue;
    }
    if (
      Node.isBinaryExpression(parent) &&
      parent.getOperatorToken().getKind() === SyntaxKind.EqualsToken &&
      parent.getRight() === cur
    ) {
      const lhsText = canonicalReceiverText(unwrapReceiver(parent.getLeft()));
      if (segmentReceivers.has(lhsText)) continue;
    }
    report(
      r,
      lineOf(ident),
      "manual",
      `segment ${ident.getText()}`,
      "segment variable used outside member calls — map to OTel Span API by hand",
    );
  }

  // 残った `AWSXRay.*` / named import 参照（値・型としての引き回し等）は全て手作業案件。
  reportLeftoverXrayRefs(sf, bindings, r, lineOf);

  // Powertools import を sekimori/tracer に付け替える。
  rewritePowertoolsImports(
    sf,
    bindings,
    { createTracer: shimCreateTracer, sekimoriTracer: shimSekimoriTracer },
    { tracerConstructed, tracerTypeUsed },
    r,
    lineOf,
  );
  // `class X extends Tracer` / `x instanceof Tracer` のような残った Tracer 参照を報告する。
  reportLeftoverTracerRefs(sf, bindings, r, lineOf);

  // `trace` / `SpanStatusCode` は実際に出力した分だけ import する — shim 経路で
  // `trace` を余計に import すると noUnusedLocals / lint で落ちる auto 出力になる。
  const otelSpecs = [
    ...(usedOtelTrace ? [otelTrace] : []),
    ...(otelSpanStatusCode !== undefined ? [otelSpanStatusCode] : []),
  ];
  if (otelSpecs.length > 0) ensureOtelImport(sf, otelSpecs);

  // `require("aws-xray-sdk*")` / `await import("@aws-lambda-powertools/tracer")` の
  // CJS / 動的 import 経路を報告する。
  reportModuleSpecifierCalls(sf, r, lineOf);

  const code = sf.getFullText();
  // 共有 Project に AST を残すと migrate 対象の全ファイル分が溜まるため、
  // 結果を取り出したら source file は破棄する。
  project.removeSourceFile(sf);
  // pass によっては位置降順に走査するため findings の並びは不定 — 報告は
  // ソース順（行）で読めるよう安定ソートする。
  r.findings.sort((a, b) => a.line - b.line);
  return { code, changed: code !== source, findings: r.findings };
}
