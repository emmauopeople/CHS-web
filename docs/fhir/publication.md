# Private FHIR R4 publication

The operational PostgreSQL database remains authoritative. A separate HAPI FHIR R4 server and PostgreSQL volume hold derived interoperability resources. FHIR publication failures do not roll back accepted desktop screening records.

## Isolation and deployment

The optional `compose.fhir.deploy.yaml` overlay adds `fhir-db`, `fhir`, and `fhir-worker` to the existing `chs` project. Both database and FHIR HTTP networks are private. No host port, public hostname, tunnel route, raw FHIR UI, MCP endpoint or arbitrary public proxy is exposed. Hospital access goes through the API's authorization boundary. The older `compose.fhir.yaml` is an independent developer database and is not the pilot service.

The HAPI image is versioned and digest-pinned to `hapiproject/hapi:v8.12.0-2`; PostgreSQL is pinned to the deployment's PostgreSQL 18 image. Memory ceilings are 2 GiB for HAPI, 512 MiB for its database and 512 MiB for the worker. The HAPI JVM has a 1400 MiB maximum heap; request validation is enabled. Spring reads the database password from a Docker secret through config-tree import. Setup generates private secrets without replacing existing values.

```powershell
node scripts/deployment/setup.mjs
docker compose --env-file .deployment/deploy.env -f compose.deploy.yaml -f compose.fhir.deploy.yaml --profile interoperability up -d --build --wait
```

Apply operational migrations before starting the updated API or worker. PostgreSQL constraints, the FHIR queue and the identity service stay isolated from One Community. Monitor actual memory/CPU and queue lag during the pilot. Copy the same source, pinned images and encrypted private configuration to OVH when migrating; do not start a second publisher against the same FHIR store until operational ownership is coordinated.

## Publication semantics

Operational insert/update triggers enqueue a patient in the source transaction. They perform no network calls. Existing patients are queued by migration 0020. Every source change increments a generation. The worker claims work using leases and `SKIP LOCKED`, takes a patient-specific session advisory lock, and reads a repeatable source snapshot. Sync writers do not acquire that advisory lock.

Stable FHIR IDs derive from canonical source UUIDs. Observation variants use deterministic hashed IDs to distinguish blood pressure, pulse, weight and waist. The registry stores identity references and content hashes, never raw clinical JSON. Unchanged resources are skipped. Changed resources are sent in an atomic FHIR transaction with explicit `PUT` IDs; replay after a lost response is safe. Removed clinical projections are deleted through the FHIR transaction; source voids normally retain records with `entered-in-error` status. Database registry/queue updates and publication events commit together only after a successful FHIR response.

A concurrent source change leaves the patient pending for another pass. Failed publications retry with capped exponential backoff (up to an hour). A dead worker's lease can be reclaimed. Explicit per-patient limits (500 encounters, 5000 resources and 4 MiB mapped content) produce a visible `BLOCKED` item instead of silently truncating clinical history. Correct or split the oversized source before retrying; do not alter accepted patient records solely to clear a queue.

## Initial mappings

| Canonical data | R4 representation |
| --- | --- |
| Patient and active identifiers | Patient; approximate age/as-of date use a recorded-age extension, never an invented birth date |
| Source organizations and locations | Organization and Location |
| Screening encounter and author/source | Encounter and Provenance |
| Each BP reading and pulse | LOINC-coded Observation; UCUM `mm[Hg]` and `/min` |
| Weight and waist | Observation with source units; waist uses a local code because the source does not assert the site/method required by LOINC 8280-0 |
| Lifestyle, Food and OTC snapshots | Typed QuestionnaireResponse items with a CHS kind tag; no claim of an approved national questionnaire profile |
| Referral and current workflow status | ServiceRequest and Task |
| Source-reported follow-up, medications/advice and next actions | Communication retaining the structured source report, including its provenance |
| Immutable addenda and review flags | Communication and Flag |

Reported medication use is not converted into a prescription. Referral source text does not become a diagnosis. Date-only measurements retain date-only precision instead of inventing UTC measurement times. Raw screening payloads remain outside operational audit/registry JSON. FHIR stores derived resource JSON in its own database by design.

Base R4 validation is exercised against the private server's `$validate` operation using synthetic fixtures for every mapped resource. This does not claim conformance to a hospital-specific or national implementation guide; those profiles and terminology agreements must be added when an exchange partner specifies them. DocumentReference/DiagnosticReport publication awaits an actual document ingestion domain.

## Status and recovery

Super admins use **Provider Access → Refresh FHIR status** to inspect counts and the first fifty failed/blocked items. The API returns `503 FHIR_PUBLICATION_NOT_READY` instead of serving a generation older than accepted source data. FHIR can be stopped for maintenance while desktop uploads continue. Restart it and the worker to resume publication; queued work survives restarts.

Back up both authoritative stores and the derived FHIR store. The FHIR database can be regenerated from canonical data, but retaining it preserves server versions/history. Example dump inside the container:

```powershell
docker compose --env-file .deployment/deploy.env -f compose.deploy.yaml -f compose.fhir.deploy.yaml exec -T fhir-db pg_dump -U fhir -d hapi_fhir -Fc -f /tmp/chs-fhir-backup.dump
docker compose --env-file .deployment/deploy.env -f compose.deploy.yaml -f compose.fhir.deploy.yaml cp fhir-db:/tmp/chs-fhir-backup.dump .deployment/backups/fhir.dump
```

Keep backup copies and deployment secrets encrypted and separate from source control. For a rebuild, use a new isolated FHIR store, clear/rebuild its corresponding derived registry under a controlled maintenance procedure and requeue canonical patients. Never drop operational tables or reset desktop outboxes to repair a FHIR problem.

Configuration follows the [HAPI server documentation](https://github.com/hapifhir/hapi-fhir-jpaserver-starter) and resource structure follows [FHIR R4](https://hl7.org/fhir/R4/).
