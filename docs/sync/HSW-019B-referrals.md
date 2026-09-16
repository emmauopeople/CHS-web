# HSW-019B referral synchronization

## Scope

This increment carries the desktop referral workflow into canonical PostgreSQL
without changing the clinical workflow. It synchronizes three records:

- `REFERRAL` is the current versioned referral snapshot;
- `REFERRAL_STATUS` is one immutable ordered status event;
- `REFERRAL_FOLLOWUP` is one immutable follow-up with normalized treatment
  actions and medication changes.

The desktop migration queues existing referral data for backfill. New status
changes and follow-ups queue their own history signals in the same local
transaction as the clinical write.

## Provenance and replay

Every record identifies the local author and capture time for that revision or
event. The batch actor catalog resolves those source actors to canonical
practitioners. A missing author fails closed instead of substituting the
encounter recorder.

Referral snapshots use their source revision. Status events and follow-ups are
immutable revision `1` records. Desktop record IDs are deterministic for the
installation, resource, local ID, and revision, so backfill and repeated signals
produce the same delivery identity. PostgreSQL also hashes both the delivery
record and clinical content to reject changed replay content.

Late follow-ups retain their contact date, recording time, author, source,
treatment actions, and medication details. They can arrive after the original
screening batch. A child delivered before its referral returns a retryable
dependency outcome and is retried after the parent is available.

## Storage boundaries

Migration `0014_referral_ingestion.sql` adds normalized referral snapshot,
status event, follow-up, treatment action, and medication change tables. Status
events and follow-up trees reject updates and deletes. The synchronization
ledger stores hashes, outcomes, and canonical links; it does not retain the raw
clinical request payload.

Patient-history display remains outside this increment. The new referral tables
have no browser exposure until the bounded history retrieval increment defines
its authorization and response contract.

## Deployment and validation

Deploy the CHS-web migration and API contract before upgrading desktops. An old
server does not recognize the three new resource types.

Repository tests cover contract rejection, actor provenance, deterministic
backfill, histories spanning multiple batches, dependency retry, exact replay,
immutable PostgreSQL history, transaction rollback, installation isolation, and
voided encounter history. PostgreSQL 18 and Windows desktop verification remain
required before merge.

## Remaining work

Encounter addenda and review flags, bounded patient-history retrieval, desktop
history caching, and combined rollout acceptance are tracked in HSW-019C through
HSW-019F. FHIR remains deferred until those data flows are complete.
