# Governance

How decisions get made in sekimori, who makes them, and how that group can grow. Written down early, the same way
minamo did, because a single-maintainer project should say so plainly.

## 1. Current state

- **Sole maintainer:** [@seike460](https://github.com/seike460). Bus factor is **1**.
- **No SLA.** Fixes, reviews and releases are best-effort. Forking is a legitimate outcome, not a failure state.
- **Scope is fixed by design.** sekimori is a thin toolkit for *boundaries*, *proof* and *migration*. It is not a tracer,
  not a collector, not a backend. "Upstream should own this" is a valid and common answer — and when upstream does,
  we contribute and shrink.

## 2. Decision-making

- Design decisions live in `docs/concept.md` as `DEC-NNN` entries: trigger, decision, rationale, rejected alternatives,
  and the verified facts they rest on (`Fact:` / `Assumption:` blocks).
- Boundary support is recorded in `BOUNDARIES.md` with the author and date of each recipe.
- Proposal flow: issue (the problem, not just a patch) → agreement on scope → DEC if the public surface changes →
  PR with CI green and the boundary contract tests passing in **both** propagator modes.

## 3. Roles

| Role | Can | How |
|---|---|---|
| Contributor | issues, boundary reports, PRs | just contribute |
| Committer | triage, review, merge in-scope CI-green changes | track record of in-scope PRs and useful reviews |
| Co-maintainer | co-author DECs, scope calls, release authority | invited after sustained committer work; resolves bus factor 1 |

## 4. Upstream first

Code under `packages/sekimori/src` that mirrors an OpenTelemetry contrib `ServiceExtension` is written so it can be
proposed upstream as-is. When a boundary is absorbed upstream, sekimori removes or thins its own implementation and
points to the upstream one. That is the plan working, not the plan failing.
