# sekimori（関守）

**sekimori carries your trace context through every gate of your TypeScript Lambda — EventBridge, SQS, SNS, Step Functions — and walks it from the AWS X-Ray SDK to OpenTelemetry.**

> Lambda の trace を、関所（EventBridge / SQS / SNS / Step Functions…）を越えて一本に通す関守。
> X-Ray SDK から OpenTelemetry への引っ越しも、関守が見送る。

Status: **pre-release (v0.x)**. EventBridge, SQS, SNS, Step Functions and API Gateway are implemented and
contract-tested against both a plain OpenTelemetry SDK and the ADOT Lambda layer's propagator set.
DynamoDB Streams and Kinesis are implemented as experimental opt-in carriers. Boundary-by-boundary state is listed
honestly in [BOUNDARIES.md](./BOUNDARIES.md).

## What the ADOT layer already does — and what sekimori adds

If your producer calls AWS with an instrumented SDK client under the ADOT Lambda layer, **the X-Ray link already
works**: the layer injects the X-Ray header into every SDK call, EventBridge and SQS carry it, and the consumer's
invocation span links back. sekimori does not claim that.

sekimori adds the parts the layer structurally cannot:

| | |
|---|---|
| **W3C carrier where the native header is dropped** | `traceparent` in the EventBridge `detail`, in SQS message attributes, in the SNS envelope — so archive replays, API destinations and W3C-only consumers still find the producer span |
| **One span per record** | `withSqsRecord(record, fn)` opens a `process <queue>` CONSUMER span per record, parented on the invocation span and **linked** to the producer (semconv default). Without it, record-level links collapse onto the invocation span |
| **EventBridge extension** | `@opentelemetry/instrumentation-aws-sdk` has no EventBridge support today; `injectEventBridgeEntry` writes both `TraceHeader` and the W3C carrier |
| **Proof** (`probe/`) | a permanent emitter → EventBridge → SQS → consumer path that proves the link on real AWS and writes a connectivity report to `docs/evidence/` (`pnpm --filter @sekimori/probe run deploy && pnpm --filter @sekimori/probe run assert`) |
| **Migration** (`sekimori migrate`) | codemod from `aws-xray-sdk-core` / Powertools Tracer to the OpenTelemetry API — annotations become plain span attributes (OTel has no X-Ray annotation index); constructs without a mapping are listed in the report |
| **Readiness** (`sekimori doctor`) | read-only report for a cdk.out template or a live function: six checks (tracing mode, ADOT layer version, exec wrapper, service name, propagators, IAM) plus notes |

## Install

```bash
pnpm add sekimori @opentelemetry/api
```

`@opentelemetry/api` is a peer dependency. Under the ADOT Lambda layer nothing else is needed; the layer registers the
global tracer provider and propagators (`baggage,xray,tracecontext`).

If you override `OTEL_PROPAGATORS`, keep all three of `tracecontext`, `xray` and `baggage` — sekimori carries
`baggage` as a boundary channel and falls back to `AWSTraceHeader` only when no X-Ray propagator is registered.
`sekimori doctor` warns when a configured propagator list drops one.

## Ten lines

```ts
// producer
import { PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { injectEventBridgeEntry } from "sekimori/eventbridge";

await events.send(new PutEventsCommand({
  Entries: [injectEventBridgeEntry({ EventBusName, Source, DetailType, Detail })],
}));

// consumer (SQS behind an EventBridge rule)
import { withSqsRecord } from "sekimori/sqs";

export const handler = async (event: SQSEvent) => {
  for (const record of event.Records) await withSqsRecord(record, () => work(record));
};
```

Before: the worker trace has a link to the caller's trace, and one invocation span for the whole batch.
After: each record gets its own `process <queue>` span, linked to the exact producer span, with
`messaging.*` attributes and `sekimori.context.source` telling you which carrier delivered the context.

## API

