# Release 1 candidate notes

Status: PC pilot deployment is running. Combined automated acceptance is
implemented; physical two-PC acceptance and the desktop 1.0.2 installer approval
remain open. See [HSW-019F](../sync/HSW-019F-pilot-acceptance.md).

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
  evidence for the patient viewer, Medical ID recovery, synchronization
  monitoring, and identity-review resolution.
- Liveness, startup, readiness, version, Prometheus metrics, structured logging,
  redaction tests, bounded runtime limits, graceful shutdown, security scans,
  load evidence, backup/restore rehearsal, and sync recovery evidence.
- Canonical data dictionary, API guide, backup/restore runbook, and
  synchronization incident/replay/recovery runbook.
- Food/OTC, referrals and follow-ups, immutable addenda/review histories and
  bounded all-domain central history retrieval, with a read-only desktop cache.
- Isolated Docker Compose deployment, private PostgreSQL, Keycloak, HTTPS
  hostnames and a dedicated Cloudflare tunnel.
- Portal staff/admin/super admin management, desktop enrollment and credential
  lifecycle controls, and hospital/provider approval with patient-specific sharing.
- Optional private, PostgreSQL-backed HAPI FHIR R4 publication with a durable
  retry queue, stable registry and authorized provider retrieval.

## Compatibility baseline

- Node.js 24 LTS and pnpm 11.
- Fastify 5 and React 19.
- PostgreSQL 18 with immutable migrations `0001` through `0020`.
- HSD-SYNC-001 batch contract and HSD-SYNC-005B finalized Lifestyle contract.
- The API and static operations web remain a modular monolith. Keycloak and
  the optional FHIR server/database/publication worker are separate deployment
  services; operational PostgreSQL remains authoritative.

## Excluded from this candidate

- Document ingestion/extraction, a dedicated doctor document portal, and
  LLM-assisted analysis.
- Partner-specific/national FHIR profiles and SMART-on-FHIR launch support.
- Prometheus, Grafana, Fluent Bit, OpenSearch, Kubernetes/EKS, ingress, managed
  identity, and cloud infrastructure deployment.
- Automatic identity merging, replacement Medical IDs, browser retry buttons,
  or direct database repair workflows.

## Gates before a production pilot

1. Complete the physical two-PC cross-repository demonstration with the new
   verified installer: offline capture, restart durability, reconnect, sync,
   acknowledgment/CHS-ID persistence, history/cache viewing, late follow-up,
   exact replay and credential revocation. The automated suites cover these
   service boundaries; they do not replace device acceptance.
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
