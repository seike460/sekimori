import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pruneEvidence } from "./evidence.js";

const mkDir = (): URL => pathToFileURL(`${mkdtempSync(join(tmpdir(), "sekimori-ev-"))}/`);

const evName = (stamp: string) => `${stamp}-abcdef12.json`;

const writeEvidence = (dir: URL, stamp: string) => writeFileSync(new URL(evName(stamp), dir), "{}");

const namesIn = (dir: URL): string[] => readdirSync(dir).sort();

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pruneEvidence", () => {
  it("keeps the newest `keep` evidence files and removes the rest", () => {
    const dir = mkDir();
    for (const stamp of [
      "2025-01-01-00-00-00",
      "2025-01-02-00-00-00",
      "2025-01-03-00-00-00",
      "2025-01-04-00-00-00",
    ]) {
      writeEvidence(dir, stamp);
    }
    pruneEvidence(dir, 2);
    expect(namesIn(dir)).toEqual([evName("2025-01-03-00-00-00"), evName("2025-01-04-00-00-00")]);
  });

  it("leaves non-evidence files (README etc.) untouched", () => {
    const dir = mkDir();
    writeFileSync(new URL("README.md", dir), "keep me");
    writeFileSync(new URL("notes.json", dir), "{}");
    for (const stamp of ["2025-01-01-00-00-00", "2025-01-02-00-00-00", "2025-01-03-00-00-00"]) {
      writeEvidence(dir, stamp);
    }
    pruneEvidence(dir, 1);
    expect(namesIn(dir)).toEqual([evName("2025-01-03-00-00-00"), "README.md", "notes.json"]);
  });

  it("warns and keeps deleting the rest when one unlink fails", () => {
    const dir = mkDir();
    // 証跡名と同名の directory — unlinkSync が EPERM/EISDIR で失敗する。
    mkdirSync(new URL(evName("2025-01-02-00-00-00"), dir));
    writeEvidence(dir, "2025-01-01-00-00-00");
    writeEvidence(dir, "2025-01-03-00-00-00");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    pruneEvidence(dir, 0);
    // 失敗した directory と（per-file catch で残った）他の stale ファイルの扱い:
    // 削除は継続するので 2025-01-01/03 のファイルは消える。
    expect(warn).toHaveBeenCalled();
    expect(namesIn(dir)).toEqual([evName("2025-01-02-00-00-00")]);
  });

  it("warns once and returns when the dir cannot be listed", () => {
    const missing = new URL("file:///nonexistent-sekimori-dir/");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => pruneEvidence(missing, 5)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
