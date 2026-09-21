/**
 * segment/method call の rewrite — X-Ray `Segment`/`Subsegment` のメソッド呼び出しと
 * Powertools `Tracer` メソッド呼び出しを OTel API / sekimori shim へ置き換える。
 * 対象外構文は manual finding として報告する。
 */
import { type CallExpression, Node, type PropertyAccessExpression, SyntaxKind } from "ts-morph";
import {
  type EmitCtx,
  type LineOf,
  type Report,
  recordReportedOuter,
  report,
} from "./transform-ctx.js";
import {
  boundTo,
  canonicalReceiverText,
  isMemberWritePosition,
  receiverDecls,
  rootDecls,
  unwrapReceiver,
} from "./transform-receiver.js";
import {
  NON_ARROW_FUNCTION_KINDS,
  OTEL_SPAN_MEMBERS,
  SEGMENT_MANUAL,
  SEGMENT_RENAME,
} from "./transform-tables.js";

/**
 * metadata 値として型を保って写せる literal（string/number/boolean）のテキストを返す。
 * object / 変数参照等は undefined — OTel attribute の primitive 制約に合わせ manual に倒す。
 */
export function primitiveLiteralText(v: Node | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (Node.isStringLiteral(v) || Node.isNoSubstitutionTemplateLiteral(v)) {
    return JSON.stringify(v.getLiteralValue());
  }
  if (Node.isNumericLiteral(v)) return String(v.getLiteralValue());
  const kind = v.getKind();
  if (kind === SyntaxKind.TrueKeyword || kind === SyntaxKind.FalseKeyword) return v.getText();
  return undefined;
}

/** Powertools `new Tracer(options)` → `createTracer(serviceName?)` の引数写像。 */
export function mapTracerArgs(init: Node | undefined, r: Report, lineOf: LineOf): string {
  if (init === undefined) return "";
  if (Node.isObjectLiteralExpression(init)) {
    const options = init;
    const serviceName = options.getProperty("serviceName");
    const others = options
      .getProperties()
      .filter((p) => !(Node.isPropertyAssignment(p) && p.getName() === "serviceName"));
    const arg =
      serviceName && Node.isPropertyAssignment(serviceName)
        ? (serviceName.getInitializer()?.getText() ?? "")
        : "";
    if (others.length > 0) {
      report(
        r,
        lineOf(init),
        "manual",
        "new Tracer(options)",
        `Tracer options dropped by the shim: ${others.map((p) => p.getText()).join(", ")}. ` +
          "Map them to OTel env vars (OTEL_SERVICE_NAME etc.).",
      );
    }
    return arg;
  }
  report(
    r,
    lineOf(init),
    "manual",
    "new Tracer(expr)",
    "Non-literal Tracer options could not be mapped; verify the tracer name manually.",
  );
  return "";
}

/**
 * `seg.addError(err)` / `seg.addMetadata(key, value, ns?)` の rewrite。
 * `recvDot` は `sub.` / `x?.seg?.` のような receiver 式テキスト（dot 込み）。
 * 処理した場合（auto/manual 問わず）true、対象外なら false。
 */
