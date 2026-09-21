/**
 * module 参照 pass — X-Ray / Powertools の import・export・require・dynamic import を
 * 走査して束縛表を組み立て、機械変換できない経路を findings に報告する。
 * Powertools import の shim 付け替えと leftover 参照の報告もここ。
 */
import { type ImportDeclaration, Node, type SourceFile, SyntaxKind } from "ts-morph";
import { type LineOf, type Report, report } from "./transform-ctx.js";
import { insertImport, type resolveImportedName } from "./transform-imports.js";
import { boundToAny, importDeclOf } from "./transform-receiver.js";
import {
  POWERTOOLS_TRACER_MODULE,
  SHIM_MODULE,
  TEST_HOOK_METHODS,
  XRAY_MODULES,
} from "./transform-tables.js";

type ResolvedName = ReturnType<typeof resolveImportedName>;

/**
 * module 参照 scan が組み立てる束縛表。後続 pass はこの表で receiver が
 * X-Ray / Powertools import に実際に束縛されているかを判定する
 * （同名の param 等に shadow された参照を誤変換しないための scope 情報）。
 */
export interface ModuleBindings {
  // X-Ray の default / namespace import の束縛名（`AWSXRay` 等）。
  readonly xrayAliases: Set<string>;
  // alias の束縛宣言 node（default import の name node / namespace import）— shadow 判定用。
  readonly xrayAliasDecls: Set<Node>;
  // bound 名 → export 名（`import { getSegment as gs }` は `gs()` で呼ばれる）。
  readonly xrayNamedImports: Map<string, string>;
  // `import { getSegment }` / `resolveSegment` の bound 名 → specifier node（shadow 判定用）。
  readonly xraySegmentImports: Map<string, Node>;
  // 全 named import の bound 名 → specifier node（shadow 判定用）。
  readonly xrayNamedSpecs: Map<string, Node>;
  readonly powertoolsImports: ImportDeclaration[];
  // Powertools import に束縛された Tracer 識別子 → 宣言 node 集合（shadow 判定用）。
  // 同じ bound 名が複数 import declaration に跨り得るため Set で保持する。
  // 機械変換するのは `import { Tracer }`（別名なし）だけ。
  readonly powertoolsBoundTracer: Map<string, Set<Node>>;
  // `import { type Tracer }` / `import type { Tracer }` で束縛された型専用の Tracer。
  // type 参照は SekimoriTracer に写せるが `new` は invalid — manual finding に回す。
  readonly powertoolsTypeTracer: Map<string, Set<Node>>;
  // default / 別名 経由で束縛された Tracer — manual finding に回し、コードは壊さない。
  readonly powertoolsManualTracer: Map<string, Set<Node>>;
  // `import * as pt` — namespace import の宣言 node 集合。
  readonly powertoolsNamespaces: Map<string, Set<Node>>;
}

const addBound = (map: Map<string, Set<Node>>, name: string, decl: Node) => {
  const set = map.get(name);
  if (set === undefined) map.set(name, new Set([decl]));
  else set.add(decl);
};

const isMigratedModule = (mod: string): boolean =>
  XRAY_MODULES.has(mod) || mod.startsWith("aws-xray-sdk-") || mod === POWERTOOLS_TRACER_MODULE;

/**
 * import / export / import-require / dynamic import type を走査して束縛表を組み立てる。
 * X-Ray 系の import declaration はここで除去し、未対応経路（re-export / require /
 * dynamic import type）は manual finding として報告する。
 */
