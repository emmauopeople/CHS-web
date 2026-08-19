import type { Pool, PoolClient } from 'pg';

import { CHS_MEDICAL_ID_SYSTEM, CHS_MEDICAL_ID_TYPE } from '../sync/medical-id.js';
import { normalizeIdentityName } from '../sync/patient-identity-normalization.js';

type QueryDatabase = Pick<Pool, 'connect'>;

export type PersonStatus = 'ACTIVE' | 'INACTIVE' | 'DECEASED';

export type PatientAccessScope =
  | Readonly<{ kind: 'GLOBAL' }>
  | Readonly<{
      kind: 'ORGANIZATIONS';
      organizationIds: readonly string[];
    }>;

export type PatientListQuery = Readonly<{
  search?: string;
  dateOfBirth?: string;
  status?: PersonStatus | 'ALL';
  page?: number;
  pageSize?: number;
}>;

export type PatientHistoryQuery = Readonly<{
  page?: number;
  pageSize?: number;
}>;

export type PatientListItem = Readonly<{
  personId: string;
  chsMedicalId: string;
  displayName: string;
  dateOfBirth: string | null;
  approximateAgeYears: number | null;
  ageAsOfDate: string | null;
  sex: 'FEMALE' | 'MALE' | 'OTHER' | 'UNKNOWN';
  status: PersonStatus;
  village: string | null;
  quarter: string | null;
  lastScreeningAt: string | null;
  lastScreeningStatus: 'DRAFT' | 'COMPLETED' | 'AMENDED' | null;
  lastLocationName: string | null;
}>;

export type PatientListPage = Readonly<{
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  items: readonly PatientListItem[];
}>;

export type VitalReadingView = Readonly<{
  readingId: string;
  sequenceNumber: number;
  systolicMmhg: number | null;
  diastolicMmhg: number | null;
  pulseBpm: number | null;
  measurementSite: 'RIGHT_ARM' | 'LEFT_ARM' | 'LEFT_LEG' | 'RIGHT_LEG' | null;
  patientPosition: 'LYING' | 'STANDING' | 'SITTING' | null;
  measurementLocalDate: string;
  measurementLocalTime: string | null;
  measurementTimezone: string;
  measuredAt: string | null;
}>;

export type PatientScreeningView = Readonly<{
  encounterId: string;
  status: 'DRAFT' | 'COMPLETED' | 'AMENDED';
  startedAt: string;
  completedAt: string | null;
  sessionDate: string;
  organizationName: string;
  locationName: string;
  protocolKey: string;
  protocolVersionLabel: string;
  recordedByPractitionerName: string;
  amendmentOfEncounterId: string | null;
  amendmentReason: string | null;
  vitals: null | Readonly<{
    vitalSetId: string;
    status: 'DRAFT' | 'VITALS_COMPLETE';
    weightKg: number | null;
    waistCm: number | null;
    notes: string | null;
    recordedByPractitionerName: string;
    readings: readonly VitalReadingView[];
  }>;
}>;

export type PatientDetail = Readonly<{
  personId: string;
  chsMedicalId: string;
  displayName: string;
  givenName: string | null;
  familyName: string | null;
  otherNames: string | null;
  dateOfBirth: string | null;
  approximateAgeYears: number | null;
  ageAsOfDate: string | null;
  sex: 'FEMALE' | 'MALE' | 'OTHER' | 'UNKNOWN';
  phone: string | null;
  alternateContactName: string | null;
  alternateContactPhone: string | null;
  village: string | null;
  quarter: string | null;
  residenceNotes: string | null;
  status: PersonStatus;
  screeningHistory: Readonly<{
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
    items: readonly PatientScreeningView[];
  }>;
}>;

export type PatientQueryErrorCode =
  | 'INVALID_ACCESS_SCOPE'
  | 'INVALID_DATE_OF_BIRTH'
  | 'INVALID_PAGE'
  | 'INVALID_PAGE_SIZE'
  | 'INVALID_PATIENT_ID'
  | 'INVALID_PATIENT_STATUS'
  | 'INVALID_SEARCH';

export class PatientQueryError extends Error {
  constructor(readonly code: PatientQueryErrorCode) {
    super('Canonical patient query is invalid');
    this.name = 'PatientQueryError';
  }
}

