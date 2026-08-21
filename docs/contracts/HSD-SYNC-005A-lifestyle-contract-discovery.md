# HSD-SYNC-005A: Lifestyle synchronization contract discovery

Status: Discovery frozen; machine contract implemented by HSD-SYNC-005B

Proposed resource type: `LIFESTYLE`

Proposed payload schema: `lifestyle.v1`

Inspected desktop baseline: `a862ffababe24e8159305c92687ebf6bb868ef2d`
(SQLite schema version 15)

## Purpose

This document freezes the implemented desktop Lifestyle semantics exposed by
the Release 1 web synchronization contract. It remains the discovery and
compatibility decision; HSD-SYNC-005B implements its machine-readable schema,
fixtures, and compatibility tests. Central persistence and ingestion remain
separate runtime work.

The inspected desktop application is the authority for local identifiers,
versioning, lifecycle, branching, and provenance. The web platform remains the
authority for installation enrollment, canonical identity, accepted source
revisions, and canonical persistence.

Food, over-the-counter medication, referral, reporting, FHIR mapping, and
provider/hospital access are excluded. Food and OTC remain evolving desktop
draft models and must not be added to the central contract through this task.

## Sources inspected

The freeze was derived from the desktop implementation rather than UI labels
or the audit-like outbox payload:

- migrations `0009-lifestyle-foundation.sql`,
  `0010-lifestyle-activity-response-semantics.sql`, and
  `0012-optional-other-activity-description.sql`;
- schema contracts through version 15 and migration
  `0015-encounter-management.sql`;
- Lifestyle repository types, validation, persistence, and integration tests;
- Lifestyle application service, IPC contracts, renderer workspace models,
  completion workflow, and reopen behavior;
- screening completion and encounter-management services;
- `sync_outbox` writers and the currently empty desktop sync-service module.

The desktop Lifestyle design plan was also checked for intent where the code
and database agree. When intent and executable behavior differ, this freeze
records the executable behavior and lists any uncertainty as a gap.

## Frozen aggregate boundary

Version 1 uses one encounter-owned aggregate snapshot:

| Contract property | Frozen decision |
| --- | --- |
| `resourceType` | `LIFESTYLE` |
| `schemaVersion` | `lifestyle.v1` |
| `localResourceId` | `lifestyle_drafts.id` |
| `sourceRevision` | `lifestyle_drafts.row_version` |
| Parent dependency | The same installation's accepted `SCREENING_ENCOUNTER` |
| Snapshot contents | Weekly Lifestyle record, child rows, and the three exact referenced baseline versions |
| Mutation model | Full-snapshot `UPSERT`; absence from a child array means absence from that source revision |

`lifestyle_drafts` owns the weekly aggregate. It is unique by encounter and
retains immutable ownership references to patient, screening session,
location, and installation. Alcohol, tobacco, physical-activity, work, and
other-activity weekly records are children of this aggregate. The baseline
versions are patient-and-installation scoped records, but a completed weekly
aggregate references exact immutable versions.

The machine contract must nest the referenced alcohol, tobacco, and work
baseline snapshots in `lifestyle.v1`. They are not separate batch resource
types in version 1. Nesting is required because:

1. the weekly record is not interpretable without its referenced versions;
2. the desktop outbox is encounter-aggregate scoped rather than baseline
   aggregate scoped;
3. a later active baseline must not change the meaning of an earlier week;
4. separate baseline records would add three new dependency streams without a
   corresponding desktop delivery aggregate.

Web ingestion may normalize nested baselines into separate canonical tables,
but it must preserve the source baseline ID, version, content, ownership, and
provenance. Reuse of an already accepted baseline ID is allowed only when its
canonical content is identical.

## Synchronization eligibility and lifecycle

Only a final, reviewed screening is eligible for a Lifestyle snapshot in
version 1. The desktop worker must load the current database state and submit
Lifestyle only when all of these are true:

