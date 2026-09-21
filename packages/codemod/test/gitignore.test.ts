import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ancestorRules, isIgnored, loadGitignore } from "../src/gitignore.js";
import { tmpTestDir } from "./file-seams.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

/** XDG_CONFIG_HOME を stub して core.excludesFile の探索を tmp dir に固定する。 */
function stubXdgExcludes(excludesPath: string | undefined): void {
  const xdg = tmpTestDir();
  if (excludesPath !== undefined) {
    mkdirSync(join(xdg, "git"), { recursive: true });
    writeFileSync(join(xdg, "git", "config"), `[core]\n\texcludesFile = ${excludesPath}\n`);
  }
  vi.stubEnv("XDG_CONFIG_HOME", xdg);
}

describe("loadGitignore", () => {
  it("returns undefined for a dir without .gitignore", async () => {
    expect(await loadGitignore(tmpTestDir())).toBeUndefined();
  });

  it("loads a .gitignore when present", async () => {
    const dir = tmpTestDir();
    writeFileSync(join(dir, ".gitignore"), "ignored.ts\n");
    const ig = await loadGitignore(dir);
    expect(ig?.test("ignored.ts").ignored).toBe(true);
  });
});

describe("isIgnored", () => {
  it("evaluates deepest rule first so child `!` re-includes a parent ignore", async () => {
    const root = tmpTestDir();
    const sub = join(root, "sub");
    mkdirSync(sub);
    writeFileSync(join(root, ".gitignore"), "*.log\n");
    writeFileSync(join(sub, ".gitignore"), "!keep.log\n");
    const rules = [
      { ig: (await loadGitignore(root))!, base: root },
      { ig: (await loadGitignore(sub))!, base: sub },
    ];
    expect(isIgnored(rules, join(sub, "keep.log"), false)).toBe(false);
    expect(isIgnored(rules, join(sub, "drop.log"), false)).toBe(true);
  });

  it("does not treat `..foo.ts` as outside the rule base", async () => {
    const root = tmpTestDir();
    writeFileSync(join(root, ".gitignore"), "..foo.ts\n");
    const rules = [{ ig: (await loadGitignore(root))!, base: root }];
    expect(isIgnored(rules, join(root, "..foo.ts"), false)).toBe(true);
  });

  it("skips rules whose base does not contain the path", async () => {
    const root = tmpTestDir();
    const other = tmpTestDir();
    writeFileSync(join(other, ".gitignore"), "*\n");
    const rules = [{ ig: (await loadGitignore(other))!, base: other }];
    expect(isIgnored(rules, join(root, "a.ts"), false)).toBe(false);
  });
});

describe("ancestorRules", () => {
  it("returns [] when no .git exists up to the fs root boundary", async () => {
    // tmpdir は repo 外 — .git が見つからないので祖先 rule は適用されない。
    const dir = tmpTestDir();
    writeFileSync(join(dir, ".gitignore"), "*.ts\n");
    expect(await ancestorRules(dir)).toEqual([]);
  });

  it("collects .gitignore files from dir up to the repo root", async () => {
    // 実機の ~/.gitconfig が excludesFile を持つと repo-level rule が混入するため、
    // 存在しない excludesFile を指す XDG config で global rule を固定する。
    stubXdgExcludes(join(tmpTestDir(), "nonexistent-excludes"));
    const repo = tmpTestDir();
    mkdirSync(join(repo, ".git"));
    writeFileSync(join(repo, ".gitignore"), "root-ignore\n");
    const sub = join(repo, "a", "b");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(repo, "a", ".gitignore"), "a-ignore\n");
    const rules = await ancestorRules(sub);
    // 浅い（repo root）→ 深い の順。`.gitignore` の無い階層は rule にならない。
    expect(rules.map((r) => r.base)).toEqual([repo, join(repo, "a")]);
  });

  it("reads .git/info/exclude as the shallowest repo-level rule", async () => {
    const repo = tmpTestDir();
    stubXdgExcludes(undefined);
    mkdirSync(join(repo, ".git", "info"), { recursive: true });
    writeFileSync(join(repo, ".git", "info", "exclude"), "excluded-by-info\n");
    const rules = await ancestorRules(repo);
    expect(rules.some((r) => r.ig.test("excluded-by-info").ignored)).toBe(true);
  });

  it("follows a .git file (worktree) to gitdir then commondir for info/exclude", async () => {
    const repo = tmpTestDir();
    const common = join(tmpTestDir(), "common-git");
    const gitdir = join(common, "worktrees", "wt");
    mkdirSync(join(gitdir, "..", "..", "info"), { recursive: true });
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(join(gitdir, "commondir"), "../..");
    writeFileSync(join(common, "info", "exclude"), "worktree-excluded\n");
    writeFileSync(join(repo, ".git"), `gitdir: ${gitdir}\n`);
    const rules = await ancestorRules(repo);
    expect(rules.some((r) => r.ig.test("worktree-excluded").ignored)).toBe(true);
  });

  it("applies core.excludesFile from the stubbed XDG git config", async () => {
    const repo = tmpTestDir();
    mkdirSync(join(repo, ".git"));
    const excludes = join(tmpTestDir(), "global-ignore");
    writeFileSync(excludes, "global-ignored\n");
    stubXdgExcludes(excludes);
    const rules = await ancestorRules(repo);
    expect(rules.some((r) => r.ig.test("global-ignored").ignored)).toBe(true);
  });
});
