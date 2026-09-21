/**
 * Transaction Search（CloudWatch Logs `aws/spans`）経路 — probe の一次検証 method。
 * span row の検索・link 判定はすべてここに置き、assert.ts は orchestration に専念する。
 */
import {
  type CloudWatchLogsClient,
  GetQueryResultsCommand,
  type ResultField,
  StartQueryCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import {
  MAX_CONSECUTIVE_ERRORS,
  POLL_MS,
  REQUEST_TIMEOUT_MS,
  RETRY_SLEEP_MS,
  SPANS_LOG_GROUP,
  TRACE_WINDOW_MS,
} from "./config.js";
import { sleep } from "./poll.js";
import { assertProbeId } from "./probe-id.js";

/**
 * Transaction Search（aws/spans）の 1 row。クエリで取る field を型で固定する。
 * 欠落 field は ""（空文字）になる — `undefined` と区別しないこと。
 */
export interface SpanRow {
  /** span 名。consumer の process span は `process <queue>` 形式。 */
  name?: string | undefined;
  traceId?: string | undefined;
  spanId?: string | undefined;
  parentSpanId?: string | undefined;
  kind?: string | undefined;
  /** `links.0.spanId` — 先頭 link だけを取る近道。`links` で全要素も拾う。 */
  link0?: string | undefined;
  /** 生の `links` field（JSON 文字列）。link が先頭要素でないケースを拾うために parse する。 */
  links?: string | undefined;
  /** span 属性 `sekimori.context.source` — context が来た carrier の証拠。 */
  ctx_source?: string | undefined;
}

/** Logs Insights の ResultField 列を SpanRow に畳む。field 名の無い列は捨てる。 */
function toSpanRow(fields: ResultField[]): SpanRow {
  const row: Record<string, string> = {};
  for (const f of fields) {
    if (typeof f.field === "string" && f.field !== "") row[f.field] = f.value ?? "";
  }
  return row;
}

/** Logs Insights query の terminal status — これ以外（Scheduled/Running 等）は poll 継続。 */
const TERMINAL_QUERY_STATUSES: ReadonlySet<string> = new Set([
  "Failed",
  "Cancelled",
  "Timeout",
  "Unknown",
]);

/** `linkedFromRows` の判定結果。 */
export interface LinkAssessment {
  /** consumer span が emitter span へ link/parent で繋がったか（厳密判定）。 */
  readonly linked: boolean;
  /** consumer が emitter と同じ trace に居るか（弱い証拠 — link の証明には使わない）。 */
  readonly sameTrace: boolean;
  /** どれかの consumer row が link field を持つか。全 row で空なら schema 疑いで X-Ray 再検。 */
  readonly linkFieldsPresent: boolean;
  /** `sekimori.context.source` — context が来た carrier。 */
  readonly contextSource: string | undefined;
  /** link が確かめられた consumer row（無ければ先頭の process row）。 */
  readonly consumer: SpanRow | undefined;
  /** emitter 側 row（report 用）。 */
  readonly emitterSpans: SpanRow[];
}

/**
 * 1 query を start し Complete まで poll する。terminal status（Failed/Cancelled/
 * Timeout/Unknown）や内側 deadline 切れは空配列で返し、外側の poll が再 query する。
 */
async function runQueryOnce(
  logs: CloudWatchLogsClient,
  probeId: string,
  deadline: number,
): Promise<SpanRow[]> {
  // queryString へ文字列補間する唯一の値 — Logs Insights の構文を壊す文字を
  // 持ち込まないよう、この境界でも検証する（呼び出し側の検証に依存しない）。
  assertProbeId(probeId);
  const started = await logs.send(
    new StartQueryCommand({
      logGroupName: SPANS_LOG_GROUP,
      startTime: Math.floor((Date.now() - TRACE_WINDOW_MS) / 1000),
      endTime: Math.floor(Date.now() / 1000),
      // ctx_source = span attribute `sekimori.context.source` — context が
      // sekimori の body carrier 経由か AWS ネイティブ（AWSTraceHeader）経由かを
      // 証拠として残す。links は link0（先頭）だけでなく配列全体も取り、
      // 後段で全 link を走査する（producer link が先頭に来ない false negative 対策）。
      queryString: `fields name, traceId, spanId, parentSpanId, kind, links.0.spanId as link0, links, attributes.sekimori.context.source as ctx_source
        | filter attributes.sekimori.probe_id = "${probeId}"`,
    }),
    { abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  );
  // 内側の query poll にも deadline を掛ける（Scheduled/Running が張り付くケース対策）。
  while (Date.now() < deadline) {
    const res = await logs.send(new GetQueryResultsCommand({ queryId: started.queryId }), {
      abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === "Complete") return (res.results ?? []).map(toSpanRow);
    if (res.status !== undefined && TERMINAL_QUERY_STATUSES.has(res.status)) {
      console.log(`query ${res.status} — retrying next poll`);
      return [];
    }
    await sleep(RETRY_SLEEP_MS);
  }
  return [];
}

export async function queryTransactionSearch(
  logs: CloudWatchLogsClient,
  probeId: string,
  producerSpanId: string | undefined,
  deadline: number,
): Promise<SpanRow[] | undefined> {
  let sawAnyResult = false;
  let consecutiveErrors = 0;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    let rows: SpanRow[];
    try {
      rows = await runQueryOnce(logs, probeId, deadline);
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      // aws/spans が無い = Transaction Search 未導入。X-Ray fallback へ。
      if (name === "ResourceNotFoundException") {
        console.log("transaction search unavailable: aws/spans log group not found");
        return undefined;
      }
      // その他（ThrottlingException 等の transient 系）は即座に fallback せず次の poll で再試行する。
      // 連続失敗が続くなら諦めて X-Ray へ倒す。
      consecutiveErrors++;
      console.log(`transaction search query failed (${name}) — retrying next poll`);
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) return sawAnyResult ? [] : undefined;
      continue;
    }
    consecutiveErrors = 0;
    if (rows.length > 0) sawAnyResult = true;
    // emitter response の traceparent から producer spanId が分かっているため、
    // consumer row がそれへ直接 link していれば verdict は確定済み —
    // emitter 側 row の index を待たずに返す（latency 短縮）。
    if (
      producerSpanId !== undefined &&
      rows.some(
        (r) =>
          typeof r.name === "string" &&
          r.name.startsWith("process ") &&
          linkSpanIds(r).has(producerSpanId),
      )
    ) {
      return rows;
    }
    // process span だけが先に index されるケースがある（ingest は function ごと・順不同）。
    // emitter 側の row が揃うまで返さない — 揃う前に return すると emitterSpans が空で
    // false NOT LINKED になる。
    const hasConsumer = rows.some(
      (r) => typeof r.name === "string" && r.name.startsWith("process "),
    );
    const hasProducer = rows.some(
      (r) => typeof r.name === "string" && r.name !== "" && !r.name.startsWith("process "),
    );
    if (hasConsumer && hasProducer) return rows;
    console.log(`waiting for spans... (${rows.length} so far)`);
  }
  return sawAnyResult ? [] : undefined;
}

/**
 * consumer row の link spanId 一覧を取り出す。
 * `link0`（クエリの `links.0.spanId`）に加え、生の `links` field を JSON として parse して
 * 全要素の spanId を拾う — producer への link が先頭要素でないケースを拾うため。
 * parse に失敗した / object でない links は link0 だけを信頼する。
 */
export function linkSpanIds(row: SpanRow): Set<string> {
  const ids = new Set<string>();
  if (typeof row.link0 === "string" && row.link0 !== "") ids.add(row.link0);
  const raw = row.links;
  if (typeof raw === "string" && raw !== "") {
    try {
      const parsed: unknown = JSON.parse(raw);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (item !== null && typeof item === "object") {
          for (const key of ["spanId", "id"] as const) {
            if (key in item) {
              const v = item[key];
              if (typeof v === "string" && v !== "") ids.add(v);
            }
          }
        }
      }
    } catch {
      // aws/spans の links 転記形式が JSON でないケース — link0 に倒す
    }
  }
  return ids;
}

