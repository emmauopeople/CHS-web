# Release 1 candidate notes

Status: Application candidate; cloud deployment and desktop acceptance remain
gated.

## Delivered application scope

- Authenticated, bounded, replay-safe desktop batch intake with durable
  per-record outcomes and stored-response recovery.
- Canonical PostgreSQL persistence for patient identity, screening sessions and
  encounters, individual vitals, and finalized Lifestyle assessments.
- One active non-semantic CHS medical ID per canonical patient, possible-
  duplicate review, audited resolution delivery, and controlled ID recovery.
- OIDC-protected operations workflows for canonical patient viewing, Medical ID
  recovery, identity review, and bounded synchronization monitoring.
- Responsive low-bandwidth React operations UI with browser-level workflow
  evidence.
- Liveness, startup, readiness, version, Prometheus metrics, structured logging,
  redaction tests, bounded runtime limits, graceful shutdown, security scans,
  load evidence, backup/restore rehearsal, and sync recovery evidence.
- Canonical data dictionary, API guide, backup/restore runbook, and
  synchronization incident/replay/recovery runbook.

## Compatibility baseline

- Node.js 24 LTS and pnpm 11.
- Fastify 5 and React 19.
- PostgreSQL 18 with immutable migrations `0001` through `0011`.
- HSD-SYNC-001 batch contract and HSD-SYNC-005B finalized Lifestyle contract.
- Two deployable applications—API and static operations web—and one operational
  PostgreSQL database. Release 1 remains a modular monolith.

## Excluded from this candidate

- Food, OTC medicine, referral, and document ingestion until their desktop
  contracts are frozen.
- FHIR server/mapping, hospital onboarding, provider access, document pipeline,
  and LLM-assisted analysis.
- Prometheus, Grafana, Fluent Bit, OpenSearch, Kubernetes/EKS, ingress, managed
  identity, and cloud infrastructure deployment.
- Automatic identity merging, replacement Medical IDs, browser retry buttons,
  or direct database repair workflows.

## Gates before a production pilot

1. Complete the desktop sync worker and run the cross-repository Release 1
   demonstration: offline capture, restart durability, reconnect, sync,
   acknowledgment/CHS-ID persistence, operations viewing, exact replay, and
   credential revocation.
2. Select the hosting region and data-residency model; complete legal, privacy,
   consent, retention, deletion, and incident-ownership decisions.
3. Deploy production-like staging with TLS, private PostgreSQL, managed secrets,
   approved OIDC, encrypted backups, point-in-time recovery, monitoring, and
   infrastructure as code.
4. Establish representative device, bandwidth, batch-size, and viewer-
   concurrency targets; rerun load and query-plan evidence against staging.
5. Approve RPO/RTO, backup retention, on-call ownership, alert thresholds,
   credential rotation, audit retention, and release rollback procedures.

This candidate is not authorization to process real patient data. Cloud-specific
controls and the full desktop-to-cloud acceptance gate remain mandatory before
go-live.
