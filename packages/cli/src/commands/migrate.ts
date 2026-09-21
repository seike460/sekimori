/** `sekimori migrate` — codemod を実行し report 整形と exit code を担当する。 */
import { formatReport, type MigrationResult, migratePaths } from "@sekimori/codemod";
import { failWith, tryParse } from "../args.js";
import { MIGRATE_USAGE } from "../usage.js";

export async function runMigrate(args: string[]): Promise<number> {
  const outcome = tryParse(args, {
    write: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    "tracer-name": { type: "string" },
    help: { type: "boolean", default: false, short: "h" },
  });
  if (!outcome.ok) {
    process.stderr.write(`sekimori migrate: ${outcome.message}\n\n${MIGRATE_USAGE}\n`);
    return 2;
  }
  const { positionals, values } = outcome.parsed;
  if (values.help) {
    process.stdout.write(`${MIGRATE_USAGE}\n`);
    return 0;
  }
  if (positionals.length === 0) {
    process.stderr.write("sekimori migrate: no paths given\n");
    return 2;
  }
  // `--tracer-name ""` は `getTracer("")` を生成する — 空文字列は未指定扱いにする。
  const tracerName = values["tracer-name"] === "" ? undefined : values["tracer-name"];
  let result: MigrationResult;
  try {
    result = await migratePaths(positionals, {
      write: values.write,
      ...(tracerName !== undefined ? { tracerName } : {}),
    });
  } catch (error) {
    // 存在しない path の ENOENT 等 — raw stack ではなく CLI エラーとして返す。
    return failWith(error instanceof Error ? error.message : String(error), "sekimori migrate");
  }
  if (values.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(formatReport(result));
    if (!values.write && result.files.some((f) => f.changed)) {
      process.stdout.write("\nDry-run. Re-run with --write to apply.\n");
    }
  }
  const manual = result.findings.filter((f) => f.kind === "manual");
  return manual.length > 0 ? 1 : 0;
}
