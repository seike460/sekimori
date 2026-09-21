import { BatchGetTracesCommand, GetTraceSummariesCommand } from "@aws-sdk/client-xray";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_CONSECUTIVE_ERRORS } from "./config.js";

const mocks = vi.hoisted(() => ({
  send: vi.fn<(command: unknown, options?: unknown) => Promise<unknown>>(),
}));

vi.mock("@aws-sdk/client-xray", async (importActual) => ({
  ...(await importActual<typeof import("@aws-sdk/client-xray")>()),
  XRayClient: vi.fn(() => ({ send: mocks.send })),
}));

import { XRayClient } from "@aws-sdk/client-xray";
import { checkViaXray } from "./xray-fallback.js";

const PRODUCER_SPAN = "0123456789abcdef";
const EMITTER_TRACE = "1-aaaaaaa1-bbbbbbbbbbbbbbbbbbbbbbbb";

const consumerDoc = (links: { id?: string; trace_id?: string }[], extra: object = {}) =>
  JSON.stringify({
    id: "consumer1",
    name: "process orders-queue",
    trace_id: "1-ccccccc2-dddddddddddddddddddddddd",
    links,
    ...extra,
  });

/** summaries は1件固定、traces は引数の doc 列を返す fake。 */
const serveDocs = (...docs: string[]) => {
  mocks.send.mockImplementation((command: unknown) => {
    if (command instanceof GetTraceSummariesCommand) {
      return Promise.resolve({ TraceSummaries: [{ Id: "1-ccccccc2-dddddddddddddddddddddddd" }] });
    }
    if (command instanceof BatchGetTracesCommand) {
      return Promise.resolve({ Traces: [{ Segments: docs.map((Document) => ({ Document })) }] });
    }
    return Promise.reject(new Error("unexpected command"));
  });
};

describe("checkViaXray", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.send.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("returns immediately when both correlation values are missing", async () => {
    const result = await checkViaXray(new XRayClient({}), undefined, undefined, Date.now());
    expect(result).toEqual({ linked: false, traceLinked: false, emitterTraceSpanIds: [] });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("reports linked when a consumer doc links to the producer span", async () => {
    serveDocs(consumerDoc([{ id: PRODUCER_SPAN, trace_id: EMITTER_TRACE }]));
    const result = await checkViaXray(
      new XRayClient({}),
      EMITTER_TRACE,
      PRODUCER_SPAN,
      Date.now() + 60_000,
    );
    expect(result.linked).toBe(true);
    expect(result.traceLinked).toBe(true);
    expect(result.consumer?.name).toBe("process orders-queue");
  });

  it("keeps polling while docs carry no link to the producer span", async () => {
    serveDocs(consumerDoc([{ id: "someone-else", trace_id: "1-eeee-ffff" }]));
    const pending = checkViaXray(
      new XRayClient({}),
      EMITTER_TRACE,
      PRODUCER_SPAN,
      Date.now() + 60_000,
    );
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.linked).toBe(false);
    // 相関の無い poll を2回行う（30s × 2 で deadline 到達）。
    expect(result.traceLinked).toBe(false);
    expect(result.consumer?.name).toBe("process orders-queue");
  });

  it("resends UnprocessedTraceIds on the next fetch attempt", async () => {
    const doc = consumerDoc([{ id: PRODUCER_SPAN, trace_id: EMITTER_TRACE }]);
    let batchCalls = 0;
    mocks.send.mockImplementation((command: unknown) => {
      if (command instanceof GetTraceSummariesCommand) {
        return Promise.resolve({ TraceSummaries: [{ Id: "1-ccccccc2-dddddddddddddddddddddddd" }] });
      }
      if (command instanceof BatchGetTracesCommand) {
        batchCalls++;
        return Promise.resolve(
          batchCalls === 1
            ? { UnprocessedTraceIds: ["1-ccccccc2-dddddddddddddddddddddddd"] }
            : { Traces: [{ Segments: [{ Document: doc }] }] },
        );
      }
      return Promise.reject(new Error("unexpected command"));
    });
    const pending = checkViaXray(
      new XRayClient({}),
      EMITTER_TRACE,
      PRODUCER_SPAN,
      Date.now() + 60_000,
    );
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.linked).toBe(true);
    expect(batchCalls).toBe(2);
  });

  it("gives up after consecutive fetch failures", async () => {
    mocks.send.mockRejectedValue(new Error("ThrottlingException"));
    const pending = checkViaXray(
      new XRayClient({}),
      EMITTER_TRACE,
      PRODUCER_SPAN,
      Date.now() + 10 * 60_000,
    );
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.linked).toBe(false);
    expect(result.consumer).toBeUndefined();
    // MAX_CONSECUTIVE_ERRORS 回の GetTraceSummaries 失敗で打ち切る。
    expect(mocks.send).toHaveBeenCalledTimes(MAX_CONSECUTIVE_ERRORS);
  });
});
