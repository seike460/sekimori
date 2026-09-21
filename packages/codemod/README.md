# @sekimori/codemod

`sekimori migrate` — a ts-morph codemod that moves `aws-xray-sdk-core` and Powertools for AWS Lambda
(TypeScript) `Tracer` usage to the OpenTelemetry API, and emits a migration report listing constructs that have
no mechanical mapping.

## What it rewrites

- `import { Tracer } from "@aws-lambda-powertools/tracer"` → `createTracer` from `sekimori/tracer`;
  `new Tracer({ serviceName })` → `createTracer(serviceName)`
- `AWSXRay.captureAWS*` / `captureHTTPs*` → the wrapped value (contrib instrumentation takes over)
- `AWSXRay.getSegment()` / `resolveSegment()` → `trace.getActiveSpan()`
- `AWSXRay.captureAsyncFunc(name, fn)` / `captureFunc` → `tracer.startActiveSpan(name, fn)`, rewriting
  `subsegment.close()` → `end`, `addAnnotation` → `setAttribute`, `addError` → `recordException`,
  `addMetadata` → `metadata.*` attributes

Everything else — `setSegment`, `addNewSubsegment`, decorators, CJS `require`, aliased imports — is listed in
the report as `manual` findings, not silently broken.

## Usage

```bash
sekimori migrate src/           # dry-run report
sekimori migrate src/ --write   # rewrite in place
sekimori migrate src/ --json    # machine-readable report
```

Programmatic: `transformSource(source)` / `migrateFile(path, { write })` / `migratePaths(paths, { write })`.

Design: `docs/concept.md` DEC-003 in the [sekimori repository](https://github.com/seike460/sekimori).
