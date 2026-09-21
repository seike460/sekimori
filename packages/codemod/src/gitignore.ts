/** `.gitignore` の収集と評価 — nested rule、`.git/info/exclude`、global excludes を畳み込む。 */
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import ignore, { type Ignore } from "ignore";
import { parseCoreExcludesFile, resolveGitDir } from "./git-config.js";

export async function loadGitignore(dir: string): Promise<Ignore | undefined> {
  try {
    return ignore().add(await readFile(join(dir, ".gitignore"), "utf8"));
  } catch {
    // .gitignore の無い dir は普通 — rule なしとして扱う。
    return undefined;
  }
}

/** gitignore 1 枚とその基点 dir。git と同じく、pattern は .gitignore のある dir からの相対で効く。 */
export interface IgnoreRule {
  readonly ig: Ignore;
  readonly base: string;
}

/** `ignore` package は POSIX 区切りを要求する — Windows の `\` を `/` に直す。 */
function normalizeRel(rel: string): string {
  return rel.replaceAll("\\", "/");
}

export function isIgnored(rules: IgnoreRule[], path: string, isDir: boolean): boolean {
  // git と同じ評価順: 深い .gitignore から見て、最初に match した rule が効く
  // （子の `!` negation が親の ignore を re-include できる）。
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i];
    if (rule === undefined) continue;
    const { ig, base } = rule;
    const rel = normalizeRel(relative(base, path));
    // base 外は rule を適用しない。`..foo.ts` のようなファイル名を誤認しないよう
    // ".." 単体か "../" 始まりだけを除外する。
    if (rel === "" || rel === ".." || rel.startsWith("../")) continue;
    const result = ig.test(isDir ? `${rel}/` : rel);
    if (result.unignored) return false;
    if (result.ignored) return true;
  }
  return false;
}

/**
 * `.git/info/exclude` と `core.excludesFile`（global gitignore）の rule を返す。
 * git check-ignore の precedence（.gitignore > info/exclude > excludesFile）に合わせ、
 * 浅い側（低優先）の順で返す — 呼び出し側は rules 配列の先頭に置く。
 * `.git` が file の場合は worktree/submodule — `gitdir:` 先と `commondir` を辿る。
 * どれも読めなければ空配列（best-effort — rule が無いだけ）。
 */
async function repoLevelRules(repoDir: string): Promise<IgnoreRule[]> {
  const rules: IgnoreRule[] = [];
  // core.excludesFile — git を spawn せず設定ファイルを直接読む（INI の最小 parse）。
  const home = homedir();
  const configPaths = [
    join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "git", "config"),
    join(home, ".gitconfig"),
  ];
  for (const cfgPath of configPaths) {
    let text: string;
    try {
      text = await readFile(cfgPath, "utf8");
    } catch {
      // 読めない git config はその経路の rule なしとして次を試す。
      continue;
    }
    const excludesFile = parseCoreExcludesFile(text, home);
    if (excludesFile !== undefined) {
      try {
        rules.push({
          ig: ignore().add(await readFile(excludesFile, "utf8")),
          base: repoDir,
        });
      } catch {
        // 読めない excludesFile は rule なしと同じ
      }
      break;
    }
  }
  // .git/info/exclude — worktree/submodule は gitdir file を経由し、共有 gitdir
  // （commondir）側の info/exclude を読む。
  const gitDir = await resolveGitDir(repoDir);
  if (gitDir === undefined) return rules;
  try {
    rules.push({
      ig: ignore().add(await readFile(join(gitDir, "info/exclude"), "utf8")),
      base: repoDir,
    });
  } catch {
    // info/exclude が無い repo は普通
  }
  return rules;
}

/**
 * `dir` から上位へ `.git`（repo root）まで辿り、各階層の `.gitignore` を積む。
 * `sekimori migrate src/` のように repo の一部だけを指定しても、root の rule が効くようにする。
 * repo 内なら `.git/info/exclude` と `core.excludesFile` も最も浅い rule として積む。
 * 戻り値は浅い → 深い の順。
 */
export async function ancestorRules(dir: string): Promise<IgnoreRule[]> {
  const rules: IgnoreRule[] = [];
  let cur = resolve(dir);
  let repoDir: string | undefined;
  for (;;) {
    const ig = await loadGitignore(cur);
    if (ig !== undefined) rules.push({ ig, base: cur });
    // repo root（.git のある dir。worktree/submodule では file になり得る）で止まる。
    try {
      await stat(join(cur, ".git"));
      repoDir = cur;
      break;
    } catch {
      // .git が無ければ一段上へ
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  // git の .gitignore は repo 内でしか効かない — .git が見つからず fs root まで
  // 登り切った場合（repo 外の単独 dir）は祖先の rule を適用しない。
  if (repoDir === undefined) return [];
  const resolved = rules.reverse();
  resolved.unshift(...(await repoLevelRules(repoDir)));
  return resolved;
}