- the canonical root encounter has status `COMPLETED`;
- its Lifestyle parent has status `COMPLETE`;
- all three referenced baseline versions resolve to the same patient and
  installation as the Lifestyle parent;
- all five weekly sections pass the implemented completion validation;
- the dependent patient, session, and encounter can be included earlier in the
  same batch or have already been accepted.

`DRAFT` and `IN_PROGRESS` are not synchronization states. `IN_PROGRESS` exists
in SQLite, but the inspected Lifestyle application service does not currently
write it. Save Draft writes `DRAFT`; Continue writes `COMPLETE`. Neither status
should be assigned a new central meaning.

Lifestyle can be reopened from `COMPLETE` to `DRAFT` only while its encounter
is still an editable canonical-root `DRAFT` encounter in the open current
session. Reopen increments `row_version` and creates audit/outbox metadata. The
overall encounter cannot become `COMPLETED` until Lifestyle is complete again,
so version 1 does not require a central retraction for this pre-finalization
reopen.

The desktop schema contains encounter statuses `AMENDED` and `VOID`, but the
inspected code does not implement creation of an amendment encounter, copying
or re-entering a Lifestyle aggregate for an amendment, or a Lifestyle-specific
void transition. Post-completion encounter management currently adds append-only
notes and review flags without editing Lifestyle. Therefore:

- `lifestyle.v1` represents a completed canonical-root encounter only;
- an accepted Lifestyle snapshot remains historical if its encounter later
  receives management notes or review flags;
- no client or server may invent Lifestyle replacement, deletion, amendment,
  or void semantics;
- amendment/void support requires a separately reviewed additive contract
  before the desktop emits a new Lifestyle snapshot for those states.

This limitation does not block freezing and implementing the completed-root
vertical slice, but it blocks claiming full post-completion lifecycle support.

## Baseline versioning

Alcohol, tobacco, and work each use append-only version rows. The version key
is unique per patient and installation, and the referenced row ID is retained
by the weekly aggregate. Updating a baseline inserts a new ID with the next
integer version; earlier rows remain unchanged.

Every completed Lifestyle snapshot must contain all three referenced baseline
objects. The worker must load by the stored reference IDs, not substitute the
currently active baseline. Each nested baseline carries:

- `localBaselineVersionId` and positive integer `version`;
- its exact controlled fields listed below;
- `createdByLocalActorId`, `createdAt`, `updatedByLocalActorId`, and `updatedAt`.

The web must reject a nested baseline whose source ownership does not match the
payload patient and authenticated installation. It must also reject reuse of a
baseline ID/version with different content.

### Alcohol baseline

| Field | Implemented values or rule |
| --- | --- |
| `status` | `CURRENT`, `FORMER`, `NEVER`, `UNKNOWN`, `DECLINED` |
| `everConsumed` | `YES`, `NO`, `UNKNOWN`, `DECLINED` |
| `consumedPast12Months` | `YES`, `NO`, `UNKNOWN`, `DECLINED` |
| `commonBeverageTypes` | Unique list of `BEER`, `WINE`, `SPIRITS`, `COCKTAILS`, `FORTIFIED_WINE`, `OTHER` |
| `otherBeverageDescription` | Required and nonblank only when `OTHER` is selected; otherwise null |

### Tobacco baseline

| Field | Implemented values or rule |
| --- | --- |
| `status` | `CURRENT_DAILY`, `CURRENT_SOME_DAYS`, `FORMER`, `NEVER`, `UNKNOWN`, `DECLINED` |
| `everRegularlyUsed` | `YES`, `NO`, `UNKNOWN`, `DECLINED` |
| `formerUseApproximateStopDate` | Null, `YYYY`, or `YYYY-MM`; no invented day precision |
| `currentUseFrequency` | `EVERY_DAY`, `SOME_DAYS`, `NOT_AT_ALL`, `UNKNOWN`, `DECLINED` |
| `productTypes` | Unique list of the tobacco product codes used by weekly rows |
| `otherProductDescription` | Required and nonblank only when `OTHER` is selected; otherwise null |

### Work baseline

