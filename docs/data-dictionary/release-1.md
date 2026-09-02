# Release 1 canonical data dictionary

## Purpose and authority

This dictionary describes the PostgreSQL schema after migrations `0001` through
`0011`. PostgreSQL constraints and the approved synchronization contracts remain
the executable authority for field types and accepted values. The companion
[`release-1.json`](release-1.json) catalog is checked against every `CREATE
TABLE` statement and the migration ledger table during tests, so undocumented
tables fail the repository gate.

The database contains normalized canonical and operational rows. It does not
store an accepted synchronization request as raw clinical JSON. Browser clients
never connect directly to PostgreSQL.

## Classification and exposure

| Value | Meaning |
| --- | --- |
| `METADATA` | Migration or schema-control metadata without patient content. |
| `OPERATIONAL` | Deployment, synchronization, or support state. |
| `IDENTITY` | Patient, practitioner, source-link, or matching information. |
| `CLINICAL` | Accepted screening, vitals, or finalized Lifestyle information. |
| `SECURITY` | Credentials, grants, recovery state, or security principals. |
| `AUDIT` | Immutable decision or access evidence. |
| `CANONICAL_PATIENT` | A bounded authorized API may expose selected normalized fields. |
| `MASKED_SUPPORT` | Only minimum-necessary scoped support metadata may be exposed. |
| `NONE` | No Release 1 browser response reads the table directly. |

`CANONICAL_PATIENT` does not mean every column is returned. Source IDs, hashes,
internal UUIDs, credential material, review evidence, and raw errors remain
server-side unless a route explicitly defines a narrower safe representation.

## Migration and platform domain

| Table | Purpose | Classification | Viewer boundary |
| --- | --- | --- | --- |
| `schema_migrations` | Immutable migration checksum ledger. | `METADATA` | `NONE` |
| `organizations` | Screening program or organization identity. | `OPERATIONAL` | `CANONICAL_PATIENT` |
| `locations` | Canonical screening location. | `OPERATIONAL` | `CANONICAL_PATIENT` |
| `desktop_installations` | Registered desktop deployment and lifecycle. | `SECURITY` | `MASKED_SUPPORT` |
| `desktop_installation_credentials` | Hashed credential lifecycle; no plaintext token. | `SECURITY` | `NONE` |
| `location_source_links` | Local-to-canonical location mapping. | `OPERATIONAL` | `MASKED_SUPPORT` |
| `practitioners` | Canonical screening practitioner attribution. | `IDENTITY` | `CANONICAL_PATIENT` |
| `practitioner_source_links` | Local-to-canonical practitioner mapping. | `IDENTITY` | `NONE` |
| `practitioner_roles` | Practitioner role in screening context. | `OPERATIONAL` | `CANONICAL_PATIENT` |
| `screening_protocols` | Versioned screening protocol. | `OPERATIONAL` | `CANONICAL_PATIENT` |
| `protocol_source_links` | Local-to-canonical protocol mapping. | `OPERATIONAL` | `NONE` |

## Operations and identity domain

| Table | Purpose | Classification | Viewer boundary |
| --- | --- | --- | --- |
| `operations_users` | Enrolled OIDC operations principal. | `SECURITY` | `NONE` |
| `operations_access_grants` | Permission and organization-scope grants. | `SECURITY` | `NONE` |
| `persons` | Canonical patient demographics and lifecycle. | `IDENTITY` | `CANONICAL_PATIENT` |
| `person_identifiers` | Typed identifiers, including the CHS medical ID. | `IDENTITY` | `CANONICAL_PATIENT` |
| `patient_source_links` | Local patient to canonical person mapping. | `IDENTITY` | `MASKED_SUPPORT` |
| `identity_review_cases` | Possible-duplicate review lifecycle. | `IDENTITY` | `MASKED_SUPPORT` |
| `identity_review_candidates` | Bounded candidate references and match categories. | `IDENTITY` | `MASKED_SUPPORT` |
| `identity_review_evidence_snapshots` | Minimum-necessary immutable review evidence. | `IDENTITY` | `MASKED_SUPPORT` |
| `identity_review_resolutions` | Immutable reviewed identity decision. | `AUDIT` | `MASKED_SUPPORT` |
| `identity_resolution_deliveries` | Replay-safe delivery of identity decisions to desktops. | `IDENTITY` | `NONE` |
| `medical_id_recovery_cases` | Expiring audited ID-verification state. | `SECURITY` | `NONE` |
| `medical_id_recovery_candidates` | Opaque candidates for an active recovery case. | `IDENTITY` | `NONE` |

