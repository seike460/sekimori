import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { migrateFile, migratePaths } from "../src/index.js";
import { tmpTestDir, XRAY_SOURCE } from "./file-seams.js";

// `boom` を名前に含むファイルだけ transform を失敗させる — 1 ファイルの例外で
// migration 全体が止まらないことを検証するための seam。
vi.mock("../src/transform.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/transform.js")>();
  return {
    ...actual,
    transformSource: (
      src: string,
      fileName?: string,
      opts?: Parameters<typeof actual.transformSource>[2],
    ) => {
      if (fileName?.includes("boom")) throw new Error("kaboom");
      return actual.transformSource(src, fileName, opts);
    },
  };
});

// `locked/` という dir 名だけ readdir/stat を、`renamefail` を含む rename を失敗させる —
// scan 中の fs エラーや tmp orphan 掃除の検証用 seam。
// EACCES / EXDEV は環境依存（root 実行では再現不能）なので mock で再現する。
vi.mock("node:fs/promises", async (importActual) => {
  const actual = await importActual<typeof import("node:fs/promises")>();
  const eacces = () => Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
  // fs/promises は戻り値別の overload — テスト対象が使う呼び出し形だけを正確に型付けする。
  return {
    ...actual,
    stat: (p: Parameters<typeof actual.stat>[0]) =>
      String(p).includes("locked") ? Promise.reject(eacces()) : actual.stat(p),
    readdir: (p: Parameters<typeof actual.readdir>[0], o?: { withFileTypes?: boolean }) =>
      String(p).includes("locked")
        ? Promise.reject(eacces())
        : o?.withFileTypes === true
          ? actual.readdir(p, { withFileTypes: true })
          : actual.readdir(p),
    rename: (a: Parameters<typeof actual.rename>[0], b: Parameters<typeof actual.rename>[1]) =>
      String(b).includes("renamefail") ? Promise.reject(eacces()) : actual.rename(a, b),
  };
});

describe("file error resilience", () => {
  it("continues the migration when one file's transform throws", async () => {
    const root = tmpTestDir();
    writeFileSync(join(root, "boom.ts"), XRAY_SOURCE);
    writeFileSync(join(root, "ok.ts"), XRAY_SOURCE);
    const result = await migratePaths([root]);
    // boom.ts は transform 失敗 → 無変更のまま manual finding として報告。
    // ok.ts は通常どおり変換される（1 ファイルの例外で全体が止まらない）。
    const boom = result.files.find((f) => f.path.endsWith("boom.ts"));
    expect(boom?.changed).toBe(false);
    expect(boom?.findings[0]?.kind).toBe("manual");
    expect(boom?.findings[0]?.message).toContain("transform failed");
    const ok = result.files.find((f) => f.path.endsWith("ok.ts"));
    expect(ok?.changed).toBe(true);
  });

  it("cleans up the tmp file when rename fails, leaving the source untouched (R14)", async () => {
    const file = join(tmpTestDir(), "renamefail-handler.ts");
    writeFileSync(file, XRAY_SOURCE);
    await expect(migrateFile(file, { write: true })).rejects.toThrow();
    expect(existsSync(`${file}.sekimori-tmp`)).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(XRAY_SOURCE);
  });

  it("reports an unreadable subdirectory as a finding and keeps scanning (R10-B)", async () => {
    // scan 中の下位 dir が読めない（EACCES 等）— その dir だけ skip して残りを処理する。
    const root = tmpTestDir();
    mkdirSync(join(root, "locked"));
    writeFileSync(join(root, "kept.ts"), XRAY_SOURCE);
    const result = await migratePaths([root]);
    expect(
      result.findings.some((f) => f.kind === "manual" && f.message.includes("cannot read")),
    ).toBe(true);
    expect(result.files.map((f) => f.path)).toEqual([join(root, "kept.ts")]);
  });
});