export function scanModuleRefs(sf: SourceFile, r: Report, lineOf: LineOf): ModuleBindings {
  const bindings: ModuleBindings = {
    xrayAliases: new Set(),
    xrayAliasDecls: new Set(),
    xrayNamedImports: new Map(),
    xraySegmentImports: new Map(),
    xrayNamedSpecs: new Map(),
    powertoolsImports: [],
    powertoolsBoundTracer: new Map(),
    powertoolsTypeTracer: new Map(),
    powertoolsManualTracer: new Map(),
    powertoolsNamespaces: new Map(),
  };

  for (const imp of sf.getImportDeclarations()) {
    const mod = imp.getModuleSpecifierValue();
    const line = lineOf(imp);
    if (XRAY_MODULES.has(mod)) {
      const def = imp.getDefaultImport();
      if (def) {
        bindings.xrayAliases.add(def.getText());
        // name Identifier と use 側の symbol declaration（ImportClause / NamespaceImport）を
        // 一致させるため importDeclOf で正規化する（powertools 側と同じ）。
        bindings.xrayAliasDecls.add(importDeclOf(def));
      }
      const ns = imp.getNamespaceImport();
      if (ns) {
        bindings.xrayAliases.add(ns.getText());
        bindings.xrayAliasDecls.add(importDeclOf(ns));
      }
      for (const named of imp.getNamedImports()) {
        // `import { getSegment as gs }` は束縛名 `gs` で参照される — alias 側を記録する。
        const bound = named.getAliasNode()?.getText() ?? named.getName();
        bindings.xrayNamedImports.set(bound, named.getName());
        bindings.xrayNamedSpecs.set(bound, named);
        if (named.getName() === "getSegment" || named.getName() === "resolveSegment") {
          bindings.xraySegmentImports.set(bound, named);
        }
      }
      imp.remove();
      report(
        r,
        line,
        "auto",
        `import ${mod}`,
        "removed — OTel API / contrib instrumentation takes over",
      );
    } else if (mod === POWERTOOLS_TRACER_MODULE) {
      bindings.powertoolsImports.push(imp);
      for (const n of imp.getNamedImports()) {
        if (n.getName() !== "Tracer") continue;
        const alias = n.getAliasNode();
        const bound = alias === undefined ? "Tracer" : alias.getText();
        if (n.isTypeOnly() || imp.isTypeOnly()) addBound(bindings.powertoolsTypeTracer, bound, n);
        else if (alias === undefined) addBound(bindings.powertoolsBoundTracer, "Tracer", n);
        else addBound(bindings.powertoolsManualTracer, bound, n);
      }
      const def = imp.getDefaultImport();
      // default / namespace import の name Identifier は symbol declaration（ImportClause /
      // NamespaceImport）と一致しない — importDeclOf で正規化してから保持する。
      if (def !== undefined)
        addBound(bindings.powertoolsManualTracer, def.getText(), importDeclOf(def));
      const ns = imp.getNamespaceImport();
      if (ns !== undefined) addBound(bindings.powertoolsNamespaces, ns.getText(), importDeclOf(ns));
    } else if (mod.startsWith("aws-xray-sdk-")) {
      imp.remove();
      report(
        r,
        line,
        "manual",
        `import ${mod}`,
        "X-Ray SDK capture module — removed; rely on contrib instrumentation",
      );
    }
  }

  // `export { Tracer } from "@aws-lambda-powertools/tracer"` / `export * from "aws-xray-sdk-*"` の
  // 再 export は束縛を作らないため機械変換しないが、依存が残るので manual にする。
  for (const exp of sf.getExportDeclarations()) {
    const mod = exp.getModuleSpecifierValue();
    if (mod !== undefined && isMigratedModule(mod)) {
      report(
        r,
        lineOf(exp),
        "manual",
        `export ... from "${mod}"`,
        "re-export is not rewritten — migrate by hand",
      );
    }
  }

  // `import X = require("aws-xray-sdk*")` / Powertools の import-require は未対応として報告する。
  for (const ied of sf.getDescendantsOfKind(SyntaxKind.ImportEqualsDeclaration)) {
    const ref = ied.getModuleReference();
    if (ref.getKind() !== SyntaxKind.ExternalModuleReference) continue;
    const expr = ref.getFirstChildByKind(SyntaxKind.StringLiteral);
    if (expr === undefined) continue;
    const mod = expr.getLiteralValue();
    if (isMigratedModule(mod)) {
      report(
        r,
        lineOf(ied),
        "manual",
        `import ${ied.getName()} = require("${mod}")`,
        "import-require — convert to an ESM import first, then re-run the codemod",
      );
    }
  }

  // `type T = import("aws-xray-sdk-core").Segment` のような dynamic import 型参照は
  // ImportDeclaration でないため import pass を素通りする — silent に残るより
  // manual finding で報告する。
  for (const it of sf.getDescendantsOfKind(SyntaxKind.ImportType)) {
    const lit = it.getArgument().getFirstChildByKind(SyntaxKind.StringLiteral);
    if (lit === undefined) continue;
    const mod = lit.getLiteralValue();
    if (isMigratedModule(mod)) {
      report(
        r,
        lineOf(it),
        "manual",
        `import("${mod}")`,
        "dynamic import type reference — convert to a regular type import, then re-run the codemod",
      );
    }
  }

  return bindings;
}

/**
 * 残った `AWSXRay.*` / named import 参照（値・型としての引き回し等）は全て手作業案件。
 * `alias.method(...)` の callee や named import の call は call 側で報告済みなので二重計上しない。
 */
