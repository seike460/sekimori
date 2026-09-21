# Contributing

```bash
pnpm install
pnpm build           # first: probe/ type-checks and bundles against packages/sekimori/dist
pnpm test            # unit + contract (two propagator modes)
pnpm type-check
pnpm lint
pnpm probe:synth     # CDK synth of the probe stack, no credentials needed
.claude/verify.sh    # full gate: install → build → type-check → biome ci → check-exports → probe:synth → test:coverage
```

- Node ≥ 22, pnpm 10. ESM, TypeScript strict, Biome for lint/format.

## Testing layers

- `pnpm test` — unit + contract tests (vitest). Carrier behavior is contract-tested
  against both a plain OTel SDK and the ADOT layer's propagator set; boundaries use
  temp dirs and injected fakes, never live AWS.
- `pnpm run test:coverage` — the same suite with v8 coverage (what CI runs).
- `pnpm probe:synth` — CDK synth of the probe stack, no credentials.
- `SEKIMORI_PROBE=1 pnpm run test:integration` — the optional end-to-end
  probe against a deployed stack (excluded from unit runs by default).

- Every public function needs: a unit test, a line in `BOUNDARIES.md` if it touches a boundary, and a `DEC` if it
  changes a design choice.
- Add a changeset (`pnpm changeset`) for anything user-visible.
- Never assert an end-of-support date for the X-Ray SDK. The verified fact is: maintenance mode since 2026-02-25,
  no published end date.
