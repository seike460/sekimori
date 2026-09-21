import { afterEach, describe, expect, it, vi } from "vitest";

/** config.ts は import 時に env を読む — 各ケースで module を読み直す。 */
const loadConfig = () => import("./config.js");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("probe config", () => {
  it("env 未設定なら既定値を使う", async () => {
    const c = await loadConfig();
    expect(c.POLL_MS).toBe(30_000);
    expect(c.DEADLINE_MS).toBe(15 * 60_000);
    expect(c.REQUEST_TIMEOUT_MS).toBe(60_000);
    expect(c.EMITTER_TIMEOUT_MS).toBe(10_000);
    expect(c.RETRY_SLEEP_MS).toBe(2_000);
    expect(c.TRACE_WINDOW_MS).toBe(30 * 60_000);
    expect(c.MAX_CONSECUTIVE_ERRORS).toBe(3);
    expect(c.MAX_FETCH_ATTEMPTS).toBe(3);
    expect(c.CONSUMER_SERVICE).toBeTruthy();
    expect(c.SPANS_LOG_GROUP).toBe("aws/spans");
    expect(c.EVIDENCE_DIR).toBe("docs/evidence");
  });

  it("env で数値ノブを上書きできる", async () => {
    vi.stubEnv("SEKIMORI_PROBE_POLL_MS", "5000");
    vi.stubEnv("SEKIMORI_PROBE_MAX_ERRORS", "7");
    vi.resetModules();
    const c = await loadConfig();
    expect(c.POLL_MS).toBe(5_000);
    expect(c.MAX_CONSECUTIVE_ERRORS).toBe(7);
  });

  it("数値に parse できない env は既定値へ落ちる", async () => {
    vi.stubEnv("SEKIMORI_PROBE_DEADLINE_MS", "soon");
    vi.resetModules();
    const c = await loadConfig();
    expect(c.DEADLINE_MS).toBe(15 * 60_000);
  });

  it("env で文字列ノブを上書きできる", async () => {
    vi.stubEnv("SEKIMORI_PROBE_SPANS_LOG_GROUP", "custom/group");
    vi.resetModules();
    const c = await loadConfig();
    expect(c.SPANS_LOG_GROUP).toBe("custom/group");
  });
});

describe("envInt の整数検証（回帰: 小数が floor で 0 になり破壊的値になる）", () => {
  it.each([
    ["SEKIMORI_PROBE_EVIDENCE_KEEP", "0.5", "EVIDENCE_KEEP", 30],
    ["SEKIMORI_PROBE_FETCH_ATTEMPTS", "0.5", "MAX_FETCH_ATTEMPTS", 3],
    ["SEKIMORI_PROBE_MAX_ERRORS", "0", "MAX_CONSECUTIVE_ERRORS", 3],
    ["SEKIMORI_PROBE_POLL_MS", "-3", "POLL_MS", 30_000],
    ["SEKIMORI_PROBE_DEADLINE_MS", "2.5", "DEADLINE_MS", 15 * 60_000],
    // setTimeout の上限（2^31-1）超過は 1ms へ丸められ高頻度 poll になる。
    ["SEKIMORI_PROBE_POLL_MS", "2147483648", "POLL_MS", 30_000],
    // AbortSignal.timeout の上限（2^32-1）超過は RangeError になる。
    ["SEKIMORI_PROBE_REQUEST_TIMEOUT_MS", "4294967296", "REQUEST_TIMEOUT_MS", 60_000],
  ] as const)("%s=%s は既定値へ落ちる", async (env, value, key, fallback) => {
    vi.stubEnv(env, value);
    vi.resetModules();
    const c = await loadConfig();
    expect(c[key]).toBe(fallback);
  });

  it("正の整数は受理する", async () => {
    vi.stubEnv("SEKIMORI_PROBE_EVIDENCE_KEEP", "5");
    vi.resetModules();
    const c = await loadConfig();
    expect(c.EVIDENCE_KEEP).toBe(5);
  });

  it("上限ちょうど（2^31-1）は受理する", async () => {
    vi.stubEnv("SEKIMORI_PROBE_DEADLINE_MS", "2147483647");
    vi.resetModules();
    const c = await loadConfig();
    expect(c.DEADLINE_MS).toBe(2147483647);
  });
});