export function linkedFromRows(rows: SpanRow[], producerSpanId?: string): LinkAssessment {
  const emitterSpans = rows.filter((r) => !r.name?.startsWith("process "));
  const consumers = rows.filter((r) => r.name?.startsWith("process "));
  // query の probe_id filter により emitterSpans には emitter 側 span だけが残る
  // （consumer invocation span は probe_id を持たない）。加えて emitter が response で
  // 返した traceparent の spanId（= inject した span そのもの）を照合対象に足す。
  const emitterIds = new Set(
    emitterSpans.map((e) => e.spanId).filter((s) => s !== undefined && s !== ""),
  );
  if (producerSpanId !== undefined && producerSpanId !== "") emitterIds.add(producerSpanId);
  // 欠落 field は "" になるため、値があるときだけ比較する（"" === "" の false positive 防止）。
  // 「同じ trace に居る」ことは link の証拠にならない — この topology では invocation span が
  // _X_AMZN_TRACE_ID 経由で常に emitter の trace に載るため、link（または明示的な parent）の
  // spanId 一致だけを「繋がった」と判定する。same-trace は別途記録する。
  // process span は複数 index され得るため先頭だけでなく全 row を見る。
  const linkedConsumer = consumers.find(
    (c) =>
      [...linkSpanIds(c)].some((id) => emitterIds.has(id)) ||
      (typeof c.parentSpanId === "string" &&
        c.parentSpanId !== "" &&
        emitterIds.has(c.parentSpanId)),
  );
  const linked = linkedConsumer !== undefined;
  const consumer = linkedConsumer ?? consumers[0];
  const sameTrace =
    consumer !== undefined &&
    emitterSpans.some(
      (e) =>
        typeof consumer.traceId === "string" &&
        consumer.traceId !== "" &&
        e.traceId === consumer.traceId,
    );
  // links field が一切転記されていない（aws/spans 側で link が落ちる / クエリ field 名違い）
  // かの検出用。全 consumer row で link が空なら X-Ray fallback で second opinion を取る。
  const linkFieldsPresent = consumers.some((c) => linkSpanIds(c).size > 0);
  // context がどの carrier から来たか（`body-detail` / `aws-trace-header` 等）の証拠。
  // consumer span の `sekimori.context.source` 属性をそのまま記録する。
  const contextSource =
    consumer !== undefined && typeof consumer.ctx_source === "string" && consumer.ctx_source !== ""
      ? consumer.ctx_source
      : undefined;
  return { linked, sameTrace, linkFieldsPresent, contextSource, consumer, emitterSpans };
}
