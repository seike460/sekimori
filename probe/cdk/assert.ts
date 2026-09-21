/**
 * Trace connectivity assertion.
 *
 * 手順:
 *  1. emitter を Invoke し probeId を得る
 *  2. Transaction Search の spans（CloudWatch Logs `aws/spans`）を probeId で Logs Insights 検索する
 *     → `transaction-search.ts`
 *  3. Transaction Search が無効 / 見つからなければ X-Ray BatchGetTraces + GetTraceSummaries に落とす
 *     → `xray-fallback.ts`
 *  4. consumer の `process <queue>` span が emitter の span へ link（または parent）を持つことを確かめる
 *     （同じ trace に居るだけでは link の証拠にならない — invocation span は常に同 trace に載る）
 *  5. 結果を docs/evidence/<date>.json に書き、GitHub Actions の job summary にも出す。
 *     証跡は EVIDENCE_KEEP 件に prune され、rerun で古い artifact が溜まらない。
 *
 * 実 AWS へのアクセスと課金を伴うため、明示的に `pnpm --filter @sekimori/probe run assert` で実行する。
 * このファイルは orchestration（invoke → assess → report）だけを持つ。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { XRayClient } from "@aws-sdk/client-xray";
import { DEADLINE_MS, EVIDENCE_DIR, EVIDENCE_KEEP, REQUEST_TIMEOUT_MS } from "./config.js";
import { pruneEvidence } from "./evidence.js";
import { assertProbeId } from "./probe-id.js";
import {
  type LinkAssessment,
  linkedFromRows,
  queryTransactionSearch,
  type SpanRow,
} from "./transaction-search.js";
import {
  spanIdFromTraceparent,
  type XrayDoc,
  xrayDocContextSource,
  xrayParentIdFromHeader,
  xrayTraceIdFromHeader,
  xrayTraceIdFromTraceparent,
} from "./xray-doc.js";
import { checkViaXray } from "./xray-fallback.js";

interface Outputs {
  SekimoriProbe: {
    EmitterFunctionName: string;
    ConsumerFunctionName: string;
    QueueUrl: string;
    BusName: string;
  };
}

/** emitter Lambda の応答。`probeId` / 相関 field は任意 — 検証は invokeEmitter が行う。 */
interface EmitterPayload {
  probeId?: string;
  traceHeader?: string;
  traceparent?: string;
  failedEntryCount?: number;
  failedEntries?: string[];
}

/** probeId が検証済みの emitter 応答。 */
interface ValidatedEmitterPayload extends EmitterPayload {
  probeId: string;
}

/** 検証 method に依らず report に記録する field（証跡 JSON の schema）。 */
interface ProbeReport {
  linked: boolean;
  sameTrace: boolean;
  traceLinked?: boolean;
  // context がどの carrier から来たか（body-detail / aws-trace-header 等）。
  // linked の判定は spanId 照合だけで行い、carrier 帰属は証拠として別途記録する。
  contextSource: string | null;
  linkEvidence: "span-link" | "trace-link" | "same-trace" | "none";
  consumerSpan: SpanRow | XrayDoc | null;
  emitterSpans?: SpanRow[];
  emitterTraceSpanIds?: string[];
  emitterTraceId: string | null;
  producerSpanId: string | null;
  transactionSearchRows: number | null;
}

interface Assessment {
  method: "transaction-search" | "xray";
  report: ProbeReport;
}

/**
 * cdk.outputs.json から stack output を読む。
 * script の隣の固定パス（cwd 依存にしない）。deploy 未実施で ENOENT が投げられるのが
 * 最も多い失敗なので、friendly エラーに畳み込む。
 */
function loadProbeOutputs(): Outputs["SekimoriProbe"] {
  let outputs: Partial<Outputs>;
  try {
    const raw: unknown = JSON.parse(
      readFileSync(new URL("cdk.outputs.json", import.meta.url), "utf8"),
    );
    if (raw === null || typeof raw !== "object") throw new Error("not a JSON object");
    outputs = raw as Partial<Outputs>;
  } catch {
    throw new Error(
      "cdk.outputs.json not found or unreadable — deploy the probe stack first (`pnpm --filter @sekimori/probe run deploy`)",
    );
  }
  if (outputs.SekimoriProbe?.EmitterFunctionName === undefined) {
    throw new Error(
      "cdk.outputs.json has no SekimoriProbe outputs — deploy the probe stack first (`pnpm --filter @sekimori/probe run deploy`)",
    );
  }
  return outputs.SekimoriProbe;
}

