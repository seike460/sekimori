/** probe consumer — SQS record から probeId を読み、emitter span への link を張る。 */
import type { SQSBatchResponse, SQSEvent } from "aws-lambda";
import { withSqsRecord } from "sekimori/sqs";
import { PROBE_ID_PATTERN } from "../probe-id.js";

/**
 * body から probeId を取り出す。JSON の parse 失敗は throw（呼び出し側が
 * 部分バッチ失敗にする）。envelope が probe 形でない / probeId が
 * emitter・assert と同じ文字集合に収まらない場合は attribute を立てずに
 * undefined を返す — 安全でない値を span attribute に載せない。
 */
function parseProbeId(body: string): string | undefined {
  const envelope: unknown = JSON.parse(body);
  if (envelope === null || typeof envelope !== "object" || !("detail" in envelope)) {
    return undefined;
  }
  const detail = envelope.detail;
  if (detail === null || typeof detail !== "object" || !("probeId" in detail)) {
    return undefined;
  }
  const probeId = detail.probeId;
  return typeof probeId === "string" && PROBE_ID_PATTERN.test(probeId) ? probeId : undefined;
}

/** record ごとに CONSUMER span を開き、probe_id を刻む。失敗は部分バッチ失敗として返す。 */
export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const batchItemFailures: SQSBatchResponse["batchItemFailures"] = [];
  for (const record of event.Records) {
    try {
      await withSqsRecord(record, (span) => {
        const probeId = parseProbeId(record.body);
        if (probeId !== undefined) span.setAttribute("sekimori.probe_id", probeId);
      });
    } catch (error) {
      // probe は接続性の切り分けが目的 — 失敗理由を残して DLQ 前の調査を容易にする。
      console.warn(
        `record ${record.messageId} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
};
