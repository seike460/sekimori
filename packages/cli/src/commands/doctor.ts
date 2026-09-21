/** `sekimori doctor` — template/live 解析を呼び出し report と exit code を返す。 */
import {
  analyzeFunction,
  analyzeTemplateFile,
  type DoctorReport,
  type FunctionReport,
  formatDoctorReport,
  formatFunctionReport,
} from "@sekimori/doctor";
import { failWith, tryParse } from "../args.js";
import { DOCTOR_USAGE } from "../usage.js";

/** `--template` / `--function` の排他・必須を解決する。どちらも無ければ usage error。 */
function resolveTarget(values: {
  template?: string | undefined;
  function?: string | undefined;
}):
  | { template: string; function?: undefined }
  | { function: string; template?: undefined }
  | undefined {
  const template = values.template === "" ? undefined : values.template;
  const functionName = values.function === "" ? undefined : values.function;
  if (template !== undefined && functionName !== undefined) {
    process.stderr.write("sekimori doctor: --template and --function are exclusive\n");
    return undefined;
  }
  if (template !== undefined) return { template };
  if (functionName !== undefined) return { function: functionName };
  process.stderr.write(
    "sekimori doctor: pass --template <cdk.out template> or --function <name>\n",
  );
  return undefined;
}

export async function runDoctor(args: string[]): Promise<number> {
  const outcome = tryParse(args, {
    template: { type: "string" },
    function: { type: "string" },
    json: { type: "boolean", default: false },
    help: { type: "boolean", default: false, short: "h" },
  });
  if (!outcome.ok) {
    process.stderr.write(`sekimori doctor: ${outcome.message}\n\n${DOCTOR_USAGE}\n`);
    return 2;
  }
  const { positionals, values } = outcome.parsed;
  if (values.help) {
    process.stdout.write(`${DOCTOR_USAGE}\n`);
    return 0;
  }
  // `doctor --template t.json stray` のような余剰 positional は silent に受理しない。
  if (positionals.length > 0) {
    process.stderr.write(`sekimori doctor: unexpected arguments: ${positionals.join(" ")}\n`);
    return 2;
  }
  const target = resolveTarget(values);
  if (target === undefined) return 2;

  if (target.template !== undefined) {
    let report: DoctorReport;
    try {
      report = await analyzeTemplateFile(target.template);
    } catch (error) {
      return failWith(error instanceof Error ? error.message : String(error), "sekimori doctor");
    }
    process.stdout.write(
      values.json ? `${JSON.stringify(report, null, 2)}\n` : formatDoctorReport(report),
    );
    const failed = report.functions.some((f) => f.checks.some((c) => c.status === "fail"));
    return failed ? 1 : 0;
  }

  let report: FunctionReport;
  try {
    report = await analyzeFunction(target.function);
  } catch (error) {
    // 存在しない関数 / 資格情報なし / ネットワーク失敗 — exit 1（check fail）と
    // 衝突しないよう usage error と同じ 2 に揃える。
    return failWith(error instanceof Error ? error.message : String(error), "sekimori doctor");
  }
  process.stdout.write(
    values.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatFunctionReport(report)}\n`,
  );
  return report.checks.some((c) => c.status === "fail") ? 1 : 0;
}