type PreparedScope = Readonly<{
  global: boolean;
  organizationIds: readonly string[];
}>;

type PreparedPagination = Readonly<{
  page: number;
  pageSize: number;
  offset: number;
}>;

type PatientRow = Readonly<{
  person_id: string;
  chs_medical_id: string;
  display_name: string;
  given_name: string | null;
  family_name: string | null;
  other_names: string | null;
  date_of_birth: string | null;
  approximate_age_years: number | null;
  age_as_of_date: string | null;
  sex: PatientDetail['sex'];
  phone: string | null;
  alternate_contact_name: string | null;
  alternate_contact_phone: string | null;
  village: string | null;
  quarter: string | null;
  residence_notes: string | null;
  status: PersonStatus;
}>;

type PatientListRow = PatientRow &
  Readonly<{
    last_screening_at: Date | null;
    last_screening_status: PatientListItem['lastScreeningStatus'];
    last_location_name: string | null;
  }>;

type ScreeningRow = Readonly<{
  encounter_id: string;
  encounter_status: PatientScreeningView['status'];
  started_at: Date;
  completed_at: Date | null;
  session_date: string;
  organization_name: string;
  location_name: string;
  protocol_key: string;
  protocol_version_label: string;
  encounter_practitioner_name: string;
  amendment_of_encounter_id: string | null;
  amendment_reason: string | null;
  vital_set_id: string | null;
  vital_status: 'DRAFT' | 'VITALS_COMPLETE' | null;
  weight_kg: number | null;
  waist_cm: number | null;
  vital_notes: string | null;
  vital_practitioner_name: string | null;
}>;

type ReadingRow = Readonly<{
  vital_set_id: string;
  reading_id: string;
  sequence_number: number;
  systolic_mmhg: number | null;
  diastolic_mmhg: number | null;
  pulse_bpm: number | null;
  measurement_site: VitalReadingView['measurementSite'];
  patient_position: VitalReadingView['patientPosition'];
  measurement_local_date: string;
  measurement_local_time: string | null;
  measurement_timezone: string;
  measured_at: Date | null;
}>;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const localDatePattern = /^\d{4}-\d{2}-\d{2}$/;

function prepareScope(scope: PatientAccessScope): PreparedScope {
  if (scope.kind === 'GLOBAL') return { global: true, organizationIds: [] };
  const organizationIds = [...new Set(scope.organizationIds)];
  if (
    organizationIds.length === 0 ||
    organizationIds.some((organizationId) => !uuidPattern.test(organizationId))
  ) {
    throw new PatientQueryError('INVALID_ACCESS_SCOPE');
  }
  return { global: false, organizationIds };
}

