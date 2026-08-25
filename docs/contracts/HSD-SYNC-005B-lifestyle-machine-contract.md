# HSD-SYNC-005B: Lifestyle machine contract

Status: Implemented

Contract version: `1.0`

Resource type: `LIFESTYLE`

Payload schema: `lifestyle.v1`

## Purpose

This task converts the HSD-SYNC-005A Lifestyle discovery freeze into an
additive machine-readable synchronization contract. It does not add central
Lifestyle persistence or ingestion behavior; that follow-up is implemented by
[HSD-SYNC-005C](../sync/HSD-SYNC-005C.md).

## Contract surface

- `lifestyle.schema.json` defines a closed completed snapshot.
- The version 1 batch request and response enums accept `LIFESTYLE`.
- The existing five HTTP operations and `1.0` batch envelope are unchanged.
- Synthetic request and response fixtures demonstrate a complete batch with
  its patient, session, encounter, and Lifestyle dependency chain.
- Invalid fixtures and generated branch cases exercise the frozen conditional,
  provenance, identity, ordering, and arithmetic rules.

Each Lifestyle snapshot is owned by one completed canonical-root encounter.
It includes the exact alcohol, tobacco, and work baseline versions referenced
when the week was completed, plus the weekly alcohol, tobacco, physical
activity, work, and other-activity sections and their durable child rows.

## Validation boundaries

JSON Schema enforces closed objects, required fields, types, ranges, enums, and
response-branch shapes. Runtime contract validation additionally enforces:

- every nested actor reference resolves to the batch actor snapshot list;
- payload and envelope locations match;
- the weekly period contains exactly seven calendar dates;
- durable child IDs are unique across the aggregate;
- child sequence values are unique and strictly ascending;
- tobacco product types are not duplicated;
- alcohol subtotals and weekly totals exactly match the supplied quantities.

Patient, session, and encounter references may resolve from the same batch or
from an earlier accepted snapshot for the same installation. Dependency
availability remains an ingestion concern; the machine contract validates the
reference shapes without querying canonical storage.

## Compatibility proof

The contract suite validates the existing version 1 fixtures unchanged, a
complete Lifestyle batch request and response, every allowed Lifestyle response
branch, and invalid Lifestyle mutations. All examples use explicitly synthetic
people and contain no credentials.

## Deliberate exclusions

- `DRAFT` and `IN_PROGRESS` Lifestyle aggregates;
- central PostgreSQL persistence and Fastify ingestion (implemented separately
  by HSD-SYNC-005C);
- operations-portal Lifestyle viewing;
- desktop snapshot construction, transport, retry, and acknowledgement;
- amendment, replacement, and void semantics;
- Food, OTC medication, referral, reporting, and FHIR mapping;
- completion-conflict confirmations, which are not durable Lifestyle fields in
  desktop schema version 15.

The desktop worker must eventually construct the full snapshot from durable
Lifestyle tables. Existing audit-like outbox payloads are not clinical
snapshots and must not be uploaded directly.

## Acceptance evidence

- OpenAPI references the extended request and response schemas.
- Contract tests cover 11 schemas, 13 valid fixtures, 46 invalid fixtures, five
  OpenAPI operations, and 37 allowed Lifestyle response branches.
- Repository lint, type-check, test, build, and diff checks must pass before
  merge.
