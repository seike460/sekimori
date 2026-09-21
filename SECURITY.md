# Security policy

## Reporting a vulnerability

Report suspected vulnerabilities via GitHub's private vulnerability reporting
("Report a vulnerability" on the Security tab). Do not open a public issue for
security reports.

## Scope

- `sekimori` writes trace context into outbound AWS messages and reads it back.
  Carrier values are treated as untrusted input and validated at the boundary
  (`asRecord` narrowing, `SekimoriError` on malformed context).
- `sekimori doctor` reads Lambda/IAM/CloudFormation configuration with read-only
  AWS SDK calls; every request carries `AbortSignal.timeout` (see
  `probe/cdk/config.ts` and `packages/doctor/src/live.ts`).
- No credentials are committed. AWS access relies on the standard SDK credential
  chain; the release workflow publishes to npm over OIDC (`id-token`), so no npm
  token is stored.

## Supported versions

Pre-release (`v0.x`): only the latest commit on `main` receives fixes.