export function reportLeftoverXrayRefs(
  sf: SourceFile,
  bindings: ModuleBindings,
  r: Report,
  lineOf: LineOf,
): void {
  for (const ident of sf.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (ident.wasForgotten()) continue;
    const text = ident.getText();
    const isAlias = bindings.xrayAliases.has(text);
    const namedSpec = bindings.xrayNamedSpecs.get(text);
    if (!isAlias && namedSpec === undefined) continue;
    // 同名の別 binding（param 等）に shadow された参照は X-Ray のものではない。
    // import は除去済みで decl node は forgotten だが identity 比較には使える。
    const decls = isAlias
      ? bindings.xrayAliasDecls
      : new Set<Node>(namedSpec === undefined ? [] : [namedSpec]);
    if (!boundToAny(ident, decls)) continue;
    const parent = ident.getParent();
    const grandParent = parent?.getParent();
    // `obj.AWSXRay` のような member 名位置 — Powertools pass と同じく除外する。
    // unresolvable receiver 上の member 名は X-Ray の binding 参照ではない。
    if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === ident) continue;
    // `alias.method(...)` の alias — call が処理済み（callee がこの property access の
    // 場合だけ）。named import の `name.method()` は call ループが処理しないため
    // （bare `name()` だけが対象）ここで skip せず leftover finding に落とす。
    if (
      isAlias &&
      Node.isPropertyAccessExpression(parent) &&
      parent.getExpression() === ident &&
      Node.isCallExpression(grandParent) &&
      grandParent.getExpression() === parent
    ) {
      continue;
    }
    // `captureFunc(...)` の direct callee — call 側で報告済み。
    if (Node.isCallExpression(parent) && parent.getExpression() === ident) continue;
    report(r, lineOf(ident), "manual", text, "leftover X-Ray SDK reference — resolve by hand");
  }
}

/**
 * Powertools import を sekimori/tracer に付け替える。import declaration が複数あっても
 * shim import は 1 つだけ。実際に使った spec（createTracer / SekimoriTracer）だけを載せる。
 */
export function rewritePowertoolsImports(
  sf: SourceFile,
  bindings: ModuleBindings,
  shims: { readonly createTracer: ResolvedName; readonly sekimoriTracer: ResolvedName },
  used: { readonly tracerConstructed: boolean; readonly tracerTypeUsed: boolean },
  r: Report,
  lineOf: LineOf,
): void {
  let shimAdded = false;
  for (const imp of bindings.powertoolsImports) {
    const tracerSpecs = imp.getNamedImports().filter((n) => n.getName() === "Tracer");
    if (tracerSpecs.length === 0) {
      // `import D from ...` / `import * as pt` / Tracer を含まない import — 束縛を作る
      // `new` は個別に manual 済みだが、import 自体は残り Powertools 依存が続くことを示す。
      report(
        r,
        lineOf(imp),
        "manual",
        POWERTOOLS_TRACER_MODULE,
        "Powertools import has no plain `Tracer` specifier — migrate by hand",
      );
      continue;
    }
    const line = lineOf(imp);
    let removed = false;
    for (const spec of tracerSpecs) {
      if (spec.getAliasNode() !== undefined) {
        report(
          r,
          line,
          "manual",
          "import { Tracer as ... }",
          "aliased Tracer import — rename by hand",
        );
        continue;
      }
      spec.remove();
      removed = true;
    }
    if (!removed) continue;
    if (
      imp.getNamedImports().length === 0 &&
      !imp.getDefaultImport() &&
      !imp.getNamespaceImport()
    ) {
      imp.remove();
    } else {
      // `Tracer` 以外の spec（captureLambdaHandler 等）が残る — Powertools 依存は
      // 続くので、shim import だけ見て移行完了と誤認しないよう明示する。
      const defaultImport = imp.getDefaultImport();
      const namespaceImport = imp.getNamespaceImport();
      const rest = [
        ...imp.getNamedImports().map((n) => n.getText()),
        ...(defaultImport !== undefined ? [defaultImport.getText()] : []),
        ...(namespaceImport !== undefined ? [`* as ${namespaceImport.getText()}`] : []),
      ];
      report(
        r,
        line,
        "manual",
        POWERTOOLS_TRACER_MODULE,
        `remaining specifiers still import from Powertools: ${rest.join(", ")} — migrate by hand`,
      );
    }
    if (!shimAdded) {
      type ShimSpec = string | { name: string; alias?: string; isTypeOnly?: boolean };
      const specs: ShimSpec[] = [
        ...(used.tracerConstructed && !shims.createTracer.bound
          ? [
              shims.createTracer.name === "createTracer"
                ? "createTracer"
                : { name: "createTracer", alias: shims.createTracer.name },
            ]
          : []),
        ...(used.tracerTypeUsed && !shims.sekimoriTracer.bound
          ? [
              shims.sekimoriTracer.name === "SekimoriTracer"
                ? { name: "SekimoriTracer", isTypeOnly: true }
                : {
                    name: "SekimoriTracer",
                    alias: shims.sekimoriTracer.name,
                    isTypeOnly: true,
                  },
            ]
          : []),
      ];
      if (specs.length > 0) {
        insertImport(sf, SHIM_MODULE, specs);
        shimAdded = true;
      }
    }
    report(r, line, "auto", POWERTOOLS_TRACER_MODULE, "import moved to sekimori/tracer");
  }
}

