/** codemod orchestration — file walk（gitignore 尊重）→ transformSource → write/report。 */
import type { Dirent, Stats } from "node:fs";
import { readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { ancestorRules, type IgnoreRule, isIgnored, loadGitignore } from "./gitignore.js";
import {
  type MigrationFinding,
  type TransformOptions,
  type TransformResult,
  transformSource,
} from "./transform.js";

export type { MigrationFinding, TransformOptions, TransformResult };
export { transformSource };

export interface FileResult {
  readonly path: string;
  readonly changed: boolean;
  readonly findings: MigrationFinding[];
}

export interface MigrationResult {
  readonly files: FileResult[];
  readonly findings: (MigrationFinding & { readonly file: string })[];
  /** 走査した file 数（files は差分のあるものだけを持つため別に数える）。 */
  readonly scanned: number;
}

export interface MigrateOptions extends TransformOptions {
  /** true なら変換後のソースでファイルを上書きする。既定は dry-run。 */
  readonly write?: boolean;
}

/** 固定で skip する dir + ビルド出力によくある名前。加えて各 path root の .gitignore を読む。 */
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "cdk.out",
  ".git",
  "coverage",
  ".serverless",
  ".next",
  "out",
  "build",
  "vendor",
]);

async function collectFiles(
  path: string,
  rules: IgnoreRule[],
  explicit = false,
  onProblem?: (path: string, message: string) => void,
): Promise<string[]> {
  let info: Stats;
  try {
    info = await stat(path);
  } catch (err) {
    // 1 path の stat 失敗（ENOENT/EACCES）で run 全体を止めない — 報告して skip。
    onProblem?.(path, err instanceof Error ? err.message : String(err));
    return [];
  }
  if (info.isFile()) {
    if (!/\.(?:m|c)?tsx?$/.test(path) || /\.d\.(?:m|c)?ts$/.test(path)) return [];
    // 明示指定した file は .gitignore を適用しない — codemod は git ではないので
    // 「引数で渡したのに 0 file」と黙って終わる方が混乱を招く。
    return !explicit && isIgnored(rules, path, false) ? [] : [path];
  }
  if (!info.isDirectory()) return [];
  // ネストした .gitignore を降りながら積む（git の仕様どおり、深い dir の rule が加わる）。
  const local = await loadGitignore(path);
  const next = local !== undefined ? [...rules, { ig: local, base: path }] : rules;
  const out: string[] = [];
  let entries: Dirent[];
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (err) {
    // dir が読めない（EACCES 等）— その dir だけ skip して残りを処理する。
    onProblem?.(path, err instanceof Error ? err.message : String(err));
    return [];
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    // symlink は辿らない — dangling link の readFile で run 全体が死なないようにする。
    // （symlinked dir も traverse しない — tree 外への書き込みを避けるため）
    if (entry.isSymbolicLink()) continue;
    const full = join(path, entry.name);
    if (isIgnored(next, full, entry.isDirectory())) continue;
    if (entry.isDirectory()) out.push(...(await collectFiles(full, next, false, onProblem)));
    else if (/\.(?:m|c)?tsx?$/.test(entry.name) && !/\.d\.(?:m|c)?ts$/.test(entry.name))
      out.push(full);
  }
  return out;
}