| Field | Implemented values or rule |
| --- | --- |
| `status` | `EMPLOYED`, `SELF_EMPLOYED`, `FARMING`, `STUDENT`, `HOMEMAKER_CAREGIVER`, `UNEMPLOYED`, `RETIRED`, `UNABLE_TO_WORK`, `OTHER`, `DECLINED` |
| `occupationJobTitle` | Nullable nonblank text |
| `usualPhysicalDemand` | Null or `SITTING`, `STANDING`, `WALKING`, `MODERATE_LABOR`, `HEAVY_LABOR`, `VARIES` |
| `typicalWorkdaysPerWeek` | Null or integer 0-7 |
| `typicalHoursPerWorkday` | Null or finite value greater than 0 and at most 24 |
| `shiftPattern` | Null or `DAY`, `EVENING`, `NIGHT`, `ROTATING`, `IRREGULAR`, `NOT_APPLICABLE`, `UNKNOWN`, `DECLINED` |
| `description` | Nullable nonblank text |

The current validators do not impose additional relationships between the
baseline fields. The web contract must not derive or enforce unimplemented
clinical classifications.

## Weekly record and null semantics

Blank, zero, `NO`, `UNKNOWN`, `DECLINED`, `NOT_APPLICABLE`,
`UNABLE_TO_ANSWER`, and `PREFER_NOT_TO_ANSWER` are distinct. Null means no
value was recorded for that nullable field; it must never be silently converted
to a response code or numeric zero.

All child records carry their stable desktop UUID and source provenance:
`createdByLocalActorId`, `createdAt`, `updatedByLocalActorId`, and `updatedAt`.
Rows with a `sequenceNumber` require a positive, unique sequence within their
parent, but array position has no independent clinical meaning. Machine schema
generation should require deterministic sequence ordering in examples and
canonical hashing.

### Alcohol weekly record

`weeklyResponse` is one of `YES`, `NO`, `UNKNOWN`, `DECLINED`,
`NOT_APPLICABLE`, or `PREFER_NOT_TO_ANSWER` and is non-null in an eligible
snapshot.

- `YES` requires `drinkingDays` 1-7, positive finite
  `totalStandardizedDrinks`, positive finite `largestOneDayAmount`, and
  `daysAtLargestAmount` 1-7.
- `largestOneDayAmount` cannot exceed the weekly total;
  `daysAtLargestAmount` cannot exceed `drinkingDays`.
- The implemented decimal consistency checks require the highest-amount
  subtotal not to exceed the total, equality when every drinking day is a
  highest-amount day, and additional drinks when other drinking days exist.
- Beverage types are a unique list. The current completion validator does not
  require a nonempty list, but `OTHER` requires a description.
- Every non-`YES` response requires all four quantities null, an empty beverage
  list, and a null other description. `NO` is therefore not represented as
  numeric zero.

### Tobacco weekly record

`weeklyResponse` uses the same response set as Alcohol and is non-null.

- `YES` requires at least one product row; any other response requires no
  product rows.
- Product types are unique within the weekly record.
- Each product row contains `localProductRowId`, `sequenceNumber`,
  `productType`, `daysUsed` 1-7, positive finite
  `averageQuantityPerUseDay`, `unit`, nullable
  `secondhandSmokeExposure`, and nullable Other descriptions.
- Product type is one of `CIGARETTE`, `ROLLED_TOBACCO`, `CIGAR_PIPE`,
  `SMOKELESS`, `SNUFF`, `HOOKAH`, `VAPE`, `OTHER`.
- Unit is one of `STICKS_CIGARETTES`, `SESSIONS`, `PORTIONS`, `PINS`,
  `PODS_CARTRIDGES`, `OTHER`.
- Selecting `OTHER` for product or unit requires its matching nonblank
  description; otherwise that description is null.

### Physical activity weekly record

`weeklyResponse` is one of `YES`, `NO`, `UNKNOWN`, `DECLINED`,
`NOT_APPLICABLE`, `UNABLE_TO_ANSWER`, or `PREFER_NOT_TO_ANSWER` and is non-null.

