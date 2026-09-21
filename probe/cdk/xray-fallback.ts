/**
 * X-Ray BatchGetTraces 経路 — Transaction Search が使えない / link field を
 * 転記していない疑いがあるときの second opinion。doc の判定ルールは
 * xray-doc.ts に置き、ここは AWS 呼び出しと poll の orchestration に専念する。
 */
import {
  BatchGetTracesCommand,
  GetTraceSummariesCommand,
  type XRayClient,
} from "@aws-sdk/client-xray";
import {
  CONSUMER_SERVICE,
  MAX_CONSECUTIVE_ERRORS,
  MAX_FETCH_ATTEMPTS,
  POLL_MS,
  REQUEST_TIMEOUT_MS,
  RETRY_SLEEP_MS,
  TRACE_WINDOW_MS,
} from "./config.js";
import { sleep } from "./poll.js";
import {
  flattenDocs,
  parseXrayDoc,
  type XrayDoc,
  xrayDocLinked,
  xrayDocTraceLinked,
} from "./xray-doc.js";

/** BatchGetTraces の上限は 1 リクエスト 5 trace id — 1 chunk 分を NextToken で全ページ読む。 */
async function fetchChunk(
  xray: XRayClient,
  chunk: string[],
  docs: XrayDoc[],
  unprocessed: Set<string>,
): Promise<void> {
  let nextToken: string | undefined;
  do {
    const res = await xray.send(
      new BatchGetTracesCommand({ TraceIds: chunk, NextToken: nextToken }),
      { abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    );
    for (const t of res.Traces ?? []) {
      for (const seg of t.Segments ?? []) {
        const doc = parseXrayDoc(seg.Document);
        if (doc !== undefined) docs.push(doc);
      }
    }
    for (const id of res.UnprocessedTraceIds ?? []) unprocessed.add(id);
    nextToken = res.NextToken;
  } while (nextToken !== undefined && nextToken !== "");
}

async function fetchDocs(xray: XRayClient, traceIds: string[]): Promise<XrayDoc[]> {
  const docs: XrayDoc[] = [];
  // UnprocessedTraceIds（throttle 等で処理されなかった id）は bounded retry で再送する。
  let pending = [...traceIds];
  for (let attempt = 0; attempt < MAX_FETCH_ATTEMPTS && pending.length > 0; attempt++) {
    if (attempt > 0) await sleep(RETRY_SLEEP_MS);
    const unprocessed = new Set<string>();
    for (let i = 0; i < pending.length; i += 5) {
      await fetchChunk(xray, pending.slice(i, i + 5), docs, unprocessed);
    }
    pending = [...unprocessed];
  }
  return docs;
}

/** consumer service の trace id を直近 30 分窓から全ページ収集する。 */
async function listConsumerTraceIds(xray: XRayClient): Promise<Set<string>> {
  const ids = new Set<string>();
  // GetTraceSummaries は NextToken でページングする — 先頭ページだけだと新しい trace を逃す。
  let nextToken: string | undefined;
  do {
    const summaries = await xray.send(
      new GetTraceSummariesCommand({
        StartTime: new Date(Date.now() - TRACE_WINDOW_MS),
        EndTime: new Date(),
        FilterExpression: `service("${CONSUMER_SERVICE}")`,
        Sampling: false,
        NextToken: nextToken,
      }),
      { abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    );
    for (const s of summaries.TraceSummaries ?? []) {
      if (s.Id !== undefined) ids.add(s.Id);
    }
    nextToken = summaries.NextToken;
  } while (nextToken !== undefined && nextToken !== "");
  return ids;
}

interface DocsAssessment {
  /** producer span への link/parent が確かめられた consumer doc。 */
  readonly linkedConsumer: XrayDoc | undefined;
  /** emitter trace 内の「何らかの span」への link を持つ consumer doc があったか。 */
  readonly sawTraceLink: boolean;
  /** report 用に残す consumer doc — emitter と同 trace を優先、無ければ最新。 */
  readonly lastConsumer: XrayDoc | undefined;
}

/**
 * 窓内の全 consumer doc を評価し、emitter trace 内の非-process doc id を
 * `emitterTraceSpanIds` へ記録する（report 用 — AWS 中継 node 等が混ざるため
 * 「emitter の span」とは読まない。link 判定は producerSpanId 厳密照合のみ）。
 */
function evaluateDocs(
  docs: XrayDoc[],
  emitterTraceId: string | undefined,
  producerSpanId: string | undefined,
  emitterTraceSpanIds: Set<string>,
): DocsAssessment {
  for (const d of docs) {
    if (
      d.id !== undefined &&
      emitterTraceId !== undefined &&
      d.trace_id === emitterTraceId &&
      !d.name?.startsWith("process ")
    ) {
      emitterTraceSpanIds.add(d.id);
    }
  }
  // 先頭の process doc が stale な別 trace でも諦めない — 全 consumer doc を見る。
  const consumers = docs.filter((d) => d.name?.startsWith("process "));
  const strictConsumer = consumers.find((c) => xrayDocLinked(c, producerSpanId));
  const sawTraceLink = consumers.some((c) => xrayDocTraceLinked(c, emitterTraceId));
  const lastConsumer =
    consumers.find((c) => emitterTraceId !== undefined && c.trace_id === emitterTraceId) ??
    consumers.at(-1);
  // linked 確定時は traceLinked も true として返す（link は trace 内 link の厳格条件）。
  return {
    linkedConsumer: strictConsumer,
    sawTraceLink: strictConsumer !== undefined || sawTraceLink,
    lastConsumer,
  };
}

/** `checkViaXray` の結果 — `consumer` は見つかった場合だけ返す。 */
export interface XrayCheckResult {
  linked: boolean;
  traceLinked: boolean;
  consumer?: XrayDoc;
  emitterTraceSpanIds: string[];
}

export async function checkViaXray(
  xray: XRayClient,
  emitterTraceId: string | undefined,
  producerSpanId: string | undefined,
  deadline: number,
): Promise<XrayCheckResult> {
  // 相関値が両方欠けると link / trace-link の判定が永遠に成立しない — 15 分 poll せず即座に返す。
  if (emitterTraceId === undefined && producerSpanId === undefined) {
    return { linked: false, traceLinked: false, emitterTraceSpanIds: [] };
  }
  const emitterTraceSpanIds = new Set<string>();
  if (producerSpanId !== undefined) emitterTraceSpanIds.add(producerSpanId);
  let lastConsumer: XrayDoc | undefined;
  let traceLinked = false;
  let consecutiveErrors = 0;
  while (Date.now() < deadline) {
    // consumer の process span は invocation span 経由で emitter の trace 内に載るため、
    // emitter trace 自身も毎回 fetch する（consumer segment は遅れて届く）。
    // 除外すると linked な doc に永遠に辿り着かない。
    const ids = new Set<string>();
    if (emitterTraceId !== undefined) ids.add(emitterTraceId);
    try {
      for (const id of await listConsumerTraceIds(xray)) ids.add(id);
      if (ids.size > 0) {
        const docs = flattenDocs(await fetchDocs(xray, [...ids]));
        const {
          linkedConsumer,
          sawTraceLink,
          lastConsumer: candidate,
        } = evaluateDocs(docs, emitterTraceId, producerSpanId, emitterTraceSpanIds);
        if (sawTraceLink) traceLinked = true;
        if (linkedConsumer !== undefined) {
          return {
            linked: true,
            traceLinked: true,
            consumer: linkedConsumer,
            emitterTraceSpanIds: [...emitterTraceSpanIds],
          };
        }
        // linked でない consumer doc は記録だけして poll 継続（対象 trace の到着を待つ）。
        if (candidate !== undefined) lastConsumer = candidate;
      }
      consecutiveErrors = 0;
    } catch (error) {
      // Throttling / transient 系で poll 全体を落とさない。連続失敗だけを数えて諦める。
      consecutiveErrors++;
      const name = error instanceof Error ? error.name : String(error);
      console.log(`x-ray fetch failed (${name}) — retrying next poll`);
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) break;
    }
    console.log(`waiting for consumer traces... (${ids.size} in window)`);
    await sleep(POLL_MS);
  }
  return lastConsumer === undefined
    ? { linked: false, traceLinked, emitterTraceSpanIds: [...emitterTraceSpanIds] }
    : {
        linked: false,
        traceLinked,
        consumer: lastConsumer,
        emitterTraceSpanIds: [...emitterTraceSpanIds],
      };
}
