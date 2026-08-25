import type { Pool, PoolClient } from 'pg';

import { CHS_MEDICAL_ID_SYSTEM, CHS_MEDICAL_ID_TYPE } from '../sync/medical-id.js';
import { normalizeIdentityName } from '../sync/patient-identity-normalization.js';
import type {
  LifestyleAlcoholBaseline,
  LifestyleAlcoholWeekly,
  LifestyleBeverageType,
  LifestyleOtherActivity,
  LifestylePayload,
  LifestylePhysicalActivity,
  LifestylePhysicalActivityWeekly,
  LifestyleTobaccoBaseline,
  LifestyleTobaccoProduct,
  LifestyleTobaccoWeekly,
  LifestyleWorkBaseline,
  LifestyleWorkWeekly,
} from '../sync/types.js';

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

export type LifestyleAssessmentView = Readonly<{
  lifestyleAssessmentId: string;
  status: 'COMPLETE';
  periodStart: string;
  periodEnd: string;
  completedAt: string;
  recordedByPractitionerName: string;
  baselines: Readonly<{
    alcohol: Readonly<{
      baselineId: string;
      version: number;
      status: LifestyleAlcoholBaseline['status'];
      everConsumed: LifestyleAlcoholBaseline['everConsumed'];
      consumedPast12Months: LifestyleAlcoholBaseline['consumedPast12Months'];
      commonBeverageTypes: readonly LifestyleBeverageType[];
      otherBeverageDescription: string | null;
    }>;
    tobacco: Readonly<{
      baselineId: string;
      version: number;
      status: LifestyleTobaccoBaseline['status'];
      everRegularlyUsed: LifestyleTobaccoBaseline['everRegularlyUsed'];
      formerUseApproximateStopDate: string | null;
      currentUseFrequency: LifestyleTobaccoBaseline['currentUseFrequency'];
      productTypes: readonly LifestyleTobaccoProduct['productType'][];
      otherProductDescription: string | null;
    }>;
    work: Readonly<{
      baselineId: string;
      version: number;
      status: LifestyleWorkBaseline['status'];
      occupationJobTitle: string | null;
      usualPhysicalDemand: LifestyleWorkBaseline['usualPhysicalDemand'];
      typicalWorkdaysPerWeek: number | null;
      typicalHoursPerWorkday: number | null;
      shiftPattern: LifestyleWorkBaseline['shiftPattern'];
      description: string | null;
    }>;
  }>;
  alcohol: Readonly<{
    weeklyResponse: LifestyleAlcoholWeekly['weeklyResponse'];
    drinkingDays: number | null;
    totalStandardizedDrinks: number | null;
    largestOneDayAmount: number | null;
    daysAtLargestAmount: number | null;
    commonBeverageTypes: readonly LifestyleBeverageType[];
    otherBeverageDescription: string | null;
  }>;
  tobacco: Readonly<{
    weeklyResponse: LifestyleTobaccoWeekly['weeklyResponse'];
    products: readonly Readonly<{
      productId: string;
      sequenceNumber: number;
      productType: LifestyleTobaccoProduct['productType'];
      daysUsed: number;
      averageQuantityPerUseDay: number;
      unit: LifestyleTobaccoProduct['unit'];
      secondhandSmokeExposure: boolean | null;
      otherProductDescription: string | null;
      otherUnitDescription: string | null;
    }>[];
  }>;
  physicalActivity: Readonly<{
    weeklyResponse: LifestylePhysicalActivityWeekly['weeklyResponse'];
    sedentaryTimeResponse: LifestylePhysicalActivityWeekly['sedentaryTimeResponse'];
    sedentaryMinutesPerDay: number | null;
    activities: readonly Readonly<{
      activityId: string;
      sequenceNumber: number;
      activityDomain: LifestylePhysicalActivity['activityDomain'];
      description: string | null;
      intensity: LifestylePhysicalActivity['intensity'];
      daysInPastSevenDays: number;
      averageMinutesPerActiveDay: number;
    }>[];
  }>;
  work: Readonly<{
    weeklyResponse: LifestyleWorkWeekly['weeklyResponse'];
  }>;
  otherActivity: Readonly<{
    weeklyResponse: LifestylePayload['otherActivity']['weeklyResponse'];
    activities: readonly Readonly<{
      activityId: string;
      sequenceNumber: number;
      category: LifestyleOtherActivity['category'];
      description: string | null;
      daysInPastSevenDays: number;
      averageMinutesPerDay: number;
      intensity: LifestyleOtherActivity['intensity'];
    }>[];
  }>;
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
  lifestyle: LifestyleAssessmentView | null;
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

type LifestyleRow = Readonly<{
  encounter_id: string;
  lifestyle_assessment_id: string;
  lifestyle_status: 'COMPLETE';
  period_start: string;
  period_end: string;
  completed_at: Date;
  lifestyle_practitioner_name: string;
  alcohol_baseline_id: string;
  alcohol_baseline_version: number;
  alcohol_baseline_status: LifestyleAlcoholBaseline['status'];
  alcohol_ever_consumed: LifestyleAlcoholBaseline['everConsumed'];
  alcohol_consumed_past_12_months: LifestyleAlcoholBaseline['consumedPast12Months'];
  alcohol_baseline_beverage_types: LifestyleBeverageType[];
  alcohol_baseline_other_description: string | null;
  tobacco_baseline_id: string;
  tobacco_baseline_version: number;
  tobacco_baseline_status: LifestyleTobaccoBaseline['status'];
  tobacco_ever_regularly_used: LifestyleTobaccoBaseline['everRegularlyUsed'];
  tobacco_former_stop_date: string | null;
  tobacco_current_use_frequency: LifestyleTobaccoBaseline['currentUseFrequency'];
  tobacco_baseline_product_types: LifestyleTobaccoProduct['productType'][];
  tobacco_baseline_other_description: string | null;
  work_baseline_id: string;
  work_baseline_version: number;
  work_baseline_status: LifestyleWorkBaseline['status'];
  occupation_job_title: string | null;
  usual_physical_demand: LifestyleWorkBaseline['usualPhysicalDemand'];
  typical_workdays_per_week: number | null;
  typical_hours_per_workday: number | null;
  shift_pattern: LifestyleWorkBaseline['shiftPattern'];
  work_baseline_description: string | null;
  alcohol_weekly_response: LifestyleAlcoholWeekly['weeklyResponse'];
  drinking_days: number | null;
  total_standardized_drinks: number | null;
  largest_one_day_amount: number | null;
  days_at_largest_amount: number | null;
  alcohol_weekly_beverage_types: LifestyleBeverageType[];
  alcohol_weekly_other_description: string | null;
  tobacco_weekly_response: LifestyleTobaccoWeekly['weeklyResponse'];
  physical_weekly_response: LifestylePhysicalActivityWeekly['weeklyResponse'];
  sedentary_time_response: LifestylePhysicalActivityWeekly['sedentaryTimeResponse'];
  sedentary_minutes_per_day: number | null;
  work_weekly_response: LifestyleWorkWeekly['weeklyResponse'];
  other_activity_weekly_response: LifestylePayload['otherActivity']['weeklyResponse'];
}>;

type LifestyleTobaccoProductRow = Readonly<{
  lifestyle_assessment_id: string;
  product_id: string;
  sequence_number: number;
  product_type: LifestyleTobaccoProduct['productType'];
  days_used: number;
  average_quantity_per_use_day: number;
  unit: LifestyleTobaccoProduct['unit'];
  secondhand_smoke_exposure: boolean | null;
  other_product_description: string | null;
  other_unit_description: string | null;
}>;

type LifestylePhysicalActivityRow = Readonly<{
  lifestyle_assessment_id: string;
  activity_id: string;
  sequence_number: number;
  activity_domain: LifestylePhysicalActivity['activityDomain'];
  description: string | null;
  intensity: LifestylePhysicalActivity['intensity'];
  days_in_past_seven_days: number;
  average_minutes_per_active_day: number;
}>;

type LifestyleOtherActivityRow = Readonly<{
  lifestyle_assessment_id: string;
  activity_id: string;
  sequence_number: number;
  category: LifestyleOtherActivity['category'];
  description: string | null;
  days_in_past_seven_days: number;
  average_minutes_per_day: number;
  intensity: LifestyleOtherActivity['intensity'];
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
    const encounterIds = screeningResult.rows.map((row) => row.encounter_id);
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
    const lifestyleResult = encounterIds.length === 0
      ? { rows: [] as LifestyleRow[] }
      : await client.query<LifestyleRow>(
          `SELECT
             assessment.encounter_id,
             assessment.id AS lifestyle_assessment_id,
             assessment.status AS lifestyle_status,
             to_char(assessment.period_start, 'YYYY-MM-DD') AS period_start,
             to_char(assessment.period_end, 'YYYY-MM-DD') AS period_end,
             assessment.source_updated_at AS completed_at,
             lifestyle_practitioner.display_name AS lifestyle_practitioner_name,
             alcohol_baseline.id AS alcohol_baseline_id,
             alcohol_baseline.source_version AS alcohol_baseline_version,
             alcohol_baseline.status AS alcohol_baseline_status,
             alcohol_baseline.ever_consumed AS alcohol_ever_consumed,
             alcohol_baseline.consumed_past_12_months AS alcohol_consumed_past_12_months,
             ARRAY(
               SELECT beverage.beverage_type
               FROM lifestyle_alcohol_baseline_beverages beverage
               WHERE beverage.baseline_id = alcohol_baseline.id
               ORDER BY beverage.beverage_type
             ) AS alcohol_baseline_beverage_types,
             alcohol_baseline.other_beverage_description
               AS alcohol_baseline_other_description,
             tobacco_baseline.id AS tobacco_baseline_id,
             tobacco_baseline.source_version AS tobacco_baseline_version,
             tobacco_baseline.status AS tobacco_baseline_status,
             tobacco_baseline.ever_regularly_used AS tobacco_ever_regularly_used,
             tobacco_baseline.former_use_approximate_stop_date
               AS tobacco_former_stop_date,
             tobacco_baseline.current_use_frequency
               AS tobacco_current_use_frequency,
             ARRAY(
               SELECT product.product_type
               FROM lifestyle_tobacco_baseline_products product
               WHERE product.baseline_id = tobacco_baseline.id
               ORDER BY product.product_type
             ) AS tobacco_baseline_product_types,
             tobacco_baseline.other_product_description
               AS tobacco_baseline_other_description,
             work_baseline.id AS work_baseline_id,
             work_baseline.source_version AS work_baseline_version,
             work_baseline.status AS work_baseline_status,
             work_baseline.occupation_job_title,
             work_baseline.usual_physical_demand,
             work_baseline.typical_workdays_per_week,
             work_baseline.typical_hours_per_workday::double precision
               AS typical_hours_per_workday,
             work_baseline.shift_pattern,
             work_baseline.description AS work_baseline_description,
             alcohol_weekly.weekly_response AS alcohol_weekly_response,
             alcohol_weekly.drinking_days,
             alcohol_weekly.total_standardized_drinks::double precision
               AS total_standardized_drinks,
             alcohol_weekly.largest_one_day_amount::double precision
               AS largest_one_day_amount,
             alcohol_weekly.days_at_largest_amount,
             ARRAY(
               SELECT beverage.beverage_type
               FROM lifestyle_alcohol_weekly_beverages beverage
               WHERE beverage.lifestyle_assessment_id = assessment.id
               ORDER BY beverage.beverage_type
             ) AS alcohol_weekly_beverage_types,
             alcohol_weekly.other_beverage_description
               AS alcohol_weekly_other_description,
             tobacco_weekly.weekly_response AS tobacco_weekly_response,
             physical_weekly.weekly_response AS physical_weekly_response,
             physical_weekly.sedentary_time_response,
             physical_weekly.sedentary_minutes_per_day,
             work_weekly.weekly_response AS work_weekly_response,
             other_weekly.weekly_response AS other_activity_weekly_response
           FROM lifestyle_assessments assessment
           JOIN practitioners lifestyle_practitioner
             ON lifestyle_practitioner.id = assessment.updated_by_practitioner_id
           JOIN lifestyle_alcohol_baselines alcohol_baseline
             ON alcohol_baseline.id = assessment.alcohol_baseline_id
           JOIN lifestyle_tobacco_baselines tobacco_baseline
             ON tobacco_baseline.id = assessment.tobacco_baseline_id
           JOIN lifestyle_work_baselines work_baseline
             ON work_baseline.id = assessment.work_baseline_id
           JOIN lifestyle_alcohol_weekly alcohol_weekly
             ON alcohol_weekly.lifestyle_assessment_id = assessment.id
           JOIN lifestyle_tobacco_weekly tobacco_weekly
             ON tobacco_weekly.lifestyle_assessment_id = assessment.id
           JOIN lifestyle_physical_activity_weekly physical_weekly
             ON physical_weekly.lifestyle_assessment_id = assessment.id
           JOIN lifestyle_work_weekly work_weekly
             ON work_weekly.lifestyle_assessment_id = assessment.id
           JOIN lifestyle_other_activity_weekly other_weekly
             ON other_weekly.lifestyle_assessment_id = assessment.id
           WHERE assessment.encounter_id = ANY($1::uuid[])
             AND assessment.person_id = $2
             AND assessment.status = 'COMPLETE'
           ORDER BY assessment.encounter_id`,
          [encounterIds, personId],
        );
    const lifestyleIds = lifestyleResult.rows.map(
      (row) => row.lifestyle_assessment_id,
    );
    const tobaccoProductResult = lifestyleIds.length === 0
      ? { rows: [] as LifestyleTobaccoProductRow[] }
      : await client.query<LifestyleTobaccoProductRow>(
          `SELECT
             lifestyle_assessment_id,
             id AS product_id,
             sequence_number,
             product_type,
             days_used,
             average_quantity_per_use_day::double precision
               AS average_quantity_per_use_day,
             unit,
             secondhand_smoke_exposure,
             other_product_description,
             other_unit_description
           FROM lifestyle_tobacco_products
           WHERE lifestyle_assessment_id = ANY($1::uuid[])
           ORDER BY lifestyle_assessment_id, sequence_number`,
          [lifestyleIds],
        );
    const physicalActivityResult = lifestyleIds.length === 0
      ? { rows: [] as LifestylePhysicalActivityRow[] }
      : await client.query<LifestylePhysicalActivityRow>(
          `SELECT
             lifestyle_assessment_id,
             id AS activity_id,
             sequence_number,
             activity_domain,
             description,
             intensity,
             days_in_past_seven_days,
             average_minutes_per_active_day
           FROM lifestyle_physical_activities
           WHERE lifestyle_assessment_id = ANY($1::uuid[])
           ORDER BY lifestyle_assessment_id, sequence_number`,
          [lifestyleIds],
        );
    const otherActivityResult = lifestyleIds.length === 0
      ? { rows: [] as LifestyleOtherActivityRow[] }
      : await client.query<LifestyleOtherActivityRow>(
          `SELECT
             lifestyle_assessment_id,
             id AS activity_id,
             sequence_number,
             category,
             description,
             days_in_past_seven_days,
             average_minutes_per_day,
             intensity
           FROM lifestyle_other_activities
           WHERE lifestyle_assessment_id = ANY($1::uuid[])
           ORDER BY lifestyle_assessment_id, sequence_number`,
          [lifestyleIds],
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

    const tobaccoProductsByLifestyle = new Map<
      string,
      LifestyleAssessmentView['tobacco']['products'][number][]
    >();
    for (const row of tobaccoProductResult.rows) {
      const products =
        tobaccoProductsByLifestyle.get(row.lifestyle_assessment_id) ?? [];
      products.push({
        productId: row.product_id,
        sequenceNumber: row.sequence_number,
        productType: row.product_type,
        daysUsed: row.days_used,
        averageQuantityPerUseDay: row.average_quantity_per_use_day,
        unit: row.unit,
        secondhandSmokeExposure: row.secondhand_smoke_exposure,
        otherProductDescription: row.other_product_description,
        otherUnitDescription: row.other_unit_description,
      });
      tobaccoProductsByLifestyle.set(row.lifestyle_assessment_id, products);
    }

    const physicalActivitiesByLifestyle = new Map<
      string,
      LifestyleAssessmentView['physicalActivity']['activities'][number][]
    >();
    for (const row of physicalActivityResult.rows) {
      const activities =
        physicalActivitiesByLifestyle.get(row.lifestyle_assessment_id) ?? [];
      activities.push({
        activityId: row.activity_id,
        sequenceNumber: row.sequence_number,
        activityDomain: row.activity_domain,
        description: row.description,
        intensity: row.intensity,
        daysInPastSevenDays: row.days_in_past_seven_days,
        averageMinutesPerActiveDay: row.average_minutes_per_active_day,
      });
      physicalActivitiesByLifestyle.set(row.lifestyle_assessment_id, activities);
    }

    const otherActivitiesByLifestyle = new Map<
      string,
      LifestyleAssessmentView['otherActivity']['activities'][number][]
    >();
    for (const row of otherActivityResult.rows) {
      const activities =
        otherActivitiesByLifestyle.get(row.lifestyle_assessment_id) ?? [];
      activities.push({
        activityId: row.activity_id,
        sequenceNumber: row.sequence_number,
        category: row.category,
        description: row.description,
        daysInPastSevenDays: row.days_in_past_seven_days,
        averageMinutesPerDay: row.average_minutes_per_day,
        intensity: row.intensity,
      });
      otherActivitiesByLifestyle.set(row.lifestyle_assessment_id, activities);
    }

    const lifestylesByEncounter = new Map<string, LifestyleAssessmentView>();
    for (const row of lifestyleResult.rows) {
      lifestylesByEncounter.set(row.encounter_id, {
        lifestyleAssessmentId: row.lifestyle_assessment_id,
        status: row.lifestyle_status,
        periodStart: row.period_start,
        periodEnd: row.period_end,
        completedAt: row.completed_at.toISOString(),
        recordedByPractitionerName: row.lifestyle_practitioner_name,
        baselines: {
          alcohol: {
            baselineId: row.alcohol_baseline_id,
            version: row.alcohol_baseline_version,
            status: row.alcohol_baseline_status,
            everConsumed: row.alcohol_ever_consumed,
            consumedPast12Months: row.alcohol_consumed_past_12_months,
            commonBeverageTypes: row.alcohol_baseline_beverage_types,
            otherBeverageDescription: row.alcohol_baseline_other_description,
          },
          tobacco: {
            baselineId: row.tobacco_baseline_id,
            version: row.tobacco_baseline_version,
            status: row.tobacco_baseline_status,
            everRegularlyUsed: row.tobacco_ever_regularly_used,
            formerUseApproximateStopDate: row.tobacco_former_stop_date,
            currentUseFrequency: row.tobacco_current_use_frequency,
            productTypes: row.tobacco_baseline_product_types,
            otherProductDescription: row.tobacco_baseline_other_description,
          },
          work: {
            baselineId: row.work_baseline_id,
            version: row.work_baseline_version,
            status: row.work_baseline_status,
            occupationJobTitle: row.occupation_job_title,
            usualPhysicalDemand: row.usual_physical_demand,
            typicalWorkdaysPerWeek: row.typical_workdays_per_week,
            typicalHoursPerWorkday: row.typical_hours_per_workday,
            shiftPattern: row.shift_pattern,
            description: row.work_baseline_description,
          },
        },
        alcohol: {
          weeklyResponse: row.alcohol_weekly_response,
          drinkingDays: row.drinking_days,
          totalStandardizedDrinks: row.total_standardized_drinks,
          largestOneDayAmount: row.largest_one_day_amount,
          daysAtLargestAmount: row.days_at_largest_amount,
          commonBeverageTypes: row.alcohol_weekly_beverage_types,
          otherBeverageDescription: row.alcohol_weekly_other_description,
        },
        tobacco: {
          weeklyResponse: row.tobacco_weekly_response,
          products:
            tobaccoProductsByLifestyle.get(row.lifestyle_assessment_id) ?? [],
        },
        physicalActivity: {
          weeklyResponse: row.physical_weekly_response,
          sedentaryTimeResponse: row.sedentary_time_response,
          sedentaryMinutesPerDay: row.sedentary_minutes_per_day,
          activities:
            physicalActivitiesByLifestyle.get(row.lifestyle_assessment_id) ?? [],
        },
        work: { weeklyResponse: row.work_weekly_response },
        otherActivity: {
          weeklyResponse: row.other_activity_weekly_response,
          activities:
            otherActivitiesByLifestyle.get(row.lifestyle_assessment_id) ?? [],
        },
      });
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
          lifestyle: lifestylesByEncounter.get(row.encounter_id) ?? null,
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
