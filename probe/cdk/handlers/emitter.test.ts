import type { PutEventsRequest, PutEventsResponse } from "@aws-sdk/client-eventbridge";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  send: vi.fn<(command: { input: PutEventsRequest }) => Promise<PutEventsResponse>>(),
}));

vi.mock("@aws-sdk/client-eventbridge", () => ({
  EventBridgeClient: vi.fn(() => ({ send: mocks.send })),
  PutEventsCommand: vi.fn((input: PutEventsRequest) => ({ input })),
}));

import { handler } from "./emitter.js";

const sentEntry = () => {
  const entry = mocks.send.mock.calls[0]?.[0].input.Entries?.[0];
  if (entry === undefined) throw new Error("no entry sent");
  return entry;
};

const sentDetail = (): { probeId?: unknown } => {
  const parsed: unknown = JSON.parse(sentEntry().Detail ?? "{}");
  if (typeof parsed !== "object" || parsed === null) throw new Error("detail is not an object");
  return parsed;
};

describe("emitter handler", () => {
  beforeEach(() => {
    mocks.send.mockReset().mockResolvedValue({ FailedEntryCount: 0 });
    vi.stubEnv("BUS_NAME", "probe-bus");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("emits an entry carrying a generated probeId", async () => {
    const result = await handler();
    expect(result.probeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.failedEntryCount).toBe(0);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(sentEntry().EventBusName).toBe("probe-bus");
    expect(sentDetail().probeId).toBe(result.probeId);
  });

  it("echoes a caller-supplied probeId", async () => {
    const result = await handler({ probeId: "probe-123" });
    expect(result.probeId).toBe("probe-123");
  });

  it("rejects a probeId with unsafe characters before sending", async () => {
    // probeId は assert が Logs Insights query / ファイル名へ埋め込む — 起点で弾く。
    await expect(handler({ probeId: 'x" | drop' })).rejects.toThrow(/unsafe characters/);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("fails fast when BUS_NAME is unset", async () => {
    vi.stubEnv("BUS_NAME", "");
    await expect(handler({})).rejects.toThrow(/BUS_NAME/);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("surfaces PutEvents failed entry count", async () => {
    mocks.send.mockResolvedValue({ FailedEntryCount: 1 });
    const result = await handler({});
    expect(result.failedEntryCount).toBe(1);
  });

  it("includes per-entry error details when PutEvents rejects entries", async () => {
    mocks.send.mockResolvedValue({
      FailedEntryCount: 1,
      Entries: [{ ErrorCode: "ThrottlingException", ErrorMessage: "rate exceeded" }],
    });
    const result = await handler({});
    expect(result.failedEntries).toEqual(["ThrottlingException: rate exceeded"]);
  });
});
