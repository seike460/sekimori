/** probe emitter — probeId を採番して carrier 付き EventBridge entry を発行する。 */
import { randomUUID } from "node:crypto";
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { trace } from "@opentelemetry/api";
import { injectEventBridgeEntry } from "sekimori/eventbridge";
import { EMITTER_TIMEOUT_MS } from "../config.js";
import { assertProbeId } from "../probe-id.js";

/** emitter が受ける invoke event。`probeId` 省略時は UUID を採番する。 */
export interface ProbeEvent {
  probeId?: string | undefined;
}

/** `Detail` envelope の形 — `traceparent` は injectEventBridgeEntry が書き込む。 */
interface ProbeDetail {
  probeId: string;
  emittedAt: string;
  traceparent?: string | undefined;
}

/** emitter の応答 — assert が span 相関（`traceparent` / `traceHeader`）に使う。 */
export interface ProbeResult {
  probeId: string;
  failedEntryCount: number;
  /** PutEvents の entry レベル失敗の詳細（`"ErrorCode: message"` 列）。0 件なら省略。 */
  failedEntries?: string[] | undefined;
  traceHeader?: string | undefined;
  traceparent?: string | undefined;
}

const client = new EventBridgeClient({});

/**
 * inject 後の `Detail` から traceparent を拾う。inject は carrier key を足すだけで
 * JSON 構造は維持するが、将来の変更で Detail が非 JSON になってもここで落とさない。
 */
function readTraceparent(detailJson: string | undefined): string | undefined {
  if (detailJson === undefined) return undefined;
  let detail: unknown;
  try {
    detail = JSON.parse(detailJson);
  } catch {
    return undefined;
  }
  if (detail === null || typeof detail !== "object" || !("traceparent" in detail)) {
    return undefined;
  }
  return typeof detail.traceparent === "string" ? detail.traceparent : undefined;
}

/** probe の起点。invocation span に probe_id を刻み、EventBridge へ context 付きで発行する。 */
export const handler = async (event: ProbeEvent = {}): Promise<ProbeResult> => {
  const busName = process.env.BUS_NAME;
  if (busName === undefined || busName === "") {
    throw new Error("BUS_NAME is not set — deploy the emitter via the probe stack");
  }
  const probeId = event.probeId ?? randomUUID();
  // probeId は assert が query / report ファイル名へ埋め込む — 起点で安全な文字集合に制限する。
  assertProbeId(probeId);
  trace.getActiveSpan()?.setAttribute("sekimori.probe_id", probeId);
  const entry = injectEventBridgeEntry({
    EventBusName: busName,
    Source: "sekimori.probe",
    DetailType: "trace-probe",
    Detail: JSON.stringify({
      probeId,
      emittedAt: new Date().toISOString(),
    } satisfies ProbeDetail),
  });
  const result = await client.send(new PutEventsCommand({ Entries: [entry] }), {
    // Lambda timeout(15s) より短い EMITTER_TIMEOUT_MS — それ以上の値は発火しない。
    abortSignal: AbortSignal.timeout(EMITTER_TIMEOUT_MS),
  });
  // entry 単位の失敗理由（ErrorCode/ErrorMessage）を response に載せる —
  // assert 側が「届かなかった原因」を証跡に残せる。
  const failedEntries = (result.Entries ?? [])
    .filter((e) => e.ErrorCode !== undefined)
    .map((e) => `${e.ErrorCode}: ${e.ErrorMessage ?? "(no message)"}`);
  return {
    probeId,
    failedEntryCount: result.FailedEntryCount ?? 0,
    ...(failedEntries.length > 0 ? { failedEntries } : {}),
    traceHeader: entry.TraceHeader,
    traceparent: readTraceparent(entry.Detail),
  };
};
