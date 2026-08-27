# HSD-HARD-001B: Automated security and supply-chain gates

Status: Implemented

## Purpose

This increment adds repeatable Release 1 security checks to pull requests,
`main`, and a weekly schedule. It is the second HSW-017 / R1-019 hardening
increment and changes no clinical, synchronization, authorization, or database
behavior.

The controls are intentionally small-team maintainable. They use the existing
locked pnpm dependency graph, GitHub-native analysis, and one deterministic
repository scanner rather than adding a separate hosted security service.

## Enforced controls

| Control | Enforcement | Failure threshold |
| --- | --- | --- |
| Locked production dependency audit | `pnpm audit` locally and in GitHub Actions | Known high or critical advisory |
| Static code and workflow analysis | CodeQL for JavaScript/TypeScript and GitHub Actions | Code-scanning policy configured in GitHub |
| Repository credential scan | Local Node script and GitHub Actions | High-confidence committed credential or private-key format |
| Dependency update discovery | Dependabot | Weekly npm and GitHub Actions pull requests |

The credential scanner reads Git-tracked and unignored workspace files, skips
symlinks, binary files, and files larger than 5 MiB, and reports only path, line,
and rule ID. It never prints the matched value. Its rules intentionally target
high-confidence formats such as private-key headers and well-known GitHub, AWS,
Google, npm, Slack, and Stripe live-token shapes. Generic words such as
`password` and synthetic local examples are not findings because they would
create an unsafe false-positive culture.

## Workflow safety

- Workflows receive read-only repository permission by default.
- CodeQL alone receives the `security-events: write` permission needed to upload
  results.
- Checkout does not persist a GitHub credential after source retrieval.
- Workflow jobs have explicit time limits and do not receive application,
  database, OIDC, desktop, or patient-data secrets.
- Production and development dependency updates are grouped separately;
  GitHub Actions updates use their own group and schedule.

## Local evidence

Run all locally reproducible security checks:

```bash
pnpm security:check
```

The command executes scanner tests, scans tracked and unignored workspace files,
and asks the configured package registry for high-or-critical production
advisories. Because the advisory database is network-backed, a network or
registry failure is a failed check rather than a clean result.

Continue to run the complete repository gates:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
pnpm db:test
```

## Response procedure

1. Do not merge a failed security check merely by rerunning it.
2. Confirm the affected file, package, advisory, or query in the job output.
3. Rotate and revoke any exposed live credential outside GitHub before removing
   it from the repository and history.
4. Upgrade, replace, or explicitly document an unavailable dependency fix in a
   separate reviewed change. This increment provides no blanket ignore list.
5. Re-run every security and repository gate after remediation.

## Scope boundary

This increment does not provide full historical secret scanning, GitHub
Dependency Review (the repository Dependency Graph is not enabled), dynamic
application testing, container-image scanning, penetration testing, production
branch-protection configuration, backup/restore rehearsal, or performance/load
evidence. Those remain later HSW-017 / R1-019 and R1-020 hardening tasks.
