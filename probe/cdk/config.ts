/**
 * probe の実行時ノブ — すべて `SEKIMORI_PROBE_*` 環境変数で上書き可能。
 * タイミングや対象リソース名を変えたいときにコード編集を不要にする。
 * module load 時に 1 回だけ評価する（probe は短命スクリプトなので hot-reload は不要）。
 */

// setTimeout は 2^31-1 ms を超える delay を 1ms に丸める（高頻度 poll ループ化）、
// AbortSignal.timeout は 2^32-1 を超えると RangeError を投げる。小さい方を共通上限にする。
const MAX_ENV_INT = 2 ** 31 - 1;

/** 正の整数だけを受け付ける env reader。未設定・非数値・非正数・上限超過は fallback に倒す。 */
const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  // 整数のみ受理する — `0.5` を floor で `0` にすると「保持件数 0 = 全削除」や
  // 「取得試行 0 回」のような破壊的な値が sneak する（例: EVIDENCE_KEEP=0.5）。
  return Number.isInteger(n) && n > 0 && n <= MAX_ENV_INT ? n : fallback;
};

const envStr = (name: string, fallback: string): string => {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? fallback : raw;
};

/** 外側 poll の間隔。Transaction Search / X-Ray の両経路で共通。 */
export const POLL_MS = envInt("SEKIMORI_PROBE_POLL_MS", 30_000);

/** 1 検証経路あたりの deadline。span index の遅延を吸収するため十分に取る。 */
export const DEADLINE_MS = envInt("SEKIMORI_PROBE_DEADLINE_MS", 15 * 60_000);

/**
 * SDK 個別呼び出しの timeout。poll 全体の deadline とは別に、1 request が
 * ネットワーク起因で張り付いても poll loop を止めないよう守る。
 */
export const REQUEST_TIMEOUT_MS = envInt("SEKIMORI_PROBE_REQUEST_TIMEOUT_MS", 60_000);

/**
 * emitter Lambda 内の SDK 呼び出し timeout。emitter の Lambda timeout は 15s で、
 * それより長い request timeout は Lambda 内では発火しない — 確実に効く値にする。
 */
export const EMITTER_TIMEOUT_MS = envInt("SEKIMORI_PROBE_EMITTER_TIMEOUT_MS", 10_000);

/** 内側 query poll / unprocessed trace 再送の待機。 */
export const RETRY_SLEEP_MS = envInt("SEKIMORI_PROBE_RETRY_SLEEP_MS", 2_000);

/** span / trace の検索対象にする「現在から遡る」時間窓。 */
export const TRACE_WINDOW_MS = envInt("SEKIMORI_PROBE_WINDOW_MS", 30 * 60_000);

/** 連続する transient error で経路を諦める回数。 */
export const MAX_CONSECUTIVE_ERRORS = envInt("SEKIMORI_PROBE_MAX_ERRORS", 3);

/** BatchGetTraces の UnprocessedTraceIds 再送を試みる回数。 */
export const MAX_FETCH_ATTEMPTS = envInt("SEKIMORI_PROBE_FETCH_ATTEMPTS", 3);

/** consumer Lambda の X-Ray service name（GetTraceSummaries の filter 対象）。 */
export const CONSUMER_SERVICE = envStr(
  "SEKIMORI_PROBE_CONSUMER_SERVICE",
  "sekimori-probe-consumer",
);

/** Transaction Search の対象 log group。 */
export const SPANS_LOG_GROUP = envStr("SEKIMORI_PROBE_SPANS_LOG_GROUP", "aws/spans");

/** 証跡 JSON の出力先（リポジトリ root からの相対パス）。 */
export const EVIDENCE_DIR = envStr("SEKIMORI_PROBE_EVIDENCE_DIR", "docs/evidence").replace(
  /\/+$/,
  "",
);

/** 証跡 JSON の保持件数。run ごとに timestamped ファイルを足すため、古いものから pruning する。 */
export const EVIDENCE_KEEP = envInt("SEKIMORI_PROBE_EVIDENCE_KEEP", 30);