export function rewriteSpecialSegmentCall(
  call: CallExpression,
  method: string,
  recvDot: string,
  ctx: EmitCtx,
  r: Report,
  lineOf: LineOf,
): boolean {
  const line = lineOf(call);
  if (method === "addError") {
    // X-Ray の第 2 引数 `remote`（bool）は fault flag — recordException の第 2 引数
    // （timeUnixNano）と意味が違うので機械変換しない。
    if (call.getArguments().length > 1) {
      report(
        r,
        line,
        "manual",
        "segment.addError",
        "addError(error, remote) has no OTel equivalent — the remote flag is X-Ray-specific",
      );
      return true;
    }
    // `addError(...errs)` — recordException(exception, time?) は rest param でないため
    // spread 展開は型エラーになる。手で引数を選んでもらう。
    if (call.getArguments().some((a) => Node.isSpreadElement(a))) {
      report(
        r,
        line,
        "manual",
        "segment.addError",
        "spread argument — recordException takes a single Exception; expand by hand",
      );
      return true;
    }
    // `addError()` — recordException(undefined) は Exception 型に入らず typecheck が落ちる。
    if (call.getArguments().length === 0) {
      report(
        r,
        line,
        "manual",
        "segment.addError",
        "addError() with no argument — recordException requires an Exception; convert by hand",
      );
      return true;
    }
    // recordException は status を立てない — X-Ray の error 記録に揃えるため
    // recordException + setStatus(ERROR) の 2 文に展開する。式位置では 1 call に
    // 畳めないので statement のときだけ auto にする。
    const parent = call.getParent();
    const errText = call.getArguments()[0]?.getText() ?? "undefined";
    if (Node.isExpressionStatement(parent)) {
      // 2 文への展開は Block で包む — `if (e) seg.addError(err); else f();` のような
      // 非 Block 単文 body だと else が孤立して構文エラーになる。
      // 2 文目の `;` も必須 — 直後が `(` / `[` 始まりの文だと ASI が効かず結合して壊れる。
      parent.replaceWithText(
        `{\n${recvDot}recordException(${errText});\n` +
          `${recvDot}setStatus({ code: ${ctx.spanStatusCode()}.ERROR });\n}`,
      );
      report(
        r,
        line,
        "auto",
        "segment.addError",
        "expanded to recordException + setStatus(ERROR) — recordException alone does not mark the span as an error",
      );
    } else {
      report(
        r,
        line,
        "manual",
        "segment.addError",
        "expression-position addError — emit recordException + setStatus(ERROR) by hand",
      );
    }
    return true;
  }
  if (method === "addMetadata") {
    const [key, value, ns] = call.getArguments();
    if (key === undefined || !Node.isStringLiteral(key)) {
      report(r, line, "manual", "segment.addMetadata", "non-literal metadata key — map by hand");
      return true;
    }
    // `ns` が非 literal なら `metadata.<key>` に倒すと namespace が silent に消える — manual。
    if (ns !== undefined && !Node.isStringLiteral(ns)) {
      report(
        r,
        line,
        "manual",
        "segment.addMetadata",
        "non-literal namespace argument — map to metadata.<ns>.<key> by hand",
      );
      return true;
    }
    // OTel attribute は primitive を型ごと持つ — `5` を `"5"` に文字列化する
    // JSON.stringify は値を壊すため、primitive literal だけを型保存で写す。
    const valueText = primitiveLiteralText(value);
    if (valueText === undefined) {
      report(
        r,
        line,
        "manual",
        "segment.addMetadata",
        "non-literal metadata value — OTel attributes accept primitives only; map by hand",
      );
      return true;
    }
    const attr =
      ns !== undefined
        ? `metadata.${ns.getLiteralValue()}.${key.getLiteralValue()}`
        : `metadata.${key.getLiteralValue()}`;
    call.replaceWithText(`${recvDot}setAttribute(${JSON.stringify(attr)}, ${valueText})`);
    report(r, line, "auto", "segment.addMetadata", "rewrote to span.setAttribute(metadata.*)");
    return true;
  }
  return false;
}

/**
 * 追跡中 receiver 上の OTel Span member（`end` / `setAttribute` 等）は
 * 先行 pass が生成した `seg?.end()` か、ユーザーが OTel 形で書いたコード —
 * "unknown segment method" と誤報しないよう読み飛ばす。
 * `?.` 未補の形（`seg.end`）だけ Span|undefined 用に `?.` を補う。処理したら true。
 */
export function isMigratedSpanMember(
  pa: PropertyAccessExpression,
  recvText: string,
  r: Report,
  lineOf: LineOf,
): boolean {
  const method = pa.getName();
  if (!OTEL_SPAN_MEMBERS.has(method)) return false;
  if (isMemberWritePosition(pa)) {
    // `seg.end = f` / `new seg.end()` 等 — `?.` を挿すと SyntaxError になる位置かつ
    // 機械写できない形なので manual にする。
    report(
      r,
      lineOf(pa),
      "manual",
      `segment.${method}`,
      "span member in a write/call-incompatible position — map to OTel Span API by hand",
    );
    return true;
  }
  if (!pa.hasQuestionDotToken()) {
    pa.replaceWithText(`${recvText}?.${method}`);
    report(r, lineOf(pa), "auto", `segment.${method}`, "added ?. for Span|undefined receiver");
  }
  return true;
}

/**
 * `recv.method(args)` を span メソッドへ書き換える。
 * `recv` は identifier / call のどちらでもよく、Span|undefined になり得るため `?.` を挟む。
 * manual finding を出した場合は true（呼び出し側が callback 内報告の二重計上を
 * 防ぐ記録に使う）。
 */
