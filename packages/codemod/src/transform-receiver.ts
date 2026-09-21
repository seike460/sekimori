/**
 * receiver 追跡 — `const t = new Tracer()` / `seg = getSegment()` のような束縛を
 * AST 上で辿り、callback 内の receiver が追跡対象と一致するか判定する。
 * 変換の emit 側（transform-segments.ts）から参照される pure な解析層。
 */
import {
  type CallExpression,
  Node,
  type PropertyAccessExpression,
  type SourceFile,
  SyntaxKind,
} from "ts-morph";
import { type LineOf, type Report, report } from "./transform-ctx.js";
import { ASSIGNMENT_OPS, ASSIGNMENT_TOKENS } from "./transform-tables.js";

/** receiver の糖衣（`x!` / `(x)` / `x as T` / `x satisfies T` / `<T>x`）を再帰的に剥がす。 */
export function unwrapReceiver(node: Node): Node {
  if (
    Node.isNonNullExpression(node) ||
    Node.isParenthesizedExpression(node) ||
    Node.isAsExpression(node) ||
    Node.isSatisfiesExpression(node) ||
    Node.isTypeAssertion(node)
  ) {
    return unwrapReceiver(node.getExpression());
  }
  return node;
}

/**
 * `x?.seg` / `(x)!.seg` のような包み（`?.` / `!` / paren / as / satisfies / `<T>`）を
 * 剥がした正規 receiver text（`x.seg`）を返す。束縛側・use 側のどちらに wrapper が
 * 付いても同じ key になるよう、map の key と lookup の両方でこれを使う。
 */
export function canonicalReceiverText(node: Node): string {
  let cur = unwrapReceiver(node);
  const parts: string[] = [];
  while (Node.isPropertyAccessExpression(cur)) {
    parts.unshift(cur.getName());
    cur = unwrapReceiver(cur.getExpression());
  }
  return parts.length === 0 ? cur.getText() : `${cur.getText()}.${parts.join(".")}`;
}

/** receiver として解釈できる node の束縛宣言を返す。解決不能なら undefined。 */
export function receiverDecls(recv: Node): Node[] | undefined {
  const ident = Node.isIdentifier(recv)
    ? recv
    : Node.isPropertyAccessExpression(recv)
      ? recv.getNameNode()
      : undefined;
  return ident?.getSymbol()?.getDeclarations();
}

/**
 * `x.seg.close()` の receiver `x.seg` のように member 名が解決不能なとき、
 * 左端の identifier（root）の宣言を返す — 同一 binding 判定の fallback。
 * `this` 等 identifier で終わらない chain は undefined。
 */
export function rootDecls(recv: Node): Node[] | undefined {
  let cur = unwrapReceiver(recv);
  while (Node.isPropertyAccessExpression(cur)) cur = unwrapReceiver(cur.getExpression());
  return Node.isIdentifier(cur) ? cur.getSymbol()?.getDeclarations() : undefined;
}

/** ident が `decl`（callback の param 等）に束縛されているか。解決不能なら true（現状どおり扱う）。 */
export function boundTo(ident: Node, decl: Node): boolean {
  const decls = Node.isIdentifier(ident) ? ident.getSymbol()?.getDeclarations() : undefined;
  if (decls === undefined || decls.length === 0) return true;
  return decls.includes(decl);
}

/**
 * import の束縛名 node → use 側の `getSymbol().getDeclarations()` が返す宣言 node。
 * `getDefaultImport()` / `getNamespaceImport()` は name Identifier を返すが、symbol の
 * declaration は親の ImportClause / NamespaceImport になる。named import は
 * ImportSpecifier 自身が declaration。一致比較用に正規化する。
 */
export function importDeclOf(nameNode: Node): Node {
  if (Node.isIdentifier(nameNode)) {
    const decls = nameNode.getSymbol()?.getDeclarations();
    const first = decls?.[0];
    if (first !== undefined) return first;
  }
  return nameNode;
}

/**
 * ident が `decls` のどれか（import の name node / specifier 等）に束縛されているか。
 * 同名の別 binding（shadow された param 等）は false — 解決不能なら true（保守的に扱う）。
 */
export function boundToAny(ident: Node, decls: ReadonlySet<Node>): boolean {
  const found = Node.isIdentifier(ident) ? ident.getSymbol()?.getDeclarations() : undefined;
  if (found === undefined || found.length === 0) return true;
  return found.some((d) => decls.has(d));
}

