import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { migratePaths } from "../src/index.js";
import { tmpTestDir, XRAY_SOURCE } from "./file-seams.js";

describe("Round-5 file API fixes", () => {
  it("collects .mts/.cts files (R5-B-11)", async () => {
    const root = tmpTestDir();
    writeFileSync(join(root, "a.mts"), XRAY_SOURCE);
    writeFileSync(join(root, "b.cts"), XRAY_SOURCE);
    writeFileSync(join(root, "c.d.mts"), XRAY_SOURCE); // declaration — skip
    const result = await migratePaths([root]);
    expect(result.files.map((f) => f.path).sort()).toEqual(
      [join(root, "a.mts"), join(root, "b.cts")].sort(),
    );
  });

  it("applies .gitignore rules to names starting with `..` (R5-B-10)", async () => {
    // `relative(base, "..foo.ts")` = "..foo.ts" — ".." 始まりを base 外と誤認すると
    // ignore rule が適用されず残ってしまう。
    const root = tmpTestDir();
    writeFileSync(join(root, ".gitignore"), "..foo.ts\n");
    writeFileSync(join(root, "..foo.ts"), XRAY_SOURCE);
    writeFileSync(join(root, "kept.ts"), XRAY_SOURCE);
    const result = await migratePaths([root]);
    expect(result.files.map((f) => f.path)).toEqual([join(root, "kept.ts")]);
  });
});

describe("Round-6 file API fixes", () => {
  it("warns when an explicit directory yields no source files (R6-B-7)", async () => {
    // 全ファイルが .gitignore で skip されて 0 件 — 黙って終わると ignore と
    // 気づけないので finding にする。
    const root = tmpTestDir();
    writeFileSync(join(root, ".gitignore"), "*\n");
    writeFileSync(join(root, "a.ts"), XRAY_SOURCE);
    const result = await migratePaths([root]);
    expect(result.files).toHaveLength(0);
    expect(
      result.findings.some(
        (f) => f.kind === "manual" && f.message.includes("no source files found"),
      ),
    ).toBe(true);
  });

  it("respects .git/info/exclude (R6-B-8)", async () => {
    // .gitignore に書けない local 専用の除外ルール — git と同じく効く。
    const root = tmpTestDir();
    mkdirSync(join(root, ".git", "info"), { recursive: true });
    writeFileSync(join(root, ".git", "info", "exclude"), "excluded.ts\n");
    writeFileSync(join(root, "excluded.ts"), XRAY_SOURCE);
    writeFileSync(join(root, "kept.ts"), XRAY_SOURCE);
    const result = await migratePaths([root]);
    expect(result.files.map((f) => f.path)).toEqual([join(root, "kept.ts")]);
  });

  it("respects core.excludesFile from git config (R6-B-8)", async () => {
    const xdg = tmpTestDir();
    const excludes = join(xdg, "global-excludes");
    mkdirSync(join(xdg, "git"), { recursive: true });
    writeFileSync(join(xdg, "git", "config"), `[core]\n\texcludesfile = ${excludes}\n`);
    writeFileSync(excludes, "globally-ignored.ts\n");
    vi.stubEnv("XDG_CONFIG_HOME", xdg);
    try {
      const root = tmpTestDir();
      mkdirSync(join(root, ".git"));
      writeFileSync(join(root, "globally-ignored.ts"), XRAY_SOURCE);
      writeFileSync(join(root, "kept.ts"), XRAY_SOURCE);
      const result = await migratePaths([root]);
      expect(result.files.map((f) => f.path)).toEqual([join(root, "kept.ts")]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("Round-10 file API fixes", () => {
  it("respects a quoted core.excludesFile path containing spaces (R10-B)", async () => {
    // `excludesFile = "/a b/gitignore"` のように空白入りの quoted path — quote の
    // 内側を全部取らないと途中で切れて違うパスを解決してしまう。
    const xdg = join(tmpTestDir(), "with space");
    mkdirSync(join(xdg, "git"), { recursive: true });
    const excludes = join(xdg, "global excludes");
    writeFileSync(join(xdg, "git", "config"), `[core]\n\texcludesfile = "${excludes}"\n`);
    writeFileSync(excludes, "globally-ignored.ts\n");
    vi.stubEnv("XDG_CONFIG_HOME", xdg);
    try {
      const root = tmpTestDir();
      mkdirSync(join(root, ".git"));
      writeFileSync(join(root, "globally-ignored.ts"), XRAY_SOURCE);
      writeFileSync(join(root, "kept.ts"), XRAY_SOURCE);
      const result = await migratePaths([root]);
      expect(result.files.map((f) => f.path)).toEqual([join(root, "kept.ts")]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps throwing on a missing explicit input path (CLI exit-2 contract, R10-B)", async () => {
    // 明示した入力 path 自体の ENOENT は利用者の指定ミス — throw して CLI が
    // exit 2 に正規化する契約を維持する（R5-B-6）。
    const missing = join(tmpTestDir(), "does-not-exist");
    await expect(migratePaths([missing])).rejects.toThrow();
  });

  it("does not transform the same file twice when paths overlap (R10-B)", async () => {
    // `migrate src src/a.ts` のような重複指定 — 同じ実体を二度 transform しない。
    const root = tmpTestDir();
    writeFileSync(join(root, "a.ts"), XRAY_SOURCE);
    const result = await migratePaths([root, join(root, "a.ts")]);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.path).toBe(join(root, "a.ts"));
  });
});