export function rewriteSegmentMethod(
  call: CallExpression,
  pa: PropertyAccessExpression,
  recvText: string,
  ctx: EmitCtx,
  r: Report,
  lineOf: LineOf,
): boolean {
  const method = pa.getName();
  const line = lineOf(call);
  const before = r.findings.length;
  // `subsegment.close(err)` は error を記録する — `span.end(err)` は Error を
  // endTime に渡す壊れたコードになるため、引数ありの close は manual にする。
  if (method === "close" && call.getArguments().length > 0) {
    report(
      r,
      line,
      "manual",
      "segment.close(err)",
      "close(err) records an error — emit span.recordException(err) then span.end()",
    );
    return true;
  }
  if (rewriteSpecialSegmentCall(call, method, `${recvText}?.`, ctx, r, lineOf)) {
    return r.findings.slice(before).some((f) => f.kind === "manual");
  }
  const renamed = SEGMENT_RENAME.get(method);
  if (renamed !== undefined) {
    pa.replaceWithText(`${recvText}?.${renamed}`);
    report(r, line, "auto", `segment.${method}`, `rewrote to span.${renamed}`);
    return false;
  }
  if (isMigratedSpanMember(pa, recvText, r, lineOf)) {
    return r.findings.slice(before).some((f) => f.kind === "manual");
  }
  report(
    r,
    line,
    "manual",
    `segment.${method}`,
    SEGMENT_MANUAL.has(method)
      ? "no direct OTel equivalent — open a nested span or set attributes by hand"
      : "unknown segment method — map to OTel Span API by hand",
  );
  return true;
}

/**
 * captureAsyncFunc / captureFunc の callback 内の segment メソッドを span メソッドへ書き換える。
 * `outer` は callback 外で `x = getSegment()` 束縛された receiver（decls / 正規 text）—
 * call ループは位置降順で callback 内の use を束縛記録前に通り過ぎるため、
 * mutation 前に収集した decl で `seg.close()` のような外側参照も拾う。
 */