/**
 * PA が `?.` を挿せない位置（member chain の先が write/call 不可能な位置）にあるか。
 * `seg.end = f` / `seg.end++` / `new seg.end()` / `for (seg.end in x)` /
 * `` seg.end`tpl` `` / `delete seg.end` への挿入は SyntaxError になる。
 * `seg.end.foo = x` のような深い chain でも先端ではなく chain 側の親位置で判定する。
 */
export function isMemberWritePosition(pa: PropertyAccessExpression): boolean {
  let cur: Node = pa;
  for (;;) {
    const p = cur.getParent();
    if (p === undefined) return false;
    // member chain / call callee / 糖衣 wrapper の途中 — 親側へ登り続ける。
    if (
      (Node.isPropertyAccessExpression(p) && p.getExpression() === cur) ||
      (Node.isElementAccessExpression(p) && p.getExpression() === cur) ||
      (Node.isCallExpression(p) && p.getExpression() === cur) ||
      (Node.isNonNullExpression(p) && p.getExpression() === cur) ||
      (Node.isParenthesizedExpression(p) && p.getExpression() === cur) ||
      (Node.isAsExpression(p) && p.getExpression() === cur) ||
      (Node.isSatisfiesExpression(p) && p.getExpression() === cur) ||
      (Node.isTypeAssertion(p) && p.getExpression() === cur)
    ) {
      cur = p;
      continue;
    }
    // optional chain は `new` の callee や tagged template の tag になれない。
    if (Node.isNewExpression(p) && p.getExpression() === cur) return true;
    if (Node.isTaggedTemplateExpression(p) && p.getTag() === cur) return true;
    // 代入 LHS / 複合代入 LHS — optional chain は代入先になれない。
    if (
      Node.isBinaryExpression(p) &&
      p.getLeft() === cur &&
      ASSIGNMENT_OPS.has(p.getOperatorToken().getText())
    ) {
      return true;
    }
    // `seg.end++` / `++seg.end` — 同上。
    if (Node.isPostfixUnaryExpression(p)) return true;
    if (
      Node.isPrefixUnaryExpression(p) &&
      (p.getOperatorToken() === SyntaxKind.PlusPlusToken ||
        p.getOperatorToken() === SyntaxKind.MinusMinusToken)
    ) {
      return true;
    }
    // `for (seg.end in x)` / `for (seg.end of x)` の LHS。
    if ((Node.isForInStatement(p) || Node.isForOfStatement(p)) && p.getInitializer() === cur) {
      return true;
    }
    // `delete seg.end` — `delete a?.b` は構文上有効だが span member の削除は意味を成さない。
    if (Node.isDeleteExpression(p) && p.getExpression() === cur) return true;
    return false;
  }
}

/** 追跡中の receiver の束縛情報。`roots` は PA 束縛で root が `this` 以外のときの root 宣言集合。 */
export interface TrackedReceiver {
  decls: Set<Node>;
  roots?: Set<Node>;
}

/**
 * `x = <expr>` / `x.prop = <expr>` / `const x = <expr>` の束縛先を取る。
 * `decls` は束縛の宣言 node（scope 判定用）。解決不能なら空配列（= テキスト一致に倒す）。
 * `site` は束縛を行った node（VariableDeclaration / BinaryExpression / PropertyDeclaration）—
 * 後から別の式で再代入された binding を検出するのに使う。
 */
