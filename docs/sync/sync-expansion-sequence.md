# PostgreSQL synchronization expansion sequence

FHIR remains deferred until the desktop-to-PostgreSQL data flow is complete and
verified. Each increment follows branch, local verification, review, and merge.

| Increment | Deliverable | Dependency / acceptance |
| --- | --- | --- |
| HSW-019A | Finalized Food and OTC uploads, normalized PostgreSQL persistence and historical backfill | Implemented on review branches; verify PostgreSQL server and Windows |
| HSW-019B | Referral snapshots, append-only status/follow-up histories, treatment actions and medication changes | Implemented on review branches; verify PostgreSQL server, Windows backfill, late follow-up and exact replay |
| HSW-019C | Immutable addenda and review-flag lifecycle history | [Implemented on coordinated review branches](HSW-019C-encounter-history.md); verify server ingestion, Windows backfill, late closure, exact replay and void retention |
| HSW-019D | Protected, bounded central patient-history retrieval including all synchronized domains | [Implemented on a review branch](HSW-019D-patient-history-retrieval.md): all-domain, identity-bound installation retrieval and remaining browser domains; verify PostgreSQL, denied access, cursor replay and Windows viewer |
| HSW-019E | Desktop read-only history cache, retrieval interface and origin labels | Separate imported data from local clinical tables/outbox; show last refresh and support pagination/restart |
| HSW-019F | Combined acceptance, operational status and rollout | Two installations, offline capture/restart, reconnect, late follow-up, exact replay, identity review, cache refresh, denied/revoked access |

## Ownership and history rules

Source installations remain authoritative for their own authored records. A
history download must never become an upload of a new locally authored encounter.
Each cached item retains its central reference, source location/installation,
clinical author, occurrence time, version, and last-retrieved time. Completed
content is read-only; local additions use explicit locally authored records.

Patient matching must use the existing confirmed identity-resolution boundary.
Possession of a Medical ID alone does not authorize history retrieval. Initial
sharing should use server-derived organization scope. Cross-organization data
requires explicit server-side sharing grants; the browser or desktop cannot
supply its own scope. Retrieval is patient-specific and reason-gated, with audited
access and bounded stable pagination. Patient identifiers stay out of URLs/logs.

Void and amended source state must propagate to the history representation.
Cached data must display that state and its retrieval age; refreshing cache must
not alter local drafts or erase local authorship. Test conflicting identities,
stale cursors, interrupted pages, duplicate pages, and credential revocation.

The API upgrade precedes the desktop upgrade for additive upload contracts.
Production pilot readiness also includes the existing staging, dependency
security, identity, backup/restore and cross-repository acceptance gates.
