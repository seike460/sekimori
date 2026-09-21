# @sekimori/cli

## 0.1.0

### Minor Changes

- [#1](https://github.com/seike460/sekimori/pull/1) [`0cafea5`](https://github.com/seike460/sekimori/commit/0cafea50f91a1b77b092e5f8ba91e8220ca88ae3) Thanks [@seike460](https://github.com/seike460)! - Fill in every boundary the design promised: SNS (Publish/PublishBatch inject, direct-invoke extract), Step Functions (`traceHeader` + `input._trace`), API Gateway HTTP API (SERVER span parented on the client), DynamoDB Streams and Kinesis (experimental opt-in carriers), the EventBridge→SQS `detail` fallback (`source: "body-detail"`, resolving OQ-1), a Powertools `Tracer`-compatible shim at `sekimori/tracer`, the `sekimori migrate` codemod (`aws-xray-sdk-core` / Powertools → OTel API with a manual-work report), `sekimori doctor` (cdk.out template + live function readiness), and an X-Ray `BatchGetTraces` fallback for the probe assert when Transaction Search is off.

### Patch Changes

- Updated dependencies [[`0cafea5`](https://github.com/seike460/sekimori/commit/0cafea50f91a1b77b092e5f8ba91e8220ca88ae3)]:
  - @sekimori/codemod@0.1.0
  - @sekimori/doctor@0.1.0