export function boundTarget(
  expr: Node,
): { text: string; decls: Node[]; site: Node; roots?: Node[] } | undefined {
  const parent = expr.getParent();
  if (Node.isVariableDeclaration(parent) && parent.getInitializer() === expr) {
    const name = parent.getNameNode();
    return Node.isIdentifier(name)
      ? { text: name.getText(), decls: [parent], site: parent }
      : undefined;
  }
  if (
    Node.isBinaryExpression(parent) &&
    parent.getOperatorToken().getKind() === SyntaxKind.EqualsToken &&
    parent.getRight() === expr
  ) {
    const left = parent.getLeft();
    if (Node.isIdentifier(left) || Node.isPropertyAccessExpression(left)) {
      // member 名が解決不能（`x.seg` で x: any 等）なら root の宣言を記録する —
      // 後続の `x.seg.close()` が同じ x に束縛されるか use 側で比較できる。
      // root が `this` 以外の PA は member decl が type 共有されるため root 宣言も記録する。
      let cur: Node = left;
      while (Node.isPropertyAccessExpression(cur)) cur = unwrapReceiver(cur.getExpression());
      const roots = Node.isIdentifier(cur) ? (rootDecls(left) ?? []) : undefined;
      return {
        // `(x).seg` / `x!.seg` の束縛と `x.seg` の use が一致するよう正規 text を key にする。
        text: canonicalReceiverText(left),
        decls: receiverDecls(left) ?? rootDecls(left) ?? [],
        site: parent,
        ...(Node.isPropertyAccessExpression(left) && roots !== undefined ? { roots } : {}),
      };
    }
  }
  if (Node.isPropertyDeclaration(parent) && parent.getInitializer() === expr) {
    return { text: `this.${parent.getName()}`, decls: [parent], site: parent };
  }
  return undefined;
}

/**
 * 束縛 site が書いた LHS の正規 text を返す。`x.seg = ...` なら `"x.seg"`。
 * member 名が解決不能な PA LHS の再代入判定で「同じ member への書き込みか」を
 * 照合するために使う（root 変数自身への再代入や別 member への書き込みと区別する）。
 */
export function bindingSiteText(site: Node): string | undefined {
  if (Node.isVariableDeclaration(site)) {
    const name = site.getNameNode();
    return Node.isIdentifier(name) ? name.getText() : undefined;
  }
  if (Node.isBinaryExpression(site)) {
    return canonicalReceiverText(unwrapReceiver(site.getLeft()));
  }
  if (Node.isPropertyDeclaration(site)) return `this.${site.getName()}`;
  return undefined;
}

/**
 * LHS（identifier / PA）の書き込みが追跡中 binding の再代入なら `out` に積む。
 * - identifier LHS（`seg = other` / `seg += x`）: decl を bindingSites と照合する。
 * - PA LHS（`seg.end = f`）: member への書き込みであって root の再代入ではないので、
 *   member decl が tracked binding（`x.seg = getSegment()` の束縛 decl）に一致する
 *   ときだけ taint する。member が解決不能（root が any 等）なら root decl で照合するが、
 *   site が同じ member への束縛（site text が一致）のときに限る — 無条件に root に
 *   倒すと `x.other = f` が `x.seg` 束縛を汚す。
 * - `site`/`exclude` は束縛式自身の誤検出を防ぐ照合材料。
 */
export function taintIfRebound(
  left: Node,
  bindingSites: ReadonlyMap<Node, Node>,
  out: Set<Node>,
  exclude?: Node,
): void {
  if (Node.isPropertyAccessExpression(left)) {
    const memberDecls = receiverDecls(left);
    if (memberDecls !== undefined) {
      for (const d of memberDecls) {
        const site = bindingSites.get(d);
        if (site !== undefined && site !== exclude) out.add(d);
      }
      return;
    }
    const text = canonicalReceiverText(left);
    for (const d of rootDecls(left) ?? []) {
      const site = bindingSites.get(d);
      if (site !== undefined && site !== exclude && bindingSiteText(site) === text) {
        out.add(d);
      }
    }
    return;
  }
  for (const d of receiverDecls(left) ?? rootDecls(left) ?? []) {
    const site = bindingSites.get(d);
    if (site !== undefined && site !== exclude) out.add(d);
  }
}

/**
 * 追跡中 receiver の decl が束縛後に別の式で再代入されていないか調べ、
 * 再代入があれば `out` に積む（use 側は書き換えず manual に倒す）。
 * 束縛 site 自身の `seg = getSegment()` は再代入ではないので `bindingSites` と照合する。
 * `for (seg of xs)` / `for (seg in obj)`、`seg += x` 系の複合代入、`seg++` も再代入に含める。
 */