/** emitter を invoke し、相関に必要な field を検証して返す。 */
async function invokeEmitter(
  lambda: LambdaClient,
  functionName: string,
): Promise<ValidatedEmitterPayload> {
  const invoked = await lambda.send(
    new InvokeCommand({ FunctionName: functionName, Payload: "{}" }),
    { abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  );
  // fail fast — invoke が失敗/欠損なら trace を待つ意味が無い。
  if (invoked.FunctionError !== undefined) {
    const errPayload = Buffer.from(invoked.Payload ?? new Uint8Array()).toString("utf8");
    throw new Error(`emitter invoke failed (${invoked.FunctionError}): ${errPayload}`);
  }
  let payload: EmitterPayload;
  try {
    const raw: unknown = JSON.parse(
      Buffer.from(invoked.Payload ?? new Uint8Array()).toString("utf8"),
    );
    if (raw === null || typeof raw !== "object") throw new Error("not a JSON object");
    payload = raw as EmitterPayload;
  } catch {
    throw new Error("emitter response is not JSON — cannot correlate spans");
  }
  if (typeof payload.probeId !== "string" || payload.probeId === "") {
    throw new Error("emitter response has no probeId — cannot correlate spans");
  }
  // probeId は Logs Insights の query string と report ファイル名に埋め込む。
  // emitter event 由来（呼び出し側が指定可能）なので、安全な文字集合に制限する。
  assertProbeId(payload.probeId);
  // PutEvents が entry-level で失敗していると event は bus に届かない — trace を待っても無駄。
  if ((payload.failedEntryCount ?? 0) > 0) {
    const detail = payload.failedEntries?.join("; ");
    throw new Error(
      `PutEvents reported ${payload.failedEntryCount} failed entries — event never reached the bus` +
        (detail !== undefined && detail !== "" ? ` (${detail})` : ""),
    );
  }
  return { ...payload, probeId: payload.probeId };
}

/**
 * Transaction Search を一次経路にし、links field が欠ける等の疑いがあれば
 * X-Ray BatchGetTraces で再検する（second opinion）。
 */
async function assessConnectivity(params: {
  logs: CloudWatchLogsClient;
  xray: XRayClient;
  probeId: string;
  producerSpanId: string | undefined;
  emitterTraceId: string | undefined;
}): Promise<Assessment> {
  const { logs, xray, probeId, producerSpanId, emitterTraceId } = params;
  const deadline = Date.now() + DEADLINE_MS;
  const rows = await queryTransactionSearch(logs, probeId, producerSpanId, deadline);
  // links field が全 consumer row で空なら Transaction Search が link を転記していない
  // （あるいは field 名の想定違い）可能性がある — NOT LINKED と断じず X-Ray で再検する。
  const rowResult: LinkAssessment | undefined =
    rows !== undefined && rows.length > 0 ? linkedFromRows(rows, producerSpanId) : undefined;
  const suspectLinkSchema =
    rowResult !== undefined && !rowResult.linked && !rowResult.linkFieldsPresent;

  if (rowResult !== undefined && !suspectLinkSchema) {
    const { linked, sameTrace, contextSource, consumer, emitterSpans } = rowResult;
    return {
      method: "transaction-search",
      report: {
        linked,
        sameTrace,
        contextSource: contextSource ?? null,
        linkEvidence: linked ? "span-link" : sameTrace ? "same-trace" : "none",
        consumerSpan: consumer ?? null,
        emitterSpans,
        // X-Ray fallback と同じ correlation field を method に依らず記録する（schema を揃える）。
        emitterTraceId: emitterTraceId ?? null,
        producerSpanId: producerSpanId ?? null,
        transactionSearchRows: rows?.length ?? null,
      },
    };
  }

  if (suspectLinkSchema) {
    console.log(
      "transaction search rows carry no link fields — verifying via X-Ray as second opinion",
    );
  }
  console.log(`falling back to X-Ray BatchGetTraces (emitter trace ${emitterTraceId})`);
  const { linked, traceLinked, consumer, emitterTraceSpanIds } = await checkViaXray(
    xray,
    emitterTraceId,
    producerSpanId,
    Date.now() + DEADLINE_MS,
  );
  // `trace_id` は segment レベルの field — ADOT 由来の subsegment doc は持たないことがあり、
  // その場合 sameTrace は false negative になり得る（linked / traceLinked の厳密判定には影響しない）。
  const sameTrace = emitterTraceId !== undefined && consumer?.trace_id === emitterTraceId;
  return {
    method: "xray",
    report: {
      linked,
      traceLinked,
      sameTrace,
      contextSource: xrayDocContextSource(consumer) ?? null,
      linkEvidence: linked
        ? "span-link"
        : traceLinked
          ? "trace-link"
          : sameTrace
            ? "same-trace"
            : "none",
      consumerSpan: consumer ?? null,
      emitterTraceSpanIds,
      emitterTraceId: emitterTraceId ?? null,
      producerSpanId: producerSpanId ?? null,
      transactionSearchRows: rows?.length ?? null,
    },
  };
}

/**
 * 証跡 JSON を docs/evidence/ に書き、GitHub Actions の job summary にも出す。
 * @returns linked — 呼び出し側が exit code に写す。
 */
function writeEvidence(probeId: string, assessment: Assessment): boolean {
  const { method, report } = assessment;
  const linked = report.linked;
  // 同日の複数 run が上書きし合わないようファイル名は秒までの timestamp を入れる。
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const file = `${EVIDENCE_DIR}/${stamp}-${probeId.slice(0, 8)}.json`;
  const dir = new URL(`../../${EVIDENCE_DIR}/`, import.meta.url);
  mkdirSync(dir, { recursive: true });
  const full = {
    probeId,
    checkedAt: new Date().toISOString(),
    method,
    ...report,
  };
  writeFileSync(
    new URL(`${stamp}-${probeId.slice(0, 8)}.json`, dir),
    JSON.stringify(full, null, 2),
  );
  console.log(`${linked ? "LINKED" : "NOT LINKED"} (${method}) — report written to ${file}`);
  pruneEvidence(dir, EVIDENCE_KEEP);
  if (process.env.GITHUB_STEP_SUMMARY) {
    // summary 書き込みの失敗で probe 自体を fail にしない — 証跡 JSON は既に書けている。
    try {
      writeFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `## sekimori trace connectivity\n\n- probe: \`${probeId}\`\n- method: \`${method}\`\n- result: **${linked ? "LINKED" : "NOT LINKED"}**\n`,
        { flag: "a", encoding: "utf8" },
      );
    } catch (error) {
      console.warn(
        `could not write GITHUB_STEP_SUMMARY: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return linked;
}

async function main(): Promise<void> {
  const probe = loadProbeOutputs();
  // region は環境変数で明示可能（未設定なら AWS SDK の default chain に従う）。
  const region =
    process.env.SEKIMORI_PROBE_REGION ?? process.env.AWS_REGION ?? process.env.CDK_DEFAULT_REGION;
  const config = region !== undefined ? { region } : {};
  const lambda = new LambdaClient(config);
  const logsClient = new CloudWatchLogsClient(config);
  const xray = new XRayClient(config);

  const payload = await invokeEmitter(lambda, probe.EmitterFunctionName);
  // emitter が inject に使った span — link の照合対象。`traceparent` が欠落・非 `00`
  // version でも `TraceHeader` の `Parent=` が同じ span id を持つため fallback する。
  const producerSpanId =
    spanIdFromTraceparent(payload.traceparent) ?? xrayParentIdFromHeader(payload.traceHeader);
  // 検証 method に依らず report に記録する correlation 情報。
  const emitterTraceId =
    xrayTraceIdFromHeader(payload.traceHeader) ?? xrayTraceIdFromTraceparent(payload.traceparent);
  console.log(
    `probe ${payload.probeId} emitted; TraceHeader=${payload.traceHeader}; producerSpan=${producerSpanId}`,
  );

  const assessment = await assessConnectivity({
    logs: logsClient,
    xray,
    probeId: payload.probeId,
    producerSpanId,
    emitterTraceId,
  });
  const linked = writeEvidence(payload.probeId, assessment);
  process.exitCode = linked ? 0 : 1;
}

// import されただけでは走らない（unit test から判定関数を読めるようにするため）。
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
