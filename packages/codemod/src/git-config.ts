/** git config（INI）と `.git` file の読解 — gitignore rule 収集から分離した純粋な解析層。 */
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * git config テキストから `[core] excludesFile` の値を取り出す（INI の最小 parse）。
 * quoted 値は空白を含み得る（`excludesFile = "/a b/gitignore"`）— quote の内側を
 * 全部取る。unquoted は非空白まで。`~` 始まりは home に展開して絶対パスで返す。
 */
export function parseCoreExcludesFile(text: string, home: string): string | undefined {
  let inCore = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    const section = /^\[([^\]]+)\]/.exec(trimmed);
    if (section !== null) {
      inCore = section[1]?.trim() === "core";
      continue;
    }
    if (!inCore) continue;
    // 先に `=` だけ切ってから値を切り出す（値側に `=` が含まれ得るため split は使わない）。
    const kv = /^excludesfile\s*=\s*(.+?)\s*$/i.exec(trimmed);
    const raw = kv?.[1];
    if (raw === undefined) continue;
    const quoted = /^"(.*)"$/.exec(raw);
    const value = quoted?.[1] ?? /^[^\s"]+/.exec(raw)?.[0];
    if (value !== undefined && value !== "") {
      return resolve(value.replace(/^~(?=$|\/)/, home));
    }
  }
  return undefined;
}

/**
 * `repoDir/.git` の実 gitdir を返す。`.git` が dir ならそのまま、file なら
 * worktree/submodule の `gitdir:` 先を読み、`commondir` があれば共有 gitdir へ辿る。
 * `.git` が無い / 読めない場合は undefined。
 */
export async function resolveGitDir(repoDir: string): Promise<string | undefined> {
  const dotGit = join(repoDir, ".git");
  try {
    if (!(await stat(dotGit)).isFile()) return dotGit;
    const text = await readFile(dotGit, "utf8");
    const m = /^gitdir:\s*(.+)$/m.exec(text);
    if (m?.[1] === undefined) return undefined;
    const gitDir = resolve(repoDir, m[1].trim());
    try {
      const common = (await readFile(join(gitDir, "commondir"), "utf8")).trim();
      return resolve(gitDir, common);
    } catch {
      // commondir が無ければその gitdir 直下が実 gitdir。
      return gitDir;
    }
  } catch {
    // .git の stat/read に失敗したら repo-level の gitdir は解決不能。
    return undefined;
  }
}