export function collectTaintedReceivers(
  sf: SourceFile,
  bindingSites: ReadonlyMap<Node, Node>,
  out: Set<Node>,
): void {
  for (const be of sf.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    if (be.wasForgotten()) continue;
    if (!ASSIGNMENT_TOKENS.has(be.getOperatorToken().getKind())) continue;
    taintIfRebound(unwrapReceiver(be.getLeft()), bindingSites, out, be);
  }
  for (const kind of [SyntaxKind.ForOfStatement, SyntaxKind.ForInStatement] as const) {
    for (const loop of sf.getDescendantsOfKind(kind)) {
      const init = loop.getInitializer();
      if (init.getKind() === SyntaxKind.VariableDeclarationList) continue;
      taintIfRebound(unwrapReceiver(init), bindingSites, out);
    }
  }
  // `seg++` / `x.seg--` — unary update も値を非 segment に変える再代入。
  for (const kind of [
    SyntaxKind.PrefixUnaryExpression,
    SyntaxKind.PostfixUnaryExpression,
  ] as const) {
    for (const unary of sf.getDescendantsOfKind(kind)) {
      const op = unary.getOperatorToken();
      if (op !== SyntaxKind.PlusPlusToken && op !== SyntaxKind.MinusMinusToken) continue;
      taintIfRebound(unwrapReceiver(unary.getOperand()), bindingSites, out);
    }
  }
}

export function trackReceiver(
  map: Map<string, TrackedReceiver>,
  target: { text: string; decls: Node[]; site: Node; roots?: Node[] },
  bindingSites: Map<Node, Node>,
): void {
  const entry = map.get(target.text) ?? { decls: new Set<Node>() };
  for (const d of target.decls) {
    entry.decls.add(d);
    bindingSites.set(d, target.site);
  }
  // 非 `this` root の PA 束縛 — use 側で root identifier の宣言一致も必須にする。
  // 同名 text が複数 scope で束縛され得るため roots は union で持つ。
  if (target.roots !== undefined) {
    entry.roots ??= new Set<Node>();
    for (const d of target.roots) entry.roots.add(d);
  }
  map.set(target.text, entry);
}

/**
 * `const b = recv` / `a = b` のような alias 束縛 — RHS が追跡中 receiver に束縛されて
 * いれば LHS も追跡に積む。積まないと `b.close()`（segment）や `x.getSegment()`
 * （tracer）が silent に残る。文書順に処理すれば chain（`c = b`）も追える。
 * RHS の binding identity は `receiverMatch` で検証する — テキスト一致だけだと
 * 内側 scope の同名 param（`function inner(seg){ const b = seg; ... }`）を誤変換する。
 * "unresolved"（解決不能 / 再代入済み）は manual に倒す。
 */
export function collectAliasReceivers(
  sf: SourceFile,
  map: Map<string, TrackedReceiver>,
  taintedReceivers: ReadonlySet<Node>,
  bindingSites: Map<Node, Node>,
  r: Report,
  lineOf: LineOf,
  kind: "segment" | "tracer",
): void {
  const aliasAssigns = [
    ...sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration),
    ...sf.getDescendantsOfKind(SyntaxKind.BinaryExpression),
  ].sort((a, b) => a.getStart() - b.getStart());
  for (const node of aliasAssigns) {
    if (node.wasForgotten()) continue;
    let left: Node | undefined;
    let right: Node | undefined;
    if (Node.isVariableDeclaration(node)) {
      left = node.getNameNode();
      right = node.getInitializer();
    } else if (node.getOperatorToken().getKind() === SyntaxKind.EqualsToken) {
      left = node.getLeft();
      right = node.getRight();
    }
    if (left === undefined || right === undefined) continue;
    const match = receiverMatch(unwrapReceiver(right), map, taintedReceivers);
    if (match === false) continue;
    if (match === "unresolved") {
      report(
        r,
        lineOf(right),
        "manual",
        `${kind} alias`,
        `alias of an unresolved or reassigned ${kind} binding — verify by hand`,
      );
      continue;
    }
    const lhs = unwrapReceiver(left);
    if (!Node.isIdentifier(lhs) && !Node.isPropertyAccessExpression(lhs)) continue;
    // 非 `this` root の PA（`x.s = seg`）は member decl が type 共有されるため
    // boundTarget と同じく root identifier の宣言も記録する。
    let lcur: Node = lhs;
    while (Node.isPropertyAccessExpression(lcur)) lcur = unwrapReceiver(lcur.getExpression());
    const lRoots = Node.isIdentifier(lcur) ? (rootDecls(lhs) ?? []) : undefined;
    trackReceiver(
      map,
      {
        text: canonicalReceiverText(lhs),
        decls: receiverDecls(lhs) ?? rootDecls(lhs) ?? [],
        site: node,
        ...(lRoots !== undefined ? { roots: lRoots } : {}),
      },
      bindingSites,
    );
  }
}