/** 1 ファイルを変換する。`write: true` で上書き、既定は dry-run。 */
export async function migrateFile(path: string, options: MigrateOptions = {}): Promise<FileResult> {
  const source = await readFile(path, "utf8");
  const result = transformSource(source, path, options);
  if (result.changed && options.write) {
    // 同一 dir に tmp へ書いて rename — write 途中の kill/ENOSPC で元ファイルが
    // 破損するのを防ぐ（rename は同 FS 内で atomic）。tmp は元ファイルの mode を
    // 引き継ぎ、encoding は明示的に UTF-8 にする。
    const tmp = `${path}.sekimori-tmp`;
    const mode = (await stat(path)).mode;
    await writeFile(tmp, result.code, { encoding: "utf8", mode });
    try {
      await rename(tmp, path);
    } catch (error) {
      // rename 失敗時は tmp を残さない（掃除の失敗は元の error を隠さない）。
      await rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
  }
  return { path, changed: result.changed, findings: result.findings };
}

/** ファイル / ディレクトリの列を再帰的に変換し、file 名付きの findings を集約する。 */
export async function migratePaths(
  paths: string[],
  options: MigrateOptions = {},
): Promise<MigrationResult> {
  const files: FileResult[] = [];
  const findings: MigrationResult["findings"] = [];
  const reportProblem = (path: string, message: string) => {
    findings.push({
      kind: "manual",
      construct: "migrate paths",
      line: 0,
      message: `cannot read: ${message}`,
      file: relative(process.cwd(), path),
    });
  };
  const targets = (
    await Promise.all(
      paths.map(async (path) => {
        // 明示的に渡された入力 path 自体の stat 失敗（ENOENT 等）は利用者の指定ミス —
        // throw して呼び出し側（CLI は exit 2 に正規化する）に委ねる。
        // scan 中の下位 dir の読み取り失敗だけ reportProblem で report+continue する。
        const info = await stat(path);
        // 入力 path の祖先の .gitignore（repo root まで）を読んでから降りる。
        const rules = await ancestorRules(info.isDirectory() ? path : dirname(path));
        let hadProblem = false;
        const found = await collectFiles(path, rules, true, (p, m) => {
          hadProblem = true;
          reportProblem(p, m);
        });
        // 明示した path が 1 file も拾えない（全部 ignore / .ts 無し）のを黙らない。
        // 読み取り失敗は reportProblem が既に報告しているので重複させない。
        if (found.length === 0 && !hadProblem) {
          findings.push({
            kind: "manual",
            construct: "migrate paths",
            line: 0,
            message: `no source files found under "${relative(process.cwd(), path)}" — path is empty, gitignored, or has no .ts/.tsx/.mts/.cts files`,
            file: relative(process.cwd(), path),
          });
        }
        return found;
      }),
    )
  ).flat();
  // `migrate src src/foo.ts` のような重複指定で同じ file を二度 transform しない。
  // resolve で正規化して同一実体を潰す（順序は先勝ち）。
  const seen = new Set<string>();
  const uniqueTargets = targets.filter((p) => {
    const key = resolve(p);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  for (const path of uniqueTargets) {
    let result: FileResult;
    try {
      result = await migrateFile(path, options);
    } catch (err) {
      // 1 ファイルの transform 失敗で migration 全体を止めない — manual finding として
      // 報告して残りのファイルを処理する。ファイルは無変更のまま残る。
      const msg = err instanceof Error ? err.message : String(err);
      result = {
        path,
        changed: false,
        findings: [
          {
            kind: "manual",
            construct: "transform",
            line: 0,
            message: `transform failed: ${msg} — file left untouched`,
          },
        ],
      };
    }
    if (result.findings.length === 0 && !result.changed) continue;
    files.push(result);
    for (const f of result.findings) findings.push({ ...f, file: relative(process.cwd(), path) });
  }
  return { files, findings, scanned: uniqueTargets.length };
}

/** CLI が出す人間向けの report 文面。 */
export function formatReport(result: MigrationResult): string {
  const lines: string[] = [];
  const changed = result.files.filter((f) => f.changed);
  // files は差分・finding のあるものだけなので scanned は別フィールドを使う。
  lines.push(`sekimori migrate: ${result.scanned} file(s) scanned, ${changed.length} rewritten`);
  for (const f of result.files) {
    if (!f.changed && f.findings.length === 0) continue;
    lines.push(`\n${relative(process.cwd(), f.path)}${f.changed ? "  [rewritten]" : ""}`);
    for (const finding of f.findings) {
      const mark = finding.kind === "auto" ? "auto  " : "manual";
      lines.push(`  ${mark} L${finding.line} ${finding.construct} — ${finding.message}`);
    }
  }
  const manual = result.findings.filter((f) => f.kind === "manual");
  if (manual.length > 0) {
    lines.push(`\n${manual.length} construct(s) need manual work.`);
  }
  return `${lines.join("\n")}\n`;
}
