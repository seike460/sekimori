# @sekimori/cli

The `sekimori` command line — migration, readiness checks, and the probe recipe for carrying
OpenTelemetry trace context across AWS Lambda boundaries.

```bash
sekimori migrate src/           # dry-run report: aws-xray-sdk-core / Powertools Tracer → OTel API
sekimori migrate src/ --write   # rewrite in place
sekimori migrate src/ --json    # machine-readable report

sekimori doctor --template cdk.out/App.template.json   # readiness report for a synthesized template
sekimori doctor --function my-fn                       # readiness report for a live Lambda (AWS creds)
sekimori doctor --template tpl.json --json

sekimori probe                  # how to prove the trace link with the bundled probe stack
```

## Commands

- `migrate` — the `@sekimori/codemod` transform over `.ts`/`.tsx` files. Exits `1` when the report
  contains `manual` findings (constructs with no mechanical mapping).
- `doctor` — the `@sekimori/doctor` analyzer. Exits `1` when any function has a `fail` check.
- `probe` — prints the deploy/assert recipe; the probe stack lives in the
  [sekimori repository](https://github.com/seike460/sekimori), not in this package.

Runtime library: [`sekimori`](https://www.npmjs.com/package/sekimori).