| Function | Boundary | What it does |
|---|---|---|
| `injectEventBridgeEntry(entry, opts?)` | EventBridge | `TraceHeader` (X-Ray format) + `traceparent`/`tracestate`/`baggage` in `Detail` |
| `extractFromEventBridgeEvent(event)` | EventBridge | reads the W3C carrier from `detail` |
| `withEventBridgeEvent(event, fn, opts?)` | EventBridge | CONSUMER span, link to producer |
| `injectSqsMessage(input, opts?)` | SQS | W3C message attributes (≤10 enforced; the X-Ray field is dropped when a W3C carrier is present, kept under X-Ray-only propagators) + `AWSTraceHeader` when no X-Ray propagator is registered or `w3c: false` |
| `extractFromSqsRecord(record)` | SQS | messageAttributes → SNS envelope → envelope `Message` → `detail` → body → `AWSTraceHeader` (last — AWS transit `Parent` can dead-link) |
| `withSqsRecord(record, fn, opts?)` | SQS | `process <queue>` CONSUMER span per record, works with `ReportBatchItemFailures` |
| `linksFromSqsEvent(event)` | SQS | links for the whole batch |
| `injectSnsMessage` / `injectSnsPublishBatch` | SNS | W3C message attributes on `Publish` / `PublishBatch` (≤10 enforced for downstream SQS) |
| `extractFromSnsRecord` / `withSnsRecord` | SNS→Lambda | direct-invoke record → `process <topic>` CONSUMER span |
| `injectStartExecution` / `extractFromStateInput` / `withStepFunctionsTask` | Step Functions | native `traceHeader` + `input._trace` W3C carrier → task-level CONSUMER span |
| `extractFromHttpEvent` / `withHttpEvent` | API Gateway | reads `traceparent` from headers → SERVER span parented on the client |
| `injectDynamoDbItem` / `extractFromDynamoDbRecord` / `withDynamoDbRecord` | DynamoDB Streams | `_trace` item attribute (opt-in, experimental) |
| `injectKinesisPayload` / `injectKinesisRecord` / `withKinesisRecord` | Kinesis | payload envelope (opt-in, experimental; no KPL) |
| `withRecord(record, fn, opts?)` | any | dispatch by record shape (SQS / SNS / Kinesis / DynamoDB / EventBridge / API Gateway HTTP) |
| `createTracer` / `tracer` (`sekimori/tracer`) | — | Powertools `Tracer`-compatible shim over the OTel API (DEC-003) |
| `formatXrayTraceHeader` / `parseXrayTraceHeader` | — | W3C ↔ X-Ray header, byte-identical to `@opentelemetry/propagator-aws-xray` |

Option `parent: "producer"` makes the record span a child of the producer instead of a link (FIFO, single record).
On HTTP boundaries the default is the opposite: `withHttpEvent` parents on the client and
`parent: "invocation"` links it instead (DEC-007).

## CLI (`@sekimori/cli`)

```bash
sekimori migrate src/            # dry-run codemod report; --write applies, --json for machines
sekimori doctor --template cdk.out/App.template.json   # OTel readiness of every function
sekimori doctor --function my-fn                       # live function (read-only AWS calls)
sekimori probe                   # how to run the bundled link-proof stack
```

## Design decisions

Recorded in [docs/concept.md](./docs/concept.md) as `DEC-NNN` with the facts they rest on. Module map:
[docs/architecture.md](./docs/architecture.md). Boundary-by-boundary
capabilities and known gaps: [BOUNDARIES.md](./BOUNDARIES.md).

## Not claimed, on purpose

SQS/SNS propagation and `AWSTraceHeader` links exist upstream in OpenTelemetry JS contrib; EventBridge `detail`
injection exists in Datadog's tracer (vendor-specific). sekimori is the vendor-neutral, W3C-standard version of the
missing pieces, written in the shape of contrib's `ServiceExtension` so that it can be upstreamed. Absorption is the
goal, not the risk.

## License

MIT — single maintainer, no SLA. See [GOVERNANCE.md](./GOVERNANCE.md).