function preparePagination(
  query: PatientHistoryQuery,
  defaultPageSize: number,
): PreparedPagination {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? defaultPageSize;
  if (!Number.isSafeInteger(page) || page < 1 || page > 10_000) {
    throw new PatientQueryError('INVALID_PAGE');
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new PatientQueryError('INVALID_PAGE_SIZE');
  }
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function validLocalDate(value: string): boolean {
  if (!localDatePattern.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const normalized = new Date(Date.UTC(year!, month! - 1, day));
  return (
    normalized.getUTCFullYear() === year &&
    normalized.getUTCMonth() + 1 === month &&
    normalized.getUTCDate() === day
  );
}

function prepareListQuery(query: PatientListQuery) {
  const pagination = preparePagination(query, 25);
  const status = query.status ?? 'ACTIVE';
  if (!['ACTIVE', 'INACTIVE', 'DECEASED', 'ALL'].includes(status)) {
    throw new PatientQueryError('INVALID_PATIENT_STATUS');
  }
  const rawSearch = query.search?.trim() || null;
  if (rawSearch !== null && rawSearch.length > 120) {
    throw new PatientQueryError('INVALID_SEARCH');
  }
  const medicalId = rawSearch && /^chs-/i.test(rawSearch) ? rawSearch.toUpperCase() : null;
  const normalizedName = rawSearch && medicalId === null
    ? normalizeIdentityName(rawSearch)
    : null;
  if (rawSearch !== null && medicalId === null && !normalizedName) {
    throw new PatientQueryError('INVALID_SEARCH');
  }
  const dateOfBirth = query.dateOfBirth ?? null;
  if (dateOfBirth !== null && !validLocalDate(dateOfBirth)) {
    throw new PatientQueryError('INVALID_DATE_OF_BIRTH');
  }
  return { ...pagination, status, medicalId, normalizedName, dateOfBirth };
}

function toTimestamp(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function totalPages(totalItems: number, pageSize: number): number {
  return totalItems === 0 ? 0 : Math.ceil(totalItems / pageSize);
}

function personEligibilitySql(alias: string): string {
  return `(
    $1::boolean
    OR EXISTS (
      SELECT 1
      FROM patient_source_links scope_link
      JOIN desktop_installations scope_installation
        ON scope_installation.id = scope_link.installation_id
      WHERE scope_link.person_id = ${alias}.id
        AND scope_installation.organization_id = ANY($2::uuid[])
    )
  )`;
}

async function beginReadTransaction(client: PoolClient) {
  await client.query(
    'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
  );
}

export async function listCanonicalPatients(
  database: QueryDatabase,
  scope: PatientAccessScope,
  query: PatientListQuery = {},
): Promise<PatientListPage> {
  const preparedScope = prepareScope(scope);
  const prepared = prepareListQuery(query);
  const client = await database.connect();

  try {
    await beginReadTransaction(client);
    const parameters = [
      preparedScope.global,
      preparedScope.organizationIds,
      CHS_MEDICAL_ID_SYSTEM,
      CHS_MEDICAL_ID_TYPE,
      prepared.status,
      prepared.medicalId,
      prepared.normalizedName,
      prepared.dateOfBirth,
    ];
    const filters = `${personEligibilitySql('p')}
      AND ($5::text = 'ALL' OR p.status = $5)
      AND ($6::text IS NULL OR medical_id.identifier_value = $6)
      AND ($7::text IS NULL OR p.name_normalized LIKE $7 || '%')
      AND ($8::date IS NULL OR p.date_of_birth = $8)`;
    const countResult = await client.query<{ total: number }>(
      `SELECT count(*)::integer AS total
       FROM persons p
       JOIN person_identifiers medical_id
         ON medical_id.person_id = p.id
        AND medical_id.identifier_system = $3
        AND medical_id.identifier_type_code = $4
        AND medical_id.status = 'ACTIVE'
        AND medical_id.is_primary = true
       WHERE ${filters}`,
      parameters,
    );
    const totalItems = countResult.rows[0]?.total ?? 0;
    const rows = await client.query<PatientListRow>(
      `SELECT
         p.id AS person_id,
         medical_id.identifier_value AS chs_medical_id,
         p.display_name,
         p.given_name,
         p.family_name,
         p.other_names,
         to_char(p.date_of_birth, 'YYYY-MM-DD') AS date_of_birth,
         p.approximate_age_years,
         to_char(p.age_as_of_date, 'YYYY-MM-DD') AS age_as_of_date,
         p.sex,
         p.phone,
         p.alternate_contact_name,
         p.alternate_contact_phone,
         p.village,
         p.quarter,
         p.residence_notes,
         p.status,
         latest.started_at AS last_screening_at,
         latest.status AS last_screening_status,
         latest.location_name AS last_location_name
       FROM persons p
       JOIN person_identifiers medical_id
         ON medical_id.person_id = p.id
        AND medical_id.identifier_system = $3
        AND medical_id.identifier_type_code = $4
        AND medical_id.status = 'ACTIVE'
        AND medical_id.is_primary = true
       LEFT JOIN LATERAL (
         SELECT encounter.started_at, encounter.status, location.name AS location_name
         FROM screening_encounters encounter
         JOIN locations location ON location.id = encounter.location_id
         WHERE encounter.person_id = p.id
           AND encounter.status <> 'VOID'
           AND ($1::boolean OR encounter.organization_id = ANY($2::uuid[]))
         ORDER BY encounter.started_at DESC, encounter.id DESC
         LIMIT 1
       ) latest ON true
       WHERE ${filters}
       ORDER BY p.name_normalized, p.id
       LIMIT $9 OFFSET $10`,
      [...parameters, prepared.pageSize, prepared.offset],
    );
    await client.query('COMMIT');

    return {
      page: prepared.page,
      pageSize: prepared.pageSize,
      totalItems,
      totalPages: totalPages(totalItems, prepared.pageSize),
      items: rows.rows.map((row) => ({
        personId: row.person_id,
        chsMedicalId: row.chs_medical_id,
        displayName: row.display_name,
        dateOfBirth: row.date_of_birth,
        approximateAgeYears: row.approximate_age_years,
        ageAsOfDate: row.age_as_of_date,
        sex: row.sex,
        status: row.status,
        village: row.village,
        quarter: row.quarter,
        lastScreeningAt: toTimestamp(row.last_screening_at),
        lastScreeningStatus: row.last_screening_status,
        lastLocationName: row.last_location_name,
      })),
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function patientDetailFromRow(row: PatientRow) {
  return {
    personId: row.person_id,
    chsMedicalId: row.chs_medical_id,
    displayName: row.display_name,
    givenName: row.given_name,
    familyName: row.family_name,
    otherNames: row.other_names,
    dateOfBirth: row.date_of_birth,
    approximateAgeYears: row.approximate_age_years,
    ageAsOfDate: row.age_as_of_date,
    sex: row.sex,
    phone: row.phone,
    alternateContactName: row.alternate_contact_name,
    alternateContactPhone: row.alternate_contact_phone,
    village: row.village,
    quarter: row.quarter,
    residenceNotes: row.residence_notes,
    status: row.status,
  } as const;
}

export async function getCanonicalPatientDetail(
  database: QueryDatabase,
  scope: PatientAccessScope,
  personId: string,
  historyQuery: PatientHistoryQuery = {},
): Promise<PatientDetail | null> {
  if (!uuidPattern.test(personId)) {
    throw new PatientQueryError('INVALID_PATIENT_ID');
  }
  const preparedScope = prepareScope(scope);
  const pagination = preparePagination(historyQuery, 20);
  const client = await database.connect();

  try {
    await beginReadTransaction(client);
    const scopeParameters = [
      preparedScope.global,
      preparedScope.organizationIds,
      CHS_MEDICAL_ID_SYSTEM,
      CHS_MEDICAL_ID_TYPE,
      personId,
    ];
    const personResult = await client.query<PatientRow>(
      `SELECT
         p.id AS person_id,
         medical_id.identifier_value AS chs_medical_id,
         p.display_name,
         p.given_name,
         p.family_name,
         p.other_names,
         to_char(p.date_of_birth, 'YYYY-MM-DD') AS date_of_birth,
         p.approximate_age_years,
         to_char(p.age_as_of_date, 'YYYY-MM-DD') AS age_as_of_date,
         p.sex,
         p.phone,
         p.alternate_contact_name,
         p.alternate_contact_phone,
         p.village,
         p.quarter,
         p.residence_notes,
         p.status
       FROM persons p
       JOIN person_identifiers medical_id
         ON medical_id.person_id = p.id
        AND medical_id.identifier_system = $3
        AND medical_id.identifier_type_code = $4
        AND medical_id.status = 'ACTIVE'
        AND medical_id.is_primary = true
       WHERE p.id = $5 AND ${personEligibilitySql('p')}`,
      scopeParameters,
    );
    const person = personResult.rows[0];
    if (!person) {
      await client.query('COMMIT');
      return null;
    }

    const encounterScope = `person_id = $3
      AND status <> 'VOID'
      AND ($1::boolean OR organization_id = ANY($2::uuid[]))`;
    const historyParameters = [
      preparedScope.global,
      preparedScope.organizationIds,
      personId,
    ];
    const countResult = await client.query<{ total: number }>(
      `SELECT count(*)::integer AS total
       FROM screening_encounters
       WHERE ${encounterScope}`,
      historyParameters,
    );
    const historyTotal = countResult.rows[0]?.total ?? 0;
    const screeningResult = await client.query<ScreeningRow>(
      `SELECT
         encounter.id AS encounter_id,
         encounter.status AS encounter_status,
         encounter.started_at,
         encounter.completed_at,
         to_char(session.session_date, 'YYYY-MM-DD') AS session_date,
         organization.name AS organization_name,
         location.name AS location_name,
         protocol.protocol_key,
         protocol.version_label AS protocol_version_label,
         encounter_practitioner.display_name AS encounter_practitioner_name,
         encounter.amendment_of_encounter_id,
         encounter.amendment_reason,
         vital_set.id AS vital_set_id,
         vital_set.status AS vital_status,
         vital_set.weight_kg::double precision AS weight_kg,
         vital_set.waist_cm::double precision AS waist_cm,
         vital_set.notes AS vital_notes,
         vital_practitioner.display_name AS vital_practitioner_name
       FROM screening_encounters encounter
       JOIN screening_sessions session ON session.id = encounter.screening_session_id
       JOIN organizations organization ON organization.id = encounter.organization_id
       JOIN locations location ON location.id = encounter.location_id
       JOIN screening_protocols protocol ON protocol.id = encounter.protocol_id
       JOIN practitioners encounter_practitioner
         ON encounter_practitioner.id = encounter.recorded_by_practitioner_id
       LEFT JOIN screening_vital_sets vital_set ON vital_set.encounter_id = encounter.id
       LEFT JOIN practitioners vital_practitioner
         ON vital_practitioner.id = vital_set.recorded_by_practitioner_id
       WHERE encounter.person_id = $3
         AND encounter.status <> 'VOID'
         AND ($1::boolean OR encounter.organization_id = ANY($2::uuid[]))
       ORDER BY encounter.started_at DESC, encounter.id DESC
       LIMIT $4 OFFSET $5`,
      [...historyParameters, pagination.pageSize, pagination.offset],
    );
    const vitalSetIds = screeningResult.rows.flatMap((row) =>
      row.vital_set_id ? [row.vital_set_id] : [],
    );
    const readingResult = vitalSetIds.length === 0
      ? { rows: [] as ReadingRow[] }
      : await client.query<ReadingRow>(
          `SELECT
             vital_set_id,
             id AS reading_id,
             sequence_number,
             systolic_mmhg,
             diastolic_mmhg,
             pulse_bpm,
             measurement_site,
             patient_position,
             to_char(measurement_local_date, 'YYYY-MM-DD') AS measurement_local_date,
             CASE
               WHEN measurement_local_time IS NULL THEN NULL
               ELSE to_char(measurement_local_time, 'HH24:MI')
             END AS measurement_local_time,
             measurement_timezone,
             measured_at
           FROM vital_readings
           WHERE vital_set_id = ANY($1::uuid[])
           ORDER BY vital_set_id, sequence_number`,
          [vitalSetIds],
        );
    await client.query('COMMIT');

    const readingsBySet = new Map<string, VitalReadingView[]>();
    for (const row of readingResult.rows) {
      const readings = readingsBySet.get(row.vital_set_id) ?? [];
      readings.push({
        readingId: row.reading_id,
        sequenceNumber: row.sequence_number,
        systolicMmhg: row.systolic_mmhg,
        diastolicMmhg: row.diastolic_mmhg,
        pulseBpm: row.pulse_bpm,
        measurementSite: row.measurement_site,
        patientPosition: row.patient_position,
        measurementLocalDate: row.measurement_local_date,
        measurementLocalTime: row.measurement_local_time,
        measurementTimezone: row.measurement_timezone,
        measuredAt: toTimestamp(row.measured_at),
      });
      readingsBySet.set(row.vital_set_id, readings);
    }

    return {
      ...patientDetailFromRow(person),
      screeningHistory: {
        page: pagination.page,
        pageSize: pagination.pageSize,
        totalItems: historyTotal,
        totalPages: totalPages(historyTotal, pagination.pageSize),
        items: screeningResult.rows.map((row) => ({
          encounterId: row.encounter_id,
          status: row.encounter_status,
          startedAt: row.started_at.toISOString(),
          completedAt: toTimestamp(row.completed_at),
          sessionDate: row.session_date,
          organizationName: row.organization_name,
          locationName: row.location_name,
          protocolKey: row.protocol_key,
          protocolVersionLabel: row.protocol_version_label,
          recordedByPractitionerName: row.encounter_practitioner_name,
          amendmentOfEncounterId: row.amendment_of_encounter_id,
          amendmentReason: row.amendment_reason,
          vitals:
            row.vital_set_id && row.vital_status && row.vital_practitioner_name
              ? {
                  vitalSetId: row.vital_set_id,
                  status: row.vital_status,
                  weightKg: row.weight_kg,
                  waistCm: row.waist_cm,
                  notes: row.vital_notes,
                  recordedByPractitionerName: row.vital_practitioner_name,
                  readings: readingsBySet.get(row.vital_set_id) ?? [],
                }
              : null,
        })),
      },
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