## Clinical domain

| Table | Purpose | Classification | Viewer boundary |
| --- | --- | --- | --- |
| `screening_sessions` | Location/day session with protocol provenance. | `CLINICAL` | `CANONICAL_PATIENT` |
| `screening_encounters` | Patient encounter, lifecycle, and attribution. | `CLINICAL` | `CANONICAL_PATIENT` |
| `screening_vital_sets` | One vitals aggregate per encounter. | `CLINICAL` | `CANONICAL_PATIENT` |
| `vital_readings` | Individual ordered BP and pulse measurements. | `CLINICAL` | `CANONICAL_PATIENT` |
| `lifestyle_assessments` | Finalized seven-day assessment and baseline references. | `CLINICAL` | `CANONICAL_PATIENT` |
| `lifestyle_alcohol_baselines` | Versioned alcohol baseline. | `CLINICAL` | `CANONICAL_PATIENT` |
| `lifestyle_alcohol_baseline_beverages` | Alcohol-baseline beverage details. | `CLINICAL` | `CANONICAL_PATIENT` |
| `lifestyle_alcohol_weekly` | Weekly alcohol response. | `CLINICAL` | `CANONICAL_PATIENT` |
| `lifestyle_alcohol_weekly_beverages` | Weekly alcohol beverage details. | `CLINICAL` | `CANONICAL_PATIENT` |
| `lifestyle_tobacco_baselines` | Versioned tobacco baseline. | `CLINICAL` | `CANONICAL_PATIENT` |
| `lifestyle_tobacco_products` | Tobacco product vocabulary. | `CLINICAL` | `CANONICAL_PATIENT` |
| `lifestyle_tobacco_baseline_products` | Baseline tobacco product quantities. | `CLINICAL` | `CANONICAL_PATIENT` |
| `lifestyle_tobacco_weekly` | Weekly tobacco response and products. | `CLINICAL` | `CANONICAL_PATIENT` |
| `lifestyle_work_baselines` | Versioned work baseline. | `CLINICAL` | `CANONICAL_PATIENT` |
| `lifestyle_work_weekly` | Weekly work response. | `CLINICAL` | `CANONICAL_PATIENT` |
| `lifestyle_physical_activities` | Physical-activity vocabulary. | `CLINICAL` | `CANONICAL_PATIENT` |
| `lifestyle_physical_activity_weekly` | Weekly physical-activity entries. | `CLINICAL` | `CANONICAL_PATIENT` |
| `lifestyle_other_activities` | Other-activity vocabulary. | `CLINICAL` | `CANONICAL_PATIENT` |
| `lifestyle_other_activity_weekly` | Weekly other-activity entries. | `CLINICAL` | `CANONICAL_PATIENT` |

Lifestyle baselines are immutable versions. Each finalized assessment retains
the exact baseline IDs and versions it used; later baseline versions do not
rewrite historical weekly responses.

## Synchronization and audit domain

| Table | Purpose | Classification | Viewer boundary |
| --- | --- | --- | --- |
| `sync_batches` | Batch envelope, hash, state, counts, and stored response. | `OPERATIONAL` | `MASKED_SUPPORT` |
| `sync_batch_actors` | Batch actor to practitioner resolution. | `IDENTITY` | `NONE` |
| `sync_records` | Per-record idempotency, safe outcome, and canonical links. | `OPERATIONAL` | `MASKED_SUPPORT` |
| `audit_events` | Append-only operations and access evidence. | `AUDIT` | `NONE` |

Synchronization tables retain hashes and safe error metadata for replay and
support, not raw request payloads. Operations monitoring returns grouped counts
and bounded stable codes; it never returns patient clinical content from these
tables.

## Cross-cutting invariants

- Server UUIDs identify canonical rows; desktop-local IDs remain scoped source
  links and are not public identifiers.
- Active CHS medical IDs are unique and non-semantic.
- Accepted writes, source links, audit evidence, and stored acknowledgments are
  transactionally consistent.
- Completed clinical history is not destructively overwritten; revisions and
  explicit lifecycle rows preserve provenance.
- All timestamps are stored with explicit temporal meaning; central receipt and
  desktop source times remain distinct.
- Access is enforced by the API using active users, permissions, organization
  scope, reason/purpose, and audit—not by browser knowledge of table names.