- `YES` requires at least one activity row; any other response requires no
  activity rows.
- Every activity row contains `localActivityRowId`, `sequenceNumber`, domain,
  nullable description, intensity, `daysInPastSevenDays` 1-7, and
  `averageMinutesPerActiveDay` 1-1440.
- Domain is `WORK_OR_FARMING`, `TRANSPORT`, `HOUSEHOLD`, or `EXERCISE`.
- Intensity is `LIGHT`, `MODERATE`, or `VIGOROUS`.
- `sedentaryTimeResponse` is always non-null on completion and is one of
  `RECORDED`, `UNKNOWN`, `UNABLE_TO_ANSWER`, `DECLINED`, or
  `PREFER_NOT_TO_ANSWER`.
- `RECORDED` requires integer `sedentaryMinutesPerDay` 0-1439. Every other
  sedentary response requires that value to be null.

The desktop derives weekly activity minutes from days multiplied by minutes.
`weeklyMinutes` is not authoritative source input and must not be transmitted
as an independently editable value. The web may derive it deterministically.

### Work weekly record

The record contains a stable ID, provenance, and a non-null `weeklyResponse`:
`USUAL`, `LESS_THAN_USUAL`, `MORE_THAN_USUAL`, `NO_WORK`, `NOT_APPLICABLE`,
`UNKNOWN`, `DECLINED`, or `PREFER_NOT_TO_ANSWER`.

### Other activity

The aggregate-level `weeklyResponse` is non-null and is one of `YES`, `NO`,
`UNKNOWN`, `DECLINED`, or `PREFER_NOT_TO_ANSWER`.

- `YES` requires at least one other-activity row; every other response requires
  no rows.
- Each row contains a stable ID, positive unique sequence, category, nullable
  description, `daysInPastSevenDays` 1-7,
  `averageMinutesPerDay` 1-1440, intensity, and provenance.
- Category is `FARMING_GARDENING`, `HOUSEHOLD`, `CAREGIVING`, `COMMUNITY`,
  `COMMUTE`, `SPORT`, or `OTHER`.
- Migration 0012 and the current validator allow a null description for every
  category, including `OTHER`; the central contract must not make it required
  without a separately approved desktop change.

## Completion conflicts

All three baseline references and all five weekly sections must exist and pass
the rules above. In addition:

- Alcohol baseline `FORMER` or `NEVER` with weekly `YES` requires explicit
  confirmation of that exact alcohol baseline version ID.
- Tobacco baseline `FORMER` or `NEVER` with weekly `YES` requires explicit
  confirmation of that exact tobacco baseline version ID.
- When no such conflict exists, the corresponding confirmation must be null.

The confirmation is a completion guard and is written only to sanitized
audit/outbox metadata. The inspected durable Lifestyle tables do not retain a
separate confirmation column. The machine contract therefore does not pretend
that confirmation is a durable clinical answer. The completed snapshot proves
that the guarded transition succeeded against the referenced versions; any
future requirement to preserve the confirmation as central provenance needs an
explicit persistence decision.

## Identifiers, revisions, idempotency, and outbox mapping

The existing HSD-SYNC-001 idempotency rules apply unchanged:

- delivery key: `(installationId, recordId)`;
- snapshot key: `(installationId, LIFESTYLE, localResourceId, sourceRevision)`;
- equal key and equal canonical content replays as `UNCHANGED`;
- equal key with different content is `RECORD_PAYLOAD_MISMATCH`;
- a lower revision than the accepted revision is `STALE_SOURCE_REVISION`.

The desktop outbox does not contain a complete Lifestyle payload. Relevant
rows have `aggregate_type = SCREENING_ENCOUNTER`, the encounter UUID as
`aggregate_id`, and audit-like payloads for baseline creation, draft save,
Lifestyle completion, reopen, and encounter completion. They omit clinical
answers and are intentionally size-limited.

The future worker must:

