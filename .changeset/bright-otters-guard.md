---
"sekimori": minor
"@sekimori/codemod": minor
"@sekimori/doctor": minor
"@sekimori/cli": minor
---

Fill in every boundary the design promised: SNS (Publish/PublishBatch inject, direct-invoke extract), Step Functions (`traceHeader` + `input._trace`), API Gateway HTTP API (SERVER span parented on the client), DynamoDB Streams and Kinesis (experimental opt-in carriers), the EventBridge→SQS `detail` fallback (`source: "body-detail"`, resolving OQ-1), a Powertools `Tracer`-compatible shim at `sekimori/tracer`, the `sekimori migrate` codemod (`aws-xray-sdk-core` / Powertools → OTel API with a manual-work report), `sekimori doctor` (cdk.out template + live function readiness), and an X-Ray `BatchGetTraces` fallback for the probe assert when Transaction Search is off.
