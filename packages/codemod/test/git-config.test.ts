import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCoreExcludesFile, resolveGitDir } from "../src/git-config.js";
import { tmpTestDir } from "./file-seams.js";

const HOME = "/home/test";

describe("parseCoreExcludesFile", () => {
  it("reads excludesFile inside the [core] section", () => {
    expect(parseCoreExcludesFile("[core]\n\texcludesFile = /a/b/gitignore\n", HOME)).toBe(
      resolve("/a/b/gitignore"),
    );
  });

  it("keeps spaces inside quoted values", () => {
    expect(parseCoreExcludesFile('[core]\nexcludesFile = "/a b/gitignore"\n', HOME)).toBe(
      resolve("/a b/gitignore"),
    );
  });

  it("stops unquoted values at whitespace", () => {
    expect(parseCoreExcludesFile("[core]\nexcludesFile = /a/b extra\n", HOME)).toBe(
      resolve("/a/b"),
    );
  });

  it("expands a leading ~ to the home dir", () => {
    expect(parseCoreExcludesFile("[core]\nexcludesFile = ~/g\n", HOME)).toBe(resolve(`${HOME}/g`));
  });

  it("ignores excludesFile outside the [core] section", () => {
    expect(parseCoreExcludesFile("[other]\nexcludesFile = /x\n", HOME)).toBeUndefined();
  });

  it("matches the key case-insensitively", () => {
    expect(parseCoreExcludesFile("[core]\nExcludesFile = /x\n", HOME)).toBe(resolve("/x"));
  });

  it("returns undefined when the key is absent", () => {
    expect(parseCoreExcludesFile("[core]\neditor = vim\n", HOME)).toBeUndefined();
  });
});

describe("resolveGitDir", () => {
  it("returns .git itself when it is a directory", async () => {
    const repo = tmpTestDir();
    mkdirSync(join(repo, ".git"));
    expect(await resolveGitDir(repo)).toBe(join(repo, ".git"));
  });

  it("follows a gitdir: pointer file", async () => {
    const repo = tmpTestDir();
    const gitdir = join(tmpTestDir(), "real-git");
    writeFileSync(join(repo, ".git"), `gitdir: ${gitdir}\n`);
    expect(await resolveGitDir(repo)).toBe(gitdir);
  });

  it("follows commondir from the worktree gitdir to the shared gitdir", async () => {
    const repo = tmpTestDir();
    const common = join(tmpTestDir(), "common");
    const gitdir = join(common, "worktrees", "wt");
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(join(gitdir, "commondir"), "../..");
    writeFileSync(join(repo, ".git"), `gitdir: ${gitdir}\n`);
    expect(await resolveGitDir(repo)).toBe(common);
  });

  it("returns undefined when .git does not exist", async () => {
    expect(await resolveGitDir(tmpTestDir())).toBeUndefined();
  });
});