1. group pending events by encounter aggregate;
2. load the current encounter, Lifestyle parent, referenced baselines, weekly
   records, child rows, actor rows, installation, session, and location in a
   consistent SQLite read;
3. wait while the current aggregate is not eligible rather than uploading a
   draft or the outbox `payload_json`;
4. choose one deterministic pending outbox UUID as `recordId` for the full
   snapshot and persist that delivery decision before transmission;
5. coalesce other pending Lifestyle events covered by the same
   `localResourceId` and `sourceRevision`;
6. mark the selected and coalesced events sent only after a terminal outcome
   under HSD-SYNC-001; `RETRY` remains pending.

The exact desktop coalescing table/state transition is a desktop implementation
decision. It must preserve the chosen `recordId` across retries and must not
generate a new delivery ID for the same attempt after a crash.

## Actor, time, and source provenance

The record envelope uses:

| Contract field | Desktop source |
| --- | --- |
| `recordId` | Persisted deterministic coordinator `sync_outbox.id` |
| `localResourceId` | `lifestyle_drafts.id` |
| `sourceRevision` | `lifestyle_drafts.row_version` |
| `capturedAt` | `lifestyle_drafts.updated_at` |
| `sourceActorLocalId` | `lifestyle_drafts.updated_by` |

The payload also retains `localPatientId`, `localEncounterId`,
`localScreeningSessionId`, `localLocationId`, `periodStart`, and `periodEnd`.
The period is the seven-date window ending on the screening session date; it is
stored as local calendar dates and must not be converted to UTC instants.

Every created/updated actor reference carried by the draft, nested baselines,
weekly parents, or child rows must resolve to one batch actor snapshot. The
server retains these source actors as unverified desktop practitioners under
the existing contract policy; it must not infer a centrally verified provider.

Created and updated timestamps are UTC source provenance. They are not trusted
ordering authority. `sourceRevision` controls aggregate ordering, and the web
receive time controls operational sequencing.

## Dependency order

The proposed batch processing order becomes:

1. `PATIENT`;
2. `SCREENING_SESSION`;
3. `SCREENING_ENCOUNTER`;
4. `VITALS`;
5. `LIFESTYLE`.

Lifestyle must resolve the same installation's patient, session, encounter,
and enrolled location. The encounter is its direct canonical parent. The
nested baselines create no separate batch dependencies.

If a dependency is not yet accepted, the Lifestyle outcome is retryable
`DEPENDENCY_NOT_AVAILABLE`. An independent record in the batch may still be
accepted.

## Proposed payload shape

The next machine-contract task should encode this exact shape with closed JSON
objects and reusable definitions. Field names below are frozen unless machine
schema implementation exposes an actual compatibility conflict.

