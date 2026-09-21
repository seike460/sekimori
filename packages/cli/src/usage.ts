/** CLI の usage テキスト定数 — help 表示と parse エラー時の案内を一本化する。 */
export const USAGE = `sekimori (関守) — carries trace context through every gate of your TypeScript Lambda

Usage: sekimori <command> [options]

Commands:
  migrate <paths...>            Codemod: aws-xray-sdk-core / Powertools Tracer → OpenTelemetry API
      --write                   rewrite files in place (default: dry-run report)
      --json                    print the migration report as JSON
      --tracer-name <name>      tracer name for generated trace.getTracer(...) calls
  doctor --template <file>      readiness report for a cdk.out CloudFormation template (JSON)
  doctor --function <name>      readiness report for a live Lambda function (uses AWS creds)
      --json                    print the doctor report as JSON
  probe                         how to prove the trace link with the bundled probe stack

Library docs: https://github.com/seike460/sekimori
`;

export const PROBE_TEXT = `sekimori probe — proves the EventBridge → SQS → Lambda trace link on real AWS.

The probe lives in the sekimori repository and is not part of this package.
In a clone of https://github.com/seike460/sekimori:

  pnpm --filter @sekimori/probe run deploy   # deploys emitter → bus → SQS → consumer
  pnpm --filter @sekimori/probe run assert   # invokes the emitter and asserts the link

Results are written to docs/evidence/. Deploy incurs (minimal) AWS charges.
`;

export const MIGRATE_USAGE = `Usage: sekimori migrate <paths...> [--write] [--json] [--tracer-name <name>]`;
export const DOCTOR_USAGE = `Usage: sekimori doctor (--template <file> | --function <name>) [--json]`;