/**
 * `<recv>.getSegment()` / `getSegment()` の呼び出しが X-Ray alias / named import /
 * tracer 束縛のどれ由来かを返す。named import（`import { getSegment }`）は
 * bare-identifier callee として現れ、inner call の receiver が無いため別途見る。
 */
export function getSegmentReceiverKind(
  call: CallExpression,
  ctx: {
    xrayAliases: ReadonlySet<string>;
    xrayAliasDecls: ReadonlySet<Node>;
    xraySegmentImports: ReadonlyMap<string, Node>;
    tracerReceivers: ReadonlyMap<string, TrackedReceiver>;
    tainted: ReadonlySet<Node>;
  },
): "xray" | "tracer" | "tracer-unresolved" | undefined {
  const callee = call.getExpression();
  if (Node.isIdentifier(callee)) {
    const spec = ctx.xraySegmentImports.get(callee.getText());
    if (spec === undefined) return undefined;
    // `import { getSegment }` が別 binding に shadow されているなら X-Ray の call ではない。
    return boundToAny(callee, new Set([spec])) ? "xray" : undefined;
  }
  if (!Node.isPropertyAccessExpression(callee)) return undefined;
  const method = callee.getName();
  if (method !== "getSegment" && method !== "resolveSegment") return undefined;
  // `this.tracer.getSegment()` のように receiver が identifier 以外（PA / `x!`）でも拾う。
  const recv = unwrapReceiver(callee.getExpression());
  if (
    ctx.xrayAliases.has(recv.getText()) &&
    (!Node.isIdentifier(recv) || boundToAny(recv, ctx.xrayAliasDecls))
  ) {
    return "xray";
  }
  if (method === "getSegment") {
    const m = receiverMatch(recv, ctx.tracerReceivers, ctx.tainted);
    if (m === "match") return "tracer";
    if (m === "unresolved") return "tracer-unresolved";
  }
  return undefined;
}

/**
 * 追跡中の receiver（getSegment()/new Tracer() の束縛先）と一致するか。
 * 同名の別 binding（内側 scope の shadow 変数等）を誤って書き換えないよう、
 * symbol の宣言が記録した宣言と一致するときだけ "match" にする。
 * "unresolved" は束縛側が解決不能（`x.seg = getSegment()` で x 自体が未解決）で
 * use 側も解決不能なテキスト一致 — 同一 binding か証明できないため manual に倒す。
 */
export function receiverMatch(
  recv: Node,
  map: ReadonlyMap<string, TrackedReceiver>,
  tainted?: ReadonlySet<Node>,
): "match" | "unresolved" | false {
  // `x?.seg` / `(x)!.seg` の use と `x.seg` の束縛を一致させるため正規 text で引く。
  const tracked = map.get(canonicalReceiverText(recv));
  if (tracked === undefined) return false;
  // member 名（`x.seg` の `seg`）が解決不能なら root identifier（`x`）の宣言に倒す。
  const decls = receiverDecls(recv) ?? rootDecls(recv);
  if (decls === undefined || decls.length === 0) {
    // 束縛側・use 側ともに宣言が取れないテキスト一致は別 binding の可能性を消せない —
    // rewrite せず manual に倒す（tracked が空 = 束縛側も完全に未解決）。
    return tracked.decls.size === 0 ? "unresolved" : "match";
  }
  if (!decls.some((d) => tracked.decls.has(d))) return false;
  // `x.seg = getSegment()` で束縛した PA は member decl が type レベルで共有されるため、
  // 同じ interface の別 scope の `x.seg` でも一致してしまう。root が `this` でない PA は
  // root identifier の宣言一致も必須にする（`this.seg` は instance 固有なので member のみ）。
  if (tracked.roots !== undefined) {
    const useRoots = rootDecls(recv);
    if (useRoots === undefined || !useRoots.some((d) => tracked.roots?.has(d))) {
      return "unresolved";
    }
  }
  // `seg = getSegment(); seg = other; seg.close()` — 束縛後に再代入された decl は
  // もう segment を指さないので書き換えず manual に倒す。
  if (tainted !== undefined && decls.some((d) => tainted.has(d))) return "unresolved";
  return "match";
}
