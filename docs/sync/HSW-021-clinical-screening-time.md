# HSW-021: clinical screening time and delayed documentation

New desktop encounters capture an entered screening date/time in the installation's IANA timezone before opening the chart. It defaults to the current instant in that zone; the clinician can enter an earlier date/time. All sections share this encounter context. Individual vitals readings retain their measurement date and time, including readings across midnight. Weekly Lifestyle (including activity), Food and OTC periods end on the entered clinical date.

`clinicalTime = { localDate, localTime, timezone }` is an optional, strict encounter payload extension. For tagged new encounters `startedAt` is the corresponding UTC clinical instant; `createdAt` is the unmodified device timestamp at chart creation, `updatedAt` is the actual latest write, and `completedAt` is actual finalization. Each reading keeps its own source create/update timestamps. Server ingestion timestamps remain separate. An entered clinical instant cannot be later than chart creation. The installation timezone must match the authenticated enrollment context; device display timezone does not reinterpret entered values. DST gaps and repeated hours fail validation rather than selecting an arbitrary instant.

Administrative daily sessions continue to own documentation activity. For tagged encounters, API session bounds use source `createdAt` and actual `completedAt`, allowing care before session opening. Vitals are bounded by the entered clinical start and actual documentation/finalization time, and remain in sequence order. The first reading defaults to the screening date/time; repeat readings may override both date and time. In a late entry, choose the start of the actual screening, including its first vital measurement.

Entered timing is fixed once an encounter is created, survives draft reopening, and is part of immutable sync identity. Correct an incorrectly created empty draft through the existing cancellation workflow and start a new screening. Completed-record corrections and historical data recovery are separate work. The UI distinguishes screening time from documentation start; the web displays entered screening time with its original timezone.

## Compatibility and deployment

Apply CHS-web migration `0013_clinical_screening_time.sql` and restart the API before running the updated desktop. The desktop migrates to SQLite schema 23 on startup. Both migrations are additive; existing encounters have null clinical timing and keep their old behavior. No clinical data, outbox rows, rejected outcomes, or identity links are deleted or reset. Existing rejected measurements are not automatically replayed. FHIR remains deferred.

The optional extension is supported by this server and existing payloads remain accepted. Old servers reject the new field, so server-first deployment is required. Do not downgrade a schema-23 desktop to schema-22 code.

## Verification

Create a genuinely new screening with yesterday's care time, enter vitals including a later repeat, complete all sections, and allow normal sync. Verify canonical vitals appear in the web and the displayed screening date/time matches the entered site time. Device save/finalization timestamps should still be today. Also check same-minute entry, midnight readings, a computer timezone different from the installation, future-time rejection, and reopening an unfinished draft.

PostgreSQL integration gate: `pnpm db:migrate` then `pnpm db:test`. These commands should run against local development databases before merge. Existing data cleanup is explicitly deferred.
