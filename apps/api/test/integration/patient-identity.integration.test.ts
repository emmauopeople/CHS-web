import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateWithClient } from '../../../../packages/database/src/migration-runner.mjs';
import { beginSyncBatch } from '../../src/sync/batch-intake.js';
import { installationTokenHash } from '../../src/sync/installation-auth.js';
import {
  processPatientRecord,
  PatientRecordProcessingError,
} from '../../src/sync/patient-identity.js';
import type {
  InstallationContext,
  PatientPayload,
  PatientSyncRecord,
  SyncBatchRequest,
} from '../../src/sync/types.js';

const connectionString = process.env.DATABASE_TEST_URL;
const runIntegration = connectionString ? describe : describe.skip;
const now = new Date('2026-08-19T14:00:00.000Z');
const organizationId = '10000000-0000-4000-8000-000000000001';
const installationId = '20000000-0000-4000-8000-000000000001';
const canonicalLocationId = '30000000-0000-4000-8000-000000000001';
const sourceLocationId = '32000000-0000-4000-8000-000000000001';
const actorId = '60000000-0000-4000-8000-000000000001';
const context: InstallationContext = {
  installationId,
  organizationId,
  configuredLocationId: canonicalLocationId,
  timezone: 'Africa/Douala',
};

runIntegration('patient identity processing with PostgreSQL', () => {
  const schema = `chs_patient_${randomUUID().replaceAll('-', '')}`;
  let administrationPool: pg.Pool;
  let servicePool: pg.Pool;

  beforeAll(async () => {
    administrationPool = new pg.Pool({ connectionString });
    const migrationClient = await administrationPool.connect();
    await migrationClient.query(`CREATE SCHEMA "${schema}"`);
    await migrationClient.query(`SET search_path TO "${schema}"`);
    await migrateWithClient({ client: migrationClient, logger: { info() {} } });
    migrationClient.release();

    servicePool = new pg.Pool({
      connectionString,
      options: `-c search_path=${schema}`,
    });
    await seedInstallation(servicePool);
  });

  afterAll(async () => {
    await servicePool.end();
    await administrationPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await administrationPool.end();
  });

  it('atomically creates a person and medical ID, returns it, and replays unchanged', async () => {
    const record = patientRecord({
      localResourceId: '50000000-0000-4000-8000-000000000101',
      recordId: '40000000-0000-4000-8000-000000000101',
      localPatientCode: 'PT-000101',
      displayName: 'Émile Nfor-Mbah',
      dateOfBirth: '1980-04-12',
      phone: '+237 600 000 101',
    });
    const batchInternalId = await startBatch(servicePool, record);

    const first = await processPatientRecord(
      servicePool,
      context,
      batchInternalId,
      record,
      now,
      { generateMedicalId: () => 'CHS-TEST-0101-ABCD' },
    );

    expect(first).toMatchObject({
      status: 'ACCEPTED',
      medicalIdStatus: 'ASSIGNED',
      chsMedicalId: 'CHS-TEST-0101-ABCD',
    });
    expect(first.centralPersonId).toBe(first.canonicalResourceId);

    const stored = await servicePool.query(
      `SELECT
         person.name_normalized,
         identifier.identifier_value,
         source.last_source_revision,
         sync.status,
         sync.errors
       FROM persons AS person
       JOIN person_identifiers AS identifier ON identifier.person_id = person.id
       JOIN patient_source_links AS source ON source.person_id = person.id
       JOIN sync_records AS sync ON sync.person_id = person.id
       WHERE person.id = $1`,
      [first.centralPersonId],
    );
    expect(stored.rows[0]).toEqual({
      name_normalized: 'emile mbah nfor',
      identifier_value: 'CHS-TEST-0101-ABCD',
      last_source_revision: 1,
      status: 'ACCEPTED',
      errors: [],
    });

    await expect(
      processPatientRecord(servicePool, context, batchInternalId, record, now),
    ).resolves.toMatchObject({
      status: 'UNCHANGED',
      centralPersonId: first.centralPersonId,
      chsMedicalId: 'CHS-TEST-0101-ABCD',
      medicalIdStatus: 'CONFIRMED',
    });
  });

  it('advances an existing source only for a newer revision', async () => {
    const original = patientRecord({
      localResourceId: '50000000-0000-4000-8000-000000000102',
      recordId: '40000000-0000-4000-8000-000000000102',
      sourceRevision: 3,
      localPatientCode: 'PT-000102',
      displayName: 'Revision Example',
      dateOfBirth: '1975-01-10',
    });
    const firstBatch = await startBatch(servicePool, original);
    const first = await processPatientRecord(
      servicePool,
      context,
      firstBatch,
      original,
      now,
      { generateMedicalId: () => 'CHS-TEST-0102-ABCD' },
    );

    const stale = patientRecord({
      localResourceId: original.localResourceId,
      recordId: '40000000-0000-4000-8000-000000000103',
      sourceRevision: 2,
      localPatientCode: original.payload.localPatientCode,
      displayName: original.payload.displayName,
      dateOfBirth: original.payload.dateOfBirth,
    });
    const staleBatch = await startBatch(servicePool, stale);
    await expect(
      processPatientRecord(servicePool, context, staleBatch, stale, now),
    ).resolves.toMatchObject({
      status: 'REJECTED',
      errors: [{ code: 'STALE_SOURCE_REVISION', path: '/sourceRevision' }],
    });

    const newer = patientRecord({
      localResourceId: original.localResourceId,
      recordId: '40000000-0000-4000-8000-000000000104',
      sourceRevision: 4,
      localPatientCode: original.payload.localPatientCode,
      knownChsMedicalId: first.chsMedicalId,
      displayName: original.payload.displayName,
      dateOfBirth: original.payload.dateOfBirth,
      phone: '+237600000104',
    });
    const newerBatch = await startBatch(servicePool, newer);
    await expect(
      processPatientRecord(servicePool, context, newerBatch, newer, now),
    ).resolves.toMatchObject({
      status: 'ACCEPTED',
      medicalIdStatus: 'CONFIRMED',
      centralPersonId: first.centralPersonId,
    });

    const source = await servicePool.query(
      `SELECT last_source_revision, source_updated_at
       FROM patient_source_links
       WHERE installation_id = $1 AND local_patient_id = $2`,
      [installationId, original.localResourceId],
    );
    expect(source.rows[0].last_source_revision).toBe(4);
  });

  it('links a known medical ID only after exact normalized name and birth-date verification', async () => {
    const firstRecord = patientRecord({
      localResourceId: '50000000-0000-4000-8000-000000000105',
      recordId: '40000000-0000-4000-8000-000000000105',
      localPatientCode: 'PT-000105',
      displayName: 'NFOR Mbah, Emile',
      dateOfBirth: '1981-02-03',
    });
    const firstBatch = await startBatch(servicePool, firstRecord);
    const first = await processPatientRecord(
      servicePool,
      context,
      firstBatch,
      firstRecord,
      now,
      { generateMedicalId: () => 'CHS-TEST-0105-ABCD' },
    );

    const linkedRecord = patientRecord({
      localResourceId: '50000000-0000-4000-8000-000000000106',
      recordId: '40000000-0000-4000-8000-000000000106',
      localPatientCode: 'PT-000106',
      knownChsMedicalId: first.chsMedicalId,
      displayName: 'Émile Nfor Mbah',
      dateOfBirth: '1981-02-03',
    });
    const linkedBatch = await startBatch(servicePool, linkedRecord);
    await expect(
      processPatientRecord(servicePool, context, linkedBatch, linkedRecord, now),
    ).resolves.toMatchObject({
      status: 'ACCEPTED',
      medicalIdStatus: 'CONFIRMED',
      centralPersonId: first.centralPersonId,
      chsMedicalId: 'CHS-TEST-0105-ABCD',
    });

    const count = await servicePool.query(
      'SELECT count(*)::integer AS count FROM persons WHERE id = $1',
      [first.centralPersonId],
    );
    const links = await servicePool.query(
      'SELECT count(*)::integer AS count FROM patient_source_links WHERE person_id = $1',
      [first.centralPersonId],
    );
    expect(count.rows[0].count).toBe(1);
    expect(links.rows[0].count).toBe(2);
  });

  it('opens review without disclosing an ID for possible duplicates or failed known-ID evidence', async () => {
    const source = patientRecord({
      localResourceId: '50000000-0000-4000-8000-000000000107',
      recordId: '40000000-0000-4000-8000-000000000107',
      localPatientCode: 'PT-000107',
      displayName: 'Possible Duplicate',
      dateOfBirth: '1965-08-09',
    });
    const sourceBatch = await startBatch(servicePool, source);
    const accepted = await processPatientRecord(
      servicePool,
      context,
      sourceBatch,
      source,
      now,
      { generateMedicalId: () => 'CHS-TEST-0107-ABCD' },
    );

    const possibleDuplicate = patientRecord({
      localResourceId: '50000000-0000-4000-8000-000000000108',
      recordId: '40000000-0000-4000-8000-000000000108',
      localPatientCode: 'PT-000108',
      displayName: source.payload.displayName,
      dateOfBirth: source.payload.dateOfBirth,
    });
    const duplicateBatch = await startBatch(servicePool, possibleDuplicate);
    await expect(
      processPatientRecord(
        servicePool,
        context,
        duplicateBatch,
        possibleDuplicate,
        now,
      ),
    ).resolves.toMatchObject({
      status: 'REVIEW_REQUIRED',
      centralPersonId: null,
      chsMedicalId: null,
      medicalIdStatus: 'PENDING_REVIEW',
      errors: [{ code: 'POSSIBLE_DUPLICATE' }],
    });

    const failedEvidence = patientRecord({
      localResourceId: '50000000-0000-4000-8000-000000000109',
      recordId: '40000000-0000-4000-8000-000000000109',
      localPatientCode: 'PT-000109',
      knownChsMedicalId: accepted.chsMedicalId,
      displayName: 'Different Identity',
      dateOfBirth: '1990-01-01',
    });
    const failedEvidenceBatch = await startBatch(servicePool, failedEvidence);
    await expect(
      processPatientRecord(
        servicePool,
        context,
        failedEvidenceBatch,
        failedEvidence,
        now,
      ),
    ).resolves.toMatchObject({
      status: 'REVIEW_REQUIRED',
      centralPersonId: null,
      chsMedicalId: null,
      errors: [{ code: 'IDENTITY_VERIFICATION_REQUIRED' }],
    });

    const reviews = await servicePool.query(
      `SELECT review.status, candidate.person_id, candidate.matched_on
       FROM identity_review_cases AS review
       JOIN identity_review_candidates AS candidate
         ON candidate.review_case_id = review.id
       WHERE review.local_patient_id IN ($1, $2)
       ORDER BY review.local_patient_id`,
      [possibleDuplicate.localResourceId, failedEvidence.localResourceId],
    );
    expect(reviews.rows).toHaveLength(2);
    expect(reviews.rows.every((row) => row.status === 'OPEN')).toBe(true);
    expect(reviews.rows.every((row) => row.person_id === accepted.centralPersonId)).toBe(
      true,
    );

    const evidence = await servicePool.query(
      `SELECT
         review.local_patient_id,
         snapshot.source_record_id,
         snapshot.source_revision,
         snapshot.schema_version,
         snapshot.payload_hash,
         snapshot.local_patient_code,
         snapshot.claimed_chs_medical_id,
         snapshot.display_name,
         snapshot.name_normalized,
         snapshot.date_of_birth::text AS date_of_birth,
         snapshot.acknowledgment_status,
         snapshot.patient_status,
         snapshot.phone,
         snapshot.village,
         snapshot.quarter
       FROM identity_review_cases AS review
       JOIN identity_review_evidence_snapshots AS snapshot
         ON snapshot.review_case_id = review.id
       WHERE review.local_patient_id IN ($1, $2)
       ORDER BY review.local_patient_id, snapshot.source_revision`,
      [possibleDuplicate.localResourceId, failedEvidence.localResourceId],
    );
    expect(evidence.rows).toHaveLength(2);
    expect(evidence.rows[0]).toMatchObject({
      local_patient_id: possibleDuplicate.localResourceId,
      source_record_id: possibleDuplicate.recordId,
      source_revision: 1,
      schema_version: 'patient.v1',
      local_patient_code: 'PT-000108',
      claimed_chs_medical_id: null,
      display_name: 'Possible Duplicate',
      name_normalized: 'duplicate possible',
      date_of_birth: '1965-08-09',
      acknowledgment_status: 'ACKNOWLEDGED',
      patient_status: 'ACTIVE',
      phone: null,
      village: 'Synthetic Village',
      quarter: 'Synthetic Quarter',
    });
    expect(evidence.rows[0].payload_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence.rows[1]).toMatchObject({
      local_patient_id: failedEvidence.localResourceId,
      source_record_id: failedEvidence.recordId,
      source_revision: 1,
      local_patient_code: 'PT-000109',
      claimed_chs_medical_id: accepted.chsMedicalId,
      display_name: 'Different Identity',
      date_of_birth: '1990-01-01',
    });

    const personsBeforeRevision = await servicePool.query(
      'SELECT count(*)::integer AS count FROM persons',
    );
    const revisedEvidence = patientRecord({
      localResourceId: possibleDuplicate.localResourceId,
      recordId: '40000000-0000-4000-8000-000000000118',
      sourceRevision: 2,
      localPatientCode: possibleDuplicate.payload.localPatientCode,
      displayName: 'Corrected Unmatched Identity',
      dateOfBirth: '1970-01-01',
    });
    const revisedBatch = await startBatch(servicePool, revisedEvidence);
    await expect(
      processPatientRecord(servicePool, context, revisedBatch, revisedEvidence, now),
    ).resolves.toMatchObject({
      status: 'REVIEW_REQUIRED',
      centralPersonId: null,
      chsMedicalId: null,
    });
    const evidenceRevisions = await servicePool.query(
      `SELECT snapshot.source_revision, snapshot.display_name
       FROM identity_review_cases AS review
       JOIN identity_review_evidence_snapshots AS snapshot
         ON snapshot.review_case_id = review.id
       WHERE review.installation_id = $1 AND review.local_patient_id = $2
       ORDER BY snapshot.source_revision`,
      [installationId, possibleDuplicate.localResourceId],
    );
    expect(evidenceRevisions.rows).toEqual([
      { source_revision: 1, display_name: 'Possible Duplicate' },
      { source_revision: 2, display_name: 'Corrected Unmatched Identity' },
    ]);
    const personsAfterRevision = await servicePool.query(
      'SELECT count(*)::integer AS count FROM persons',
    );
    expect(personsAfterRevision.rows[0]).toEqual(personsBeforeRevision.rows[0]);
  });

  it('rejects unknown and conflicting medical IDs without changing the linked person', async () => {
    const unknown = patientRecord({
      localResourceId: '50000000-0000-4000-8000-000000000110',
      recordId: '40000000-0000-4000-8000-000000000110',
      localPatientCode: 'PT-000110',
      knownChsMedicalId: 'CHS-NOTF-OUND-0000',
      displayName: 'Unknown Identifier',
      dateOfBirth: '1988-05-06',
    });
    const unknownBatch = await startBatch(servicePool, unknown);
    await expect(
      processPatientRecord(servicePool, context, unknownBatch, unknown, now),
    ).resolves.toMatchObject({
      status: 'REJECTED',
      errors: [{ code: 'UNKNOWN_CHS_MEDICAL_ID' }],
    });

    const linked = patientRecord({
      localResourceId: '50000000-0000-4000-8000-000000000111',
      recordId: '40000000-0000-4000-8000-000000000111',
      localPatientCode: 'PT-000111',
      displayName: 'Linked Identifier',
      dateOfBirth: '1979-07-08',
    });
    const linkedBatch = await startBatch(servicePool, linked);
    await processPatientRecord(servicePool, context, linkedBatch, linked, now, {
      generateMedicalId: () => 'CHS-TEST-0111-ABCD',
    });

    const conflict = patientRecord({
      localResourceId: linked.localResourceId,
      recordId: '40000000-0000-4000-8000-000000000112',
      sourceRevision: 2,
      localPatientCode: linked.payload.localPatientCode,
      knownChsMedicalId: 'CHS-DIFF-EREN-TID0',
      displayName: linked.payload.displayName,
      dateOfBirth: linked.payload.dateOfBirth,
    });
    const conflictBatch = await startBatch(servicePool, conflict);
    await expect(
      processPatientRecord(servicePool, context, conflictBatch, conflict, now),
    ).resolves.toMatchObject({
      status: 'REJECTED',
      errors: [{ code: 'KNOWN_CHS_MEDICAL_ID_CONFLICT' }],
    });
  });

  it('rolls back person creation if a unique medical ID cannot be issued', async () => {
    const before = await servicePool.query(
      `SELECT
         (SELECT count(*)::integer FROM persons) AS persons,
         (SELECT count(*)::integer FROM sync_records) AS records`,
    );
    const record = patientRecord({
      localResourceId: '50000000-0000-4000-8000-000000000113',
      recordId: '40000000-0000-4000-8000-000000000113',
      localPatientCode: 'PT-000113',
      displayName: 'Unique Rollback Identity',
      dateOfBirth: '1950-03-02',
    });
    const batchInternalId = await startBatch(servicePool, record);

    await expect(
      processPatientRecord(servicePool, context, batchInternalId, record, now, {
        generateMedicalId: () => 'CHS-TEST-0101-ABCD',
      }),
    ).rejects.toBeInstanceOf(PatientRecordProcessingError);

    const after = await servicePool.query(
      `SELECT
         (SELECT count(*)::integer FROM persons) AS persons,
         (SELECT count(*)::integer FROM sync_records) AS records`,
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });
});

function patientRecord(
  values: Readonly<{
    localResourceId: string;
    recordId: string;
    sourceRevision?: number;
    localPatientCode: string;
    knownChsMedicalId?: string | null;
    displayName: string;
    dateOfBirth: string | null;
    phone?: string | null;
  }>,
): PatientSyncRecord {
  const payload: PatientPayload = {
    localPatientCode: values.localPatientCode,
    knownChsMedicalId: values.knownChsMedicalId ?? null,
    displayName: values.displayName,
    givenName: null,
    familyName: null,
    otherNames: null,
    dateOfBirth: values.dateOfBirth,
    approximateAgeYears: values.dateOfBirth === null ? 40 : null,
    ageAsOfDate: values.dateOfBirth === null ? '2026-08-19' : null,
    sex: 'UNKNOWN',
    phone: values.phone ?? null,
    alternateContactName: null,
    alternateContactPhone: null,
    village: 'Synthetic Village',
    quarter: 'Synthetic Quarter',
    residenceNotes: null,
    status: 'ACTIVE',
    acknowledgmentStatus: 'ACKNOWLEDGED',
    createdAt: '2026-08-19T12:00:00.000Z',
    updatedAt: '2026-08-19T13:00:00.000Z',
  };
  return {
    recordId: values.recordId,
    resourceType: 'PATIENT',
    localResourceId: values.localResourceId,
    sourceRevision: values.sourceRevision ?? 1,
    schemaVersion: 'patient.v1',
    operation: 'UPSERT',
    capturedAt: '2026-08-19T13:00:00.000Z',
    sourceActorLocalId: actorId,
    payload,
  };
}

async function startBatch(pool: pg.Pool, record: PatientSyncRecord): Promise<string> {
  const request: SyncBatchRequest = {
    contractVersion: '1.0',
    batchId: randomUUID(),
    installationId,
    locationId: sourceLocationId,
    installationTimezone: 'Africa/Douala',
    desktopApplicationVersion: '0.13.0',
    desktopSchemaVersion: 13,
    createdAt: '2026-08-19T13:30:00.000Z',
    actors: [
      {
        localActorId: actorId,
        displayName: 'Synthetic Local Administrator',
        role: 'LOCAL_ADMIN',
        active: true,
        updatedAt: '2026-08-19T12:00:00.000Z',
      },
    ],
    records: [record],
  };
  const intake = await beginSyncBatch(pool, context, request, now);
  if (intake.kind !== 'NEW') throw new Error('Expected a new synthetic batch');
  return intake.batchInternalId;
}

async function seedInstallation(pool: pg.Pool) {
  const timestamp = now.toISOString();
  await pool.query(
    `INSERT INTO organizations (
       id, identifier_system, identifier_value, name, organization_type_code,
       created_at, updated_at
     ) VALUES ($1, 'https://chs.example/id/organization', 'ORG-PATIENT-001',
       'Synthetic Patient Program', 'PROGRAM', $2, $2)`,
    [organizationId, timestamp],
  );
  await pool.query(
    `INSERT INTO locations (
       id, organization_id, identifier_system, identifier_value, name,
       location_type_code, physical_type_code, created_at, updated_at
     ) VALUES ($1, $2, 'https://chs.example/id/location', 'LOC-PATIENT-001',
       'Synthetic Patient Site', 'SCREENING_SITE', 'MOBILE', $3, $3)`,
    [canonicalLocationId, organizationId, timestamp],
  );
  await pool.query(
    `INSERT INTO desktop_installations (
       id, organization_id, configured_location_id, deployment_name, timezone,
       status, enrolled_at, created_at, updated_at
     ) VALUES ($1, $2, $3, 'Synthetic Patient Desktop', 'Africa/Douala',
       'ACTIVE', $4, $4, $4)`,
    [installationId, organizationId, canonicalLocationId, timestamp],
  );
  await pool.query(
    `INSERT INTO location_source_links (
       id, location_id, installation_id, organization_id, source_location_id,
       first_observed_at, last_observed_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $6)`,
    [
      '31000000-0000-4000-8000-000000000001',
      canonicalLocationId,
      installationId,
      organizationId,
      sourceLocationId,
      timestamp,
    ],
  );
  await pool.query(
    `INSERT INTO desktop_installation_credentials (
       id, installation_id, token_prefix, token_hash, label, status,
       issued_at, created_at, updated_at
     ) VALUES ($1, $2, 'chs_inst_v1_AAAAAAAA', $3, 'Synthetic patient token',
       'ACTIVE', $4, $4, $4)`,
    [
      '21000000-0000-4000-8000-000000000001',
      installationId,
      installationTokenHash(`chs_inst_v1_${'A'.repeat(43)}`),
      timestamp,
    ],
  );
}
