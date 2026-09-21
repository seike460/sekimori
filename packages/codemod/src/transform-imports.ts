/**
 * import 管理 — 生成コードが参照する名前（`trace` / `SpanStatusCode` / shim 名）の
 * 解決・衝突回避・import 文挿入を担う。変換意味論は持たない。
 */
import { Node, type SourceFile, SyntaxKind } from "ts-morph";
import { boundToAny } from "./transform-receiver.js";
import { OTEL_MODULE, SHIM_MODULE } from "./transform-tables.js";

/** import 群の直後に import を挿入する（`addImportDeclaration` はファイル末尾に足してしまう）。 */
export function insertImport(
  sf: SourceFile,
  moduleSpecifier: string,
  namedImports: (string | { name: string; isTypeOnly?: boolean; alias?: string })[],
): void {
  const imports = sf.getImportDeclarations();
  const last = imports[imports.length - 1];
  let at: number;
  if (last !== undefined) {
    at = last.getChildIndex() + 1;
  } else if (sf.getFullText().startsWith("#!")) {
    // `#!` shebang — index 0 への挿入は shebang の前に出て構文エラーになる。
    // import は hoisted なので先頭文の後に挿しても semantic は変わらない。
    at = Math.min(1, sf.getStatements().length);
  } else {
    // import が 1 つも無いとき、先頭の directive prologue を追い越すと directive が
    // 無効化される — その直後に挿す。prologue は先頭の連続する string literal 文
    // すべて（`"custom"; "use strict";` の `"use strict"` も directive なので
    // `"use "` prefix だけを見ると誤って途中に挿してしまう）。
    at = 0;
    for (const stmt of sf.getStatements()) {
      const expr = Node.isExpressionStatement(stmt) ? stmt.getExpression() : undefined;
      if (expr && Node.isStringLiteral(expr)) {
        at = stmt.getChildIndex() + 1;
      } else {
        break;
      }
    }
  }
  sf.insertImportDeclaration(at, { moduleSpecifier, namedImports });
}

/**
 * `moduleSpecifier` の named export `exportName` を生成コードから参照するときのローカル名。
 * 既存 import が束縛済みかつ shadow されないならその名を再利用（bound: true）。
 * そうでなければファイル内のどの Identifier とも衝突しない fresh 名を返す（bound: false）。
 */
export function resolveImportedName(
  sf: SourceFile,
  moduleSpecifier: string,
  exportName: string,
  freshCandidates: string[],
): { name: string; bound: boolean; exportName: string } {
  for (const imp of sf.getImportDeclarations()) {
    if (imp.getModuleSpecifierValue() !== moduleSpecifier) continue;
    if (imp.isTypeOnly() || imp.getNamespaceImport() !== undefined) continue;
    for (const n of imp.getNamedImports()) {
      if (n.getName() !== exportName) continue;
      // `import { type trace }` は value binding を作らない — 再利用すると生成コードが
      // type-only 名を値参照して TS1361 になる。skip して fresh 名に倒す。
      if (n.isTypeOnly()) continue;
      const boundName = n.getAliasNode()?.getText() ?? exportName;
      // 既存 import が束縛していても、内側 scope で同名 binding（param 等）に shadow される
      // 場所があると生成コードがそちらを指す — その場合は再利用せず fresh 名に倒す。
      let shadowed = false;
      for (const ident of sf.getDescendantsOfKind(SyntaxKind.Identifier)) {
        if (ident.getText() !== boundName) continue;
        if (!boundToAny(ident, new Set([n]))) {
          shadowed = true;
          break;
        }
      }
      if (!shadowed) return { name: boundName, bound: true, exportName };
    }
  }
  return { name: pickFreshName(sf, exportName, freshCandidates), bound: false, exportName };
}

/**
 * 生成コードが参照する `trace`（@opentelemetry/api の named export）のローカル名を決める。
 * ファイル内に同名の binding（import / 変数 / param 等）が既にあると shadow で壊れるため、
 * 衝突時は `import { trace as otelTrace }` のように alias を引く。
 * `bound: true` は既存の otel import が `trace` を束縛済み（alias 含む）= import 追加不要。
 */
export function resolveOtelTraceName(sf: SourceFile): {
  name: string;
  bound: boolean;
  exportName: string;
} {
  return resolveImportedName(sf, OTEL_MODULE, "trace", ["trace", "otelTrace", "otelApiTrace"]);
}

/**
 * 生成コードが参照する `createTracer`（sekimori/tracer の named export）のローカル名を決める。
 * 既に `import { createTracer } from "sekimori/tracer"` があるなら再利用し、
 * 同名 binding との衝突時は `import { createTracer as sekimoriCreateTracer }` に逃げる。
 */
export function resolveShimName(sf: SourceFile): {
  name: string;
  bound: boolean;
  exportName: string;
} {
  return resolveImportedName(sf, SHIM_MODULE, "createTracer", [
    "createTracer",
    "sekimoriCreateTracer",
  ]);
}

/** ファイル内のどの Identifier とも衝突しない名前を candidates → base2 → base3 … の順に選ぶ。 */
export function pickFreshName(sf: SourceFile, base: string, candidates: string[]): string {
  const taken = new Set<string>();
  for (const ident of sf.getDescendantsOfKind(SyntaxKind.Identifier)) taken.add(ident.getText());
  for (const candidate of candidates) {
    if (!taken.has(candidate)) return candidate;
  }
  let i = 2;
  while (taken.has(`${base}${i}`)) i++;
  return `${base}${i}`;
}

export function ensureOtelImport(
  sf: SourceFile,
  resolved: { name: string; bound: boolean; exportName: string }[],
): void {
  const specs = resolved
    .filter((x) => !x.bound)
    .map((x) => (x.name === x.exportName ? x.exportName : { name: x.exportName, alias: x.name }));
  if (specs.length === 0) return;
  for (const imp of sf.getImportDeclarations()) {
    if (imp.getModuleSpecifierValue() !== OTEL_MODULE) continue;
    // `import type { ... }` / `import * as ns` には値 binding を足せない — 新しい import を挿す。
    if (imp.isTypeOnly() || imp.getNamespaceImport() !== undefined) continue;
    imp.addNamedImports(specs);
    return;
  }
  insertImport(sf, OTEL_MODULE, specs);
}
