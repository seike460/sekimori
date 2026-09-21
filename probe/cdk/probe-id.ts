/**
 * probeId は Logs Insights の query string と report ファイル名に埋め込むため、
 * 許す文字集合を制限する。emitter event 由来（呼び出し側が指定可能）なので
 * emitter（起点）と assert（検証側）の両方が同じ規約で弾く。
 */
export const PROBE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** probeId が安全な文字集合か検査する。違反なら Error を投げる。 */
export function assertProbeId(probeId: string): void {
  if (!PROBE_ID_PATTERN.test(probeId)) {
    throw new Error(
      `probeId has unsafe characters — refusing to embed it in queries/filenames: ${JSON.stringify(probeId)}`,
    );
  }
}
