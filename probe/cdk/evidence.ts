/**
 * 証跡 JSON の prune — run のたびに timestamped ファイルが増えるだけだと stale な
 * 証跡が溜まるため、保持件数を超えた古いものを消す。pruning の失敗は probe 自体の
 * 成否に関係しないので warn に留める。
 */
import { readdirSync, unlinkSync } from "node:fs";

// 証跡ファイル名は `<ISO秒>-<probeId8>.json`。README 等の非証跡ファイルは消さない。
const EVIDENCE_NAME = /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-.+\.json$/;

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * `dir` 内の証跡ファイルを timestamp 降順で `keep` 件だけ残して削除する。
 * 一覧取得の失敗は warn で終了し、個別 unlink の失敗は warn に留めて残りの削除を続ける。
 */
export function pruneEvidence(dir: URL, keep: number): void {
  let stale: string[];
  try {
    stale = readdirSync(dir)
      .filter((name) => EVIDENCE_NAME.test(name))
      .sort()
      .reverse()
      .slice(keep);
  } catch (error) {
    console.warn(`could not list evidence dir: ${describeError(error)}`);
    return;
  }
  for (const name of stale) {
    try {
      unlinkSync(new URL(name, dir));
    } catch (error) {
      console.warn(`could not remove evidence file ${name}: ${describeError(error)}`);
    }
  }
}
