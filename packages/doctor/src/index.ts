/** doctor の public API — analyze/format の barrel と report 整形。 */
import { readFile } from "node:fs/promises";
import type { DoctorReport, FunctionReport } from "./checks.js";
import { type AnalyzeOptions, analyzeFunction } from "./live.js";
import { analyzeTemplate, type CfnTemplate } from "./template.js";

export type { DoctorCheck, DoctorReport, FunctionFacts, FunctionReport } from "./checks.js";
export { MIN_ADOT_LAYER_VERSION } from "./checks.js";
export {
  evaluatePolicyDocument,
  iamActionMatches,
  type PolicyVerdict,
  policyDocumentAllowsXrayWrite,
  XRAY_ALLOWED_MANAGED_POLICIES,
} from "./policy.js";
export type { CfnTemplate } from "./template.js";
export { type AnalyzeOptions, analyzeFunction, analyzeTemplate };

/** cdk.out の template JSON ファイルを読んで解析する（YAML/SAM template は非対応 — synth 済み JSON を渡す）。 */
export async function analyzeTemplateFile(path: string): Promise<DoctorReport> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(
        `${path} is not valid JSON — --template expects a cdk.out CloudFormation template ` +
          "(JSON). YAML/SAM templates are not supported; run `cdk synth` / `sam build` first.",
      );
    }
    throw error;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} is not a CloudFormation template (expected a JSON object)`);
  }
  return analyzeTemplate(parsed as CfnTemplate);
}

const MARK: Record<string, string> = { pass: "PASS", warn: "WARN", fail: "FAIL" };

/** CLI が出す人間向けの report 文面。 */
export function formatFunctionReport(report: FunctionReport): string {
  const lines = [`${report.name}`];
  for (const check of report.checks) {
    lines.push(`  ${MARK[check.status]} ${check.id.padEnd(14)} ${check.message}`);
  }
  return lines.join("\n");
}

export function formatDoctorReport(report: DoctorReport): string {
  const parts = report.functions.map(formatFunctionReport);
  if (report.notes.length > 0) {
    parts.push(`notes:\n${report.notes.map((n) => `  - ${n}`).join("\n")}`);
  }
  return `${parts.join("\n\n")}\n`;
}
