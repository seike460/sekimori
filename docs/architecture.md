# Architecture

Module map — what lives where and why. Keep this in sync when files move.

Extension points are localized by design: a new carrier service is one
`*-inject.ts` / `*-consume.ts` pair plus a `record.ts` union entry, a new doctor
check is one `FUNCTION_CHECKS` entry in `checks.ts`, a new codemod mapping is one
row in `transform-tables.ts`, a new CLI command is one `COMMANDS` entry, and
probe timing/resource knobs are `SEKIMORI_PROBE_*` env vars in `probe/cdk/config.ts`.

## `packages/sekimori` — runtime library

Carrier propagation for AWS messaging. Every service has the same two halves —
SQS/SNS/SFN split them into `*-inject.ts` / `*-consume.ts` files, while
EventBridge/Kinesis/DynamoDB/API Gateway keep both in a single file:

- `*-inject.ts` — write the active span context into an outbound message
  (SQS/SNS message attributes, EventBridge `detail`, Step Functions `_trace` field,
  Kinesis `Data`, DynamoDB item attributes). Each inject path also decides whether
  to write the AWS-native `x-amzn-trace-id` header (`xrayHeader` option).
- `*-consume.ts` — `extractFrom*` reads the carrier back, `with*` opens a
  CONSUMER span per record.

Shared machinery lives in `carriers.ts` (pin/conflict rules, `consumerSpanPlan`,
`asRecord`, baggage merge), `object-carrier.ts` (JSON-object carrier merge +
`CarrierStash` for baggage-only preemption), `span.ts` (`withConsumerSpan`),
`span-capture.ts` (`captureMethod` — span lifecycle for wrapped methods),
`xray-header.ts` (`X-Amzn-Trace-Id` parse/format), `errors.ts` (input validation),
`semconv.ts` (attribute name constants), `types.ts` (option/result shapes).
`sns.ts` / `sqs.ts` / `sfn.ts` are barrels that keep the original subpath exports.

Carrier precedence rules (pin, stale-slot scrub, split-brain prevention) are
documented inline at each merge site — the comments are the spec.

## `packages/doctor` — readiness checks

- `template.ts` — orchestrates a CloudFormation/SAM template analysis into
  `FunctionFacts` per function.
- `cfn.ts` — JSON/intrinsic helpers (`asObject`, `Ref`/`Fn::` resolution).
- `sam-globals.ts` — SAM `Globals` merge into function properties.
- `template-policy.ts` — IAM policies declared inside the template.
- `live.ts` — live function analysis via AWS SDK (Lambda config + IAM policy
  evaluation); every SDK call carries `AbortSignal.timeout`.
- `policy.ts` — pure IAM policy document evaluation (`xray:PutTraceSegments`).
- `checks.ts` — the six checks as a declarative list (`FUNCTION_CHECKS`) over
  `FunctionFacts`; unresolvable values degrade to `warn`, never to wrong answers.

## `packages/codemod` — `sekimori migrate`

- `index.ts` — file collection, `migrateFile`/`migratePaths`/`formatReport`.
- `gitignore.ts` — ignore-rule evaluation (deepest `.gitignore` first).
- `git-config.ts` — `[core] excludesFile` parsing and `.git` file →
  `gitdir`/`commondir` resolution.
- `transform.ts` — `transformSource`: the ts-morph rewrite passes.
- `transform-imports.ts` — import specifier rewriting.
- `transform-module-refs.ts` — `require`/dynamic-import/`jest.mock` scanning and
  leftover-reference reporting.
- `transform-receiver.ts` / `transform-segments.ts` / `transform-ctx.ts` —
  receiver unwrapping, segment lifecycle rewrites, `captureAsyncFunc` context.
- `transform-tables.ts` — the construct mapping table (extension point: new
  mappings go here).

## `packages/cli` — `sekimori` binary

`bin.ts` is the entry shim; `index.ts` dispatches via a command registry;
`commands/` holds `migrate` and `doctor`; `args.ts`/`usage.ts` are flag parsing
and help text.

## `probe/` — end-to-end proof

`probe/cdk` deploys emitter → EventBridge → SQS → consumer and asserts the link.
`config.ts` holds every tunable as env vars (`SEKIMORI_PROBE_*`), `assert.ts`
writes timestamped evidence to `docs/evidence/` and prunes old runs
(`SEKIMORI_PROBE_EVIDENCE_KEEP`), `transaction-search.ts` queries `aws/spans`
(Transaction Search), `xray-doc.ts`/`xray-fallback.ts` provide the X-Ray second
opinion.
