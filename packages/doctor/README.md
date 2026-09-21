# @sekimori/doctor

`sekimori doctor` — a read-only OpenTelemetry readiness report for a Lambda function or a `cdk.out`
CloudFormation template.

## Checks per function

| id | pass | warn | fail |
|---|---|---|---|
| `tracing` | `TracingConfig.Mode=Active` | unset | `PassThrough` |
| `adot-layer` | `AWSOpenTelemetryDistroJs` ≥ the known-good version | older version | missing |
| `exec-wrapper` | `AWS_LAMBDA_EXEC_WRAPPER=/opt/otel-instrument` | other / unset | — |
| `service-name` | `OTEL_SERVICE_NAME` set | unset | — |
| `propagators` | unset (ADOT default) or covers `tracecontext`+`xray`+`baggage` | missing a propagator | — |
| `xray-iam` | role allows `xray:PutTraceSegments` | role not resolvable | resolved role without write |

Plus notes on SQS event-source mappings, Transaction Search configuration, and bundled X-Ray SDK detection.

## Usage

```bash
sekimori doctor --template cdk.out/App.template.json
sekimori doctor --function my-function   # GetFunctionConfiguration + IAM lookups (read-only)
sekimori doctor --template … --json
```

Programmatic: `analyzeTemplate(template)` / `analyzeTemplateFile(path)` / `analyzeFunction(name)`.
Exit code is `1` when any function has a `fail` check, so CI can gate on it.