```json
{
  "recordId": "10000000-0000-4000-8000-000000000051",
  "resourceType": "LIFESTYLE",
  "localResourceId": "10000000-0000-4000-8000-000000000052",
  "sourceRevision": 7,
  "schemaVersion": "lifestyle.v1",
  "operation": "UPSERT",
  "capturedAt": "2026-08-20T15:30:00.000Z",
  "sourceActorLocalId": "10000000-0000-4000-8000-000000000010",
  "payload": {
    "localPatientId": "10000000-0000-4000-8000-000000000020",
    "localEncounterId": "10000000-0000-4000-8000-000000000030",
    "localScreeningSessionId": "10000000-0000-4000-8000-000000000040",
    "localLocationId": "10000000-0000-4000-8000-000000000041",
    "status": "COMPLETE",
    "periodStart": "2026-08-14",
    "periodEnd": "2026-08-20",
    "createdByLocalActorId": "10000000-0000-4000-8000-000000000010",
    "createdAt": "2026-08-20T15:00:00.000Z",
    "updatedByLocalActorId": "10000000-0000-4000-8000-000000000010",
    "updatedAt": "2026-08-20T15:30:00.000Z",
    "baselines": {
      "alcohol": {
        "localBaselineVersionId": "10000000-0000-4000-8000-000000000061",
        "version": 1,
        "status": "CURRENT",
        "everConsumed": "YES",
        "consumedPast12Months": "YES",
        "commonBeverageTypes": ["BEER"],
        "otherBeverageDescription": null,
        "createdByLocalActorId": "10000000-0000-4000-8000-000000000010",
        "createdAt": "2026-08-20T15:00:00.000Z",
        "updatedByLocalActorId": "10000000-0000-4000-8000-000000000010",
        "updatedAt": "2026-08-20T15:00:00.000Z"
      },
      "tobacco": {
        "localBaselineVersionId": "10000000-0000-4000-8000-000000000062",
        "version": 1,
        "status": "NEVER",
        "everRegularlyUsed": "NO",
        "formerUseApproximateStopDate": null,
        "currentUseFrequency": "NOT_AT_ALL",
        "productTypes": [],
        "otherProductDescription": null,
        "createdByLocalActorId": "10000000-0000-4000-8000-000000000010",
        "createdAt": "2026-08-20T15:01:00.000Z",
        "updatedByLocalActorId": "10000000-0000-4000-8000-000000000010",
        "updatedAt": "2026-08-20T15:01:00.000Z"
      },
      "work": {
        "localBaselineVersionId": "10000000-0000-4000-8000-000000000063",
        "version": 1,
        "status": "FARMING",
        "occupationJobTitle": "Synthetic crop farmer",
        "usualPhysicalDemand": "MODERATE_LABOR",
        "typicalWorkdaysPerWeek": 5,
        "typicalHoursPerWorkday": 6,
        "shiftPattern": "DAY",
        "description": null,
        "createdByLocalActorId": "10000000-0000-4000-8000-000000000010",
        "createdAt": "2026-08-20T15:02:00.000Z",
        "updatedByLocalActorId": "10000000-0000-4000-8000-000000000010",
        "updatedAt": "2026-08-20T15:02:00.000Z"
      }
    },
    "alcohol": {
      "localWeeklyRecordId": "10000000-0000-4000-8000-000000000071",
      "weeklyResponse": "YES",
      "drinkingDays": 2,
      "totalStandardizedDrinks": 3,
      "largestOneDayAmount": 2,
      "daysAtLargestAmount": 1,
      "commonBeverageTypes": ["BEER"],
      "otherBeverageDescription": null,
      "createdByLocalActorId": "10000000-0000-4000-8000-000000000010",
      "createdAt": "2026-08-20T15:10:00.000Z",
      "updatedByLocalActorId": "10000000-0000-4000-8000-000000000010",
      "updatedAt": "2026-08-20T15:10:00.000Z"
    },
    "tobacco": {
      "localWeeklyRecordId": "10000000-0000-4000-8000-000000000072",
      "weeklyResponse": "NO",
      "products": [],
      "createdByLocalActorId": "10000000-0000-4000-8000-000000000010",
      "createdAt": "2026-08-20T15:12:00.000Z",
      "updatedByLocalActorId": "10000000-0000-4000-8000-000000000010",
      "updatedAt": "2026-08-20T15:12:00.000Z"
    },
    "physicalActivity": {
      "localWeeklyRecordId": "10000000-0000-4000-8000-000000000073",
      "weeklyResponse": "YES",
      "sedentaryTimeResponse": "RECORDED",
      "sedentaryMinutesPerDay": 240,
      "activities": [
        {
          "localActivityRowId": "10000000-0000-4000-8000-000000000074",
          "sequenceNumber": 1,
          "activityDomain": "WORK_OR_FARMING",
          "description": null,
          "intensity": "MODERATE",
          "daysInPastSevenDays": 5,
          "averageMinutesPerActiveDay": 60,
          "createdByLocalActorId": "10000000-0000-4000-8000-000000000010",
          "createdAt": "2026-08-20T15:15:00.000Z",
          "updatedByLocalActorId": "10000000-0000-4000-8000-000000000010",
          "updatedAt": "2026-08-20T15:15:00.000Z"
        }
      ],
      "createdByLocalActorId": "10000000-0000-4000-8000-000000000010",
      "createdAt": "2026-08-20T15:15:00.000Z",
      "updatedByLocalActorId": "10000000-0000-4000-8000-000000000010",
      "updatedAt": "2026-08-20T15:15:00.000Z"
    },
    "work": {
      "localWeeklyRecordId": "10000000-0000-4000-8000-000000000075",
      "weeklyResponse": "USUAL",
      "createdByLocalActorId": "10000000-0000-4000-8000-000000000010",
      "createdAt": "2026-08-20T15:18:00.000Z",
      "updatedByLocalActorId": "10000000-0000-4000-8000-000000000010",
      "updatedAt": "2026-08-20T15:18:00.000Z"
    },
    "otherActivity": {
      "weeklyResponse": "NO",
      "activities": []
    }
  }
}
```

