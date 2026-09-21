# sekimori

sekimori (関守) — carries OpenTelemetry trace context through every gate of your TypeScript
Lambda: EventBridge, SQS, SNS, Step Functions, API Gateway, DynamoDB Streams, Kinesis.

The ADOT Lambda layer already links producer → consumer over the X-Ray header. sekimori adds
what the layer structurally cannot: a W3C carrier where the native header is dropped, and one
CONSUMER span per record linked to the producer.

## Install

```bash
pnpm add sekimori @opentelemetry/api
```

## Usage

```ts
import { injectEventBridgeEntry, withSqsRecord } from "sekimori";

// producer — both TraceHeader (native) and the W3C carrier (detail) are written
await events.send(new PutEventsCommand({
  Entries: [injectEventBridgeEntry({ Source: "app", DetailType: "order", Detail })],
}));

// consumer — one `process <queue>` span per record, linked to the producer
for (const record of event.Records) {
  await withSqsRecord(record, async () => handle(record));
}
```

Full documentation, boundary table, migration tooling (`sekimori migrate`), readiness checks
(`sekimori doctor`) and the real-AWS probe: <https://github.com/seike460/sekimori>