export function rewriteSegmentCalls(
  callback: Node,
  ctx: EmitCtx,
  r: Report,
  lineOf: LineOf,
  outer?: { decls: ReadonlySet<Node>; texts: ReadonlySet<string> },
): void {
  // 第 1 引数（X-Ray が渡す subsegment）に束縛された呼び出しだけを対象にする。
  // conn.close() のような無関係な同名メソッドを書き換えないためのガード。
  const params =
    Node.isArrowFunction(callback) || Node.isFunctionExpression(callback)
      ? callback.getParameters()
      : [];
  // `function (this: T, sub)` — `this` は型注釈専用の偽 param なので読み飛ばし、
  // 先頭の実 param（X-Ray が渡す subsegment）を取る。`this` の name node は
  // ThisKeyword ではなくテキストが "this" の Identifier なので名前で判定する。
  const first = params.find((p) => p.getName() !== "this");
  const segmentName =
    first !== undefined && Node.isIdentifier(first.getNameNode()) ? first.getName() : undefined;
  if (first !== undefined && segmentName === undefined) {
    // `({ close }) => ...` のような分割代入 param — 内側の segment method を追跡できない。
    report(
      r,
      lineOf(first),
      "manual",
      "segment callback param",
      "destructured callback parameter — map segment methods to OTel Span API by hand",
    );
    return;
  }
  if (segmentName === undefined || first === undefined) return;
  for (const call of callback.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    // `sub.addMetadata("k", compute())` を replaceWithText すると引数側の node が
    // forget される — 位置順の stale list を触らないよう各 iteration で確認する。
    if (call.wasForgotten()) continue;
    const expr = call.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) continue;
    const receiver = expr.getExpression();
    // `(sub).close()` / `sub!.close()` のような包み receiver も param 参照として拾う。
    const recvUnwrapped = unwrapReceiver(receiver);
    const isParamRef =
      Node.isIdentifier(recvUnwrapped) &&
      recvUnwrapped.getText() === segmentName &&
      boundTo(recvUnwrapped, first);
    if (!isParamRef) {
      // callback 外で `seg = getSegment()` 束縛された変数の参照 — decl が
      // 収集済みのものに一致すれば `seg?.end()` 系に書き換える（Span|undefined
      // なので `?.` 必須 → rewriteSegmentMethod 経路）。解決不能の同名参照は manual。
      if (outer === undefined) continue;
      const recv = unwrapReceiver(receiver);
      const text = canonicalReceiverText(recv);
      if (!outer.texts.has(text)) continue;
      const decls = receiverDecls(recv) ?? rootDecls(recv);
      if (decls === undefined || decls.length === 0) {
        report(
          r,
          lineOf(call),
          "manual",
          `segment.${expr.getName()}`,
          "receiver binding could not be resolved — verify it is a migrated segment by hand",
        );
        recordReportedOuter(ctx.reportedOuterSegments, `${text}|${expr.getName()}`);
        continue;
      }
      if (!decls.some((d) => outer.decls.has(d))) continue;
      // `seg = getSegment(); seg = other` — 束縛後に再代入された decl はもう segment を
      // 指さないので書き換えず manual に倒す（file-level PA pass と同じ規約）。
      if (ctx.taintedReceivers !== undefined && decls.some((d) => ctx.taintedReceivers?.has(d))) {
        report(
          r,
          lineOf(call),
          "manual",
          `segment.${expr.getName()}`,
          "receiver was reassigned after binding — verify it is still a segment by hand",
        );
        recordReportedOuter(ctx.reportedOuterSegments, `${text}|${expr.getName()}`);
        continue;
      }
      // rewrite text は `x?.seg` の `?.` を保つ生 text を使う — canonical（`x.seg`）で
      // 書き換えると `x` が nullish のとき元コードは安全だったのに throw するコードになる。
      const emittedManual = rewriteSegmentMethod(call, expr, receiver.getText(), ctx, r, lineOf);
      if (emittedManual) {
        recordReportedOuter(ctx.reportedOuterSegments, `${text}|${expr.getName()}`);
      }
      continue;
    }
    // callback 引数の subsegment は常に存在するので optional chain は要らない
    const method = expr.getName();
    const line = lineOf(call);
    // `close(err)` は error を記録する — `end(err)` に写すと意味が壊れるので manual。
    if (method === "close" && call.getArguments().length > 0) {
      report(
        r,
        line,
        "manual",
        "segment.close(err)",
        "close(err) records an error — emit span.recordException(err) then span.end()",
      );
      continue;
    }
    const renamed = SEGMENT_RENAME.get(method);
    if (renamed !== undefined) {
      expr.getNameNode().replaceWithText(renamed);
      report(r, line, "auto", `segment.${method}`, `rewrote to span.${renamed}`);
      continue;
    }
    if (rewriteSpecialSegmentCall(call, method, `${segmentName}.`, ctx, r, lineOf)) continue;
    // param 上の OTel member（`sub.end()` 等）は既に移行済み — 誤報しない。
    if (OTEL_SPAN_MEMBERS.has(method)) continue;
    report(
      r,
      line,
      "manual",
      `segment.${method}`,
      SEGMENT_MANUAL.has(method)
        ? "no direct OTel equivalent — open a nested span or set attributes by hand"
        : "unknown segment method — map to OTel Span API by hand",
    );
  }
  // call ではない member access（`sub.id` 等）も拾う — Span にその member は無い。
  // callback 外束縛の segment 変数（`seg = getSegment()` して callback 内で参照）も対象。
  for (const pa of callback.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
    if (pa.wasForgotten()) continue;
    const recv = pa.getExpression();
    const parent = pa.getParent();
    if (Node.isCallExpression(parent) && parent.getExpression() === pa) continue;
    // `(sub).end` / `sub!.end` のような包み receiver も param 参照として拾う。
    const recvUnwrapped = unwrapReceiver(recv);
    const onParam =
      Node.isIdentifier(recvUnwrapped) &&
      recvUnwrapped.getText() === segmentName &&
      boundTo(recvUnwrapped, first);
    if (!onParam) {
      if (outer === undefined) continue;
      const r2 = unwrapReceiver(recv);
      const text = canonicalReceiverText(r2);
      if (!outer.texts.has(text)) continue;
      const memberKey = `${text}|${pa.getName()}`;
      const decls = receiverDecls(r2) ?? rootDecls(r2);
      // 解決不能のテキスト一致と decl 一致の両方で manual — Span|undefined 化した
      // 変数への member access は残すと型エラーになる。
      if (decls !== undefined && decls.length > 0 && !decls.some((d) => outer.decls.has(d))) {
        continue;
      }
      // 束縛後に再代入された decl はもう segment を指さない（call 側と同じ規約）。
      if (
        decls !== undefined &&
        ctx.taintedReceivers !== undefined &&
        decls.some((d) => ctx.taintedReceivers?.has(d))
      ) {
        report(
          r,
          lineOf(pa),
          "manual",
          `segment.${pa.getName()}`,
          "receiver was reassigned after binding — verify it is still a segment by hand",
        );
        recordReportedOuter(ctx.reportedOuterSegments, memberKey);
        continue;
      }
    }
    // 追跡中 receiver 上の OTel member（`sub.end` / `seg?.end`）は既に移行済み —
    // 誤報しない。外側束縛（Span|undefined）側の `?.` 未補形だけ `?.` を補う。
    // `?.` を補う rewrite text は生の receiver text（`x?.seg`）を使う — canonical だと
    // 既存の `?.` が剥げて nullish receiver で throw するコードになる。
    if (OTEL_SPAN_MEMBERS.has(pa.getName())) {
      if (!onParam) {
        isMigratedSpanMember(pa, recv.getText(), r, lineOf);
      } else if (isMemberWritePosition(pa)) {
        // `sub.end = f` — param receiver の member への書き込みは shim の span に写せない。
        report(
          r,
          lineOf(pa),
          "manual",
          `segment.${pa.getName()}`,
          "span member in a write/call-incompatible position — map to OTel Span API by hand",
        );
      }
      continue;
    }
    report(
      r,
      lineOf(pa),
      "manual",
      `segment.${pa.getName()}`,
      "member access on a segment variable — map to OTel Span API by hand",
    );
    if (!onParam) {
      recordReportedOuter(
        ctx.reportedOuterSegments,
        `${canonicalReceiverText(unwrapReceiver(recv))}|${pa.getName()}`,
      );
    }
  }
  const firstNameNode = first.getNameNode();
  // `fn(sub)` のように member でもない位置で subsegment を引き回す形 — 追跡できないので manual。
  // `sub["close"]` のような element access も文字列 key なので rename 規則は適用できない。
  for (const ident of callback.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (ident.wasForgotten() || ident === firstNameNode) continue;
    if (ident.getText() !== segmentName || !boundTo(ident, first)) continue;
    // `(sub).m` / `sub!.m` のような wrapper（paren/非null/as/satisfies）内の receiver
    // 位置は call/PA ループが処理済み — wrapper を登って判定する。
    let cur: Node = ident;
    let parent = cur.getParent();
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
    // `sub.method` / `sub.prop` の receiver 位置は call/PA ループが処理済み。
    if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === cur) continue;
    // `x.sub` の name 位置 — `x` が any 等で member 名が解決不能でも text が
    // segment param と一致するだけで誤検出するため、member 名位置は対象外。
    if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === ident) continue;
    // `sub[k]` / `(sub)[k]` は EA ループが報告済み。
    if (Node.isElementAccessExpression(parent) && parent.getExpression() === cur) continue;
    report(
      r,
      lineOf(ident),
      "manual",
      `segment ${segmentName}`,
      "segment reference outside member calls — map to OTel Span API by hand",
    );
  }
  for (const ea of callback.getDescendantsOfKind(SyntaxKind.ElementAccessExpression)) {
    if (ea.wasForgotten()) continue;
    // `(sub)[k]` / `sub![k]` のような包み receiver も拾う。
    const target = unwrapReceiver(ea.getExpression());
    if (!Node.isIdentifier(target)) continue;
    if (target.getText() === segmentName && boundTo(target, first)) {
      report(
        r,
        lineOf(ea),
        "manual",
        `${segmentName}[...]`,
        "element access on the segment parameter — map to OTel Span API by hand",
      );
      continue;
    }
    // 外側束縛の segment 変数への element access — 文字列 key には rename を機械適用できない。
    // `x.seg["close"]` のような member receiver（unwrap 後が PA）も canonical text で拾う。
    const targetText = canonicalReceiverText(target);
    if (outer?.texts.has(targetText)) {
      const decls = receiverDecls(target) ?? rootDecls(target);
      if (decls !== undefined && decls.length > 0 && !decls.some((d) => outer.decls.has(d))) {
        continue;
      }
      const arg = ea.getArgumentExpression()?.getText() ?? "?";
      report(
        r,
        lineOf(ea),
        "manual",
        `segment[${arg}]`,
        "element access on a segment variable — map to OTel Span API by hand",
      );
      // callback の replaceWithText で再 parse された node を file EA pass が再報告しないよう記録。
      recordReportedOuter(ctx.reportedOuterSegments, `${targetText}|[${arg}]`);
      continue;
    }
    // `function (sub) { arguments[0].close() }` — arguments 経由の param 参照。
    // arrow function は arguments を bind しないので FunctionExpression のときだけ、
    // かつ途中に arrow 以外の関数境界（別関数の arguments）を挟まないときに限定する。
    if (target.getText() !== "arguments" || !Node.isFunctionExpression(callback)) continue;
    let owner: Node | undefined = ea.getParent();
    while (owner !== undefined && owner !== callback) {
      if (!Node.isArrowFunction(owner) && NON_ARROW_FUNCTION_KINDS.has(owner.getKind())) break;
      owner = owner.getParent();
    }
    if (owner !== callback) continue;
    report(
      r,
      lineOf(ea),
      "manual",
      `arguments[${ea.getArgumentExpression()?.getText() ?? "?"}]`,
      "arguments object over the segment parameter — map to OTel Span API by hand",
    );
  }
}