/**
 * Powertools の `Tracer` binding に束縛されたまま残った参照 — `class X extends Tracer` /
 * `x instanceof Tracer` / `fn(Tracer)` 等。`new` と型注釈は処理済みだが、それ以外の使い方は
 * import spec の削除で unbound になるので manual に挙げる。
 */
export function reportLeftoverTracerRefs(
  sf: SourceFile,
  bindings: ModuleBindings,
  r: Report,
  lineOf: LineOf,
): void {
  const tracerNames = new Set([
    ...bindings.powertoolsBoundTracer.keys(),
    ...bindings.powertoolsTypeTracer.keys(),
    ...bindings.powertoolsManualTracer.keys(),
  ]);
  if (tracerNames.size === 0) return;
  for (const ident of sf.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (ident.wasForgotten()) continue;
    const specDecls =
      bindings.powertoolsBoundTracer.get(ident.getText()) ??
      bindings.powertoolsTypeTracer.get(ident.getText()) ??
      bindings.powertoolsManualTracer.get(ident.getText());
    if (specDecls === undefined) continue;
    // shadow された同名 binding（param 等）は Powertools の Tracer ではない。
    if (!boundToAny(ident, specDecls)) continue;
    const parent = ident.getParent();
    // import specifier / `new Tracer`（manual 済み）/ PA の member 名は除く。
    if (ident.getFirstAncestorByKind(SyntaxKind.ImportDeclaration) !== undefined) continue;
    if (Node.isNewExpression(parent) && parent.getExpression() === ident) continue;
    if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === ident) continue;
    report(
      r,
      lineOf(ident),
      "manual",
      ident.getText(),
      "leftover Powertools Tracer reference — resolve by hand",
    );
  }
}

/**
 * `require("aws-xray-sdk*")` / `await import("@aws-lambda-powertools/tracer")` の
 * CJS / 動的 import 経路は未対応として報告する。依存削除後に実行時エラーになるため
 * silent に残さない。
 */
export function reportModuleSpecifierCalls(sf: SourceFile, r: Report, lineOf: LineOf): void {
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    const isRequire = Node.isIdentifier(expr) && expr.getText() === "require";
    const isDynamicImport = expr.getKind() === SyntaxKind.ImportKeyword;
    // `jest.mock("aws-xray-sdk-core")` / `vi.mock(...)` / `require.resolve("...")` のような
    // import 文・bare require 以外の module-specifier 経路も拾う — dep 削除後に runtime で落ちる。
    const pa = Node.isPropertyAccessExpression(expr) ? expr : undefined;
    const testHook =
      pa !== undefined &&
      (pa.getExpression().getText() === "jest" || pa.getExpression().getText() === "vi") &&
      TEST_HOOK_METHODS.has(pa.getName());
    const isRequireResolve =
      pa !== undefined && pa.getExpression().getText() === "require" && pa.getName() === "resolve";
    if (!isRequire && !isDynamicImport && !testHook && !isRequireResolve) continue;
    const arg = call.getArguments()[0];
    // `require(\`aws-xray-sdk-core\`)` のような補間なし template literal も拾う。
    const isLit =
      arg !== undefined && (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg));
    if (!isLit) continue;
    const mod = arg.getLiteralValue();
    if (mod.startsWith("aws-xray-sdk") || mod === POWERTOOLS_TRACER_MODULE) {
      const label = isDynamicImport ? "import" : isRequire ? "require" : expr.getText();
      report(
        r,
        lineOf(call),
        "manual",
        `${label}("${mod}")`,
        isDynamicImport
          ? "dynamic import — convert to a static import first"
          : isRequire
            ? "CJS require — convert to an import first"
            : "module reference outside import/require — update by hand",
      );
    }
  }
}