The machine schema must add the provenance fields shown above to tobacco
product rows and other-activity rows as well. The abbreviated synthetic example
contains no such rows, so it does not waive those requirements.

An accepted outcome uses the existing response shape:

```json
{
  "recordId": "10000000-0000-4000-8000-000000000051",
  "resourceType": "LIFESTYLE",
  "localResourceId": "10000000-0000-4000-8000-000000000052",
  "sourceRevision": 7,
  "status": "ACCEPTED",
  "canonicalResourceId": "20000000-0000-4000-8000-000000000052",
  "centralPersonId": null,
  "chsMedicalId": null,
  "medicalIdStatus": null,
  "errors": []
}
```

## Machine-contract requirements for the next task

HSD-SYNC-005B may add JSON Schema, OpenAPI, synthetic fixtures, and contract
tests only after this freeze is reviewed. It must:

- extend request and response resource enums with `LIFESTYLE`;
- implement `lifestyle.v1` as a closed full snapshot with the fields and
  conditional rules in this document;
- retain the existing `1.0` batch envelope only if compatibility tests prove
  the addition is accepted by both consumers before deployment; otherwise use
  an explicitly versioned additive path;
- add valid examples for every response branch and invalid examples for null,
  baseline ownership/version, child identity/sequence, cross-field, actor, and
  dependency failures;
- keep all examples synthetic and free of credentials or real patient data;
- make no Fastify, PostgreSQL, React, or desktop changes.

## Gaps and blockers

| Gap | Effect |
| --- | --- |
| Desktop sync service is empty | Blocks transport, durable coalescing, acknowledgment, and end-to-end proof; does not block the web machine schema |
| Outbox payloads are audit-like | Worker must load full current SQLite snapshots; direct upload is forbidden |
| `IN_PROGRESS` is persisted but unused by the service | Must remain non-eligible and must not gain invented semantics |
| Amendment/void creation and Lifestyle replacement rules are absent | Version 1 is limited to completed canonical-root snapshots |
| Completion conflict confirmations are not stored as durable Lifestyle columns | Central provenance for the confirmation needs a future explicit decision if required |
| No central Lifestyle persistence or ingestion exists | A later persistence/ingestion task remains required after HSD-SYNC-005B |
| Final `lifestyle_logs` are summaries, while detailed completed data remains in Lifestyle tables | Worker and ingestion must use the detailed aggregate, not treat summary log rows as the source snapshot |

These gaps must be resolved in their owning tasks. They are not permission to
guess, flatten clinical values, synchronize local drafts, or broaden this
contract to Food/OTC.

## Acceptance criteria

- Aggregate ownership, eligibility, baseline history, weekly fields, null
  semantics, provenance, identifiers, revisions, and dependencies are frozen.
- The proposed resource and schema names are `LIFESTYLE` and `lifestyle.v1`.
- Referenced baseline versions are nested and immutable; active baselines are
  never substituted.
- Draft, `IN_PROGRESS`, amendment, void, Food, and OTC behavior is not invented.
- The synthetic payload and outcome contain no real patient information.
- This task changes documentation only and introduces no runtime behavior.
