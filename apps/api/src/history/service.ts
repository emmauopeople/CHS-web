import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  historyResourceTypes,
  isHistoryPage,
  isHistoryRequest,
  type HistoryItem,
  type HistoryPage,
  type HistoryRequest,
  type HistoryResourceType,
  type InstallationHistoryRequest,
} from '../../../../packages/contracts/src/patient-history.mjs';
import {
  authorizePatientRead,
  OperationsAuthorizationError,
} from '../operations/access.js';
import type { VerifiedOperationsIdentity } from '../operations/authentication.js';
import type { PatientAccessScope } from '../operations/patient-query.js';
import {
  authenticateInstallation,
  InstallationAuthenticationError,
} from '../sync/installation-auth.js';
import {
  CHS_MEDICAL_ID_SYSTEM,
  CHS_MEDICAL_ID_TYPE,
} from '../sync/medical-id.js';
import { historyIndexSql, historyPayload } from './queries.js';

export class HistoryError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: 400 | 403 | 404 | 409 | 503,
  ) {
    super('Patient history request could not be completed');
    this.name = 'HistoryError';
  }
}
export type HistoryCaller =
  | Readonly<{ kind: 'INSTALLATION'; authorization: string | undefined }>
  | Readonly<{ kind: 'OPERATIONS'; identity: VerifiedOperationsIdentity }>;
export type HistoryAuditContext = Readonly<{
  requestId: string;
  route: string;
}>;
const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const maxResponseBytes = 512 * 1024;

type HistoryRow = {
  resource_type: HistoryResourceType;
  id: string;
  parent_id: string | null;
  revision: number;
  occurred_at: Date;
  received_at: Date;
  author_id: string;
  author_name: string;
  encounter_id: string;
  encounter_status: HistoryItem['encounter']['status'];
  encounter_started_at: Date;
  amendment_of_encounter_id: string | null;
  amendment_reason: string | null;
  void_reason: string | null;
  organization_id: string;
  organization_name: string;
  location_id: string;
  location_name: string;
  installation_id: string;
  deployment_name: string;
};
type CursorRow = {
  data_version: string;
  after_time: Date;
  after_type: string;
  after_id: string;
  retrieved_at: Date;
  expires_at: Date;
};

export function validateHistoryRange(
  input: unknown,
  installation = false,
): HistoryRequest {
  if (!isHistoryRequest(input, installation))
    throw new HistoryError('INVALID_HISTORY_REQUEST', 400);
  const days =
    (Date.parse(input.toDate) - Date.parse(input.fromDate)) / 86_400_000;
  if (days < 0 || days >= 366)
    throw new HistoryError('INVALID_HISTORY_DATE_RANGE', 400);
  return input;
}

export async function readPatientHistory(
  database: Pick<Pool, 'connect'>,
  caller: HistoryCaller,
  request: HistoryRequest | InstallationHistoryRequest,
  context: HistoryAuditContext,
  now = new Date(),
): Promise<HistoryPage> {
  const input = validateHistoryRange(request, caller.kind === 'INSTALLATION');
  const limit = input.limit ?? 25;
  const types = [...(input.resourceTypes ?? historyResourceTypes)].sort();
  const client = await database.connect();
  let operationsUserId: string | null = null;
  let practitionerId: string | null = null;
  let organizationId: string | null = null;
  let installationId: string | null = null;
  let transaction = false;
  const audit = async (
    outcome: 'SUCCESS' | 'DENIED' | 'NOT_FOUND' | 'ERROR',
    itemCount = 0,
  ) => {
    await client.query(
      `INSERT INTO audit_events
      (id, organization_id, operations_user_id, practitioner_id, action_code, entity_type, entity_id,
       reason_code, request_id, occurred_at, outcome_code, metadata)
      VALUES ($1,$2,$3,$4,'PATIENT_HISTORY_READ','PERSON',$5,$6,$7,$8,$9,$10::jsonb)`,
      [
        randomUUID(),
        organizationId,
        operationsUserId,
        practitionerId,
        input.personId,
        input.reasonCode,
        context.requestId,
        now.toISOString(),
        outcome,
        JSON.stringify({
          audience: caller.kind,
          installationId,
          route: context.route,
          itemCount,
        }),
      ],
    );
  };
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    transaction = true;
    await client.query("SET LOCAL statement_timeout = '5s'");
    let scope: PatientAccessScope;
    let ownerKey: string;
    if (caller.kind === 'INSTALLATION') {
      const installation = await authenticateInstallation(
        client,
        caller.authorization,
        now,
      );
      installationId = installation.installationId;
      organizationId = installation.organizationId;
      const body = request as InstallationHistoryRequest;
      const actor = await client.query<{ practitioner_id: string }>(
        `SELECT link.practitioner_id
        FROM practitioner_source_links link JOIN practitioners practitioner ON practitioner.id=link.practitioner_id
        JOIN desktop_installations installation ON installation.id=link.installation_id
        JOIN organizations organization ON organization.id=installation.organization_id
        JOIN locations location ON location.id=installation.configured_location_id
        WHERE link.installation_id=$1 AND link.source_actor_local_id=$2
          AND link.source_active AND practitioner.active AND organization.active AND location.active
          AND link.source_role_code IN ('NURSE','LOCAL_ADMIN')`,
        [installationId, body.requesterLocalActorId],
      );
      practitionerId = actor.rows[0]?.practitioner_id ?? null;
      if (!practitionerId) throw new HistoryError('HISTORY_ACCESS_DENIED', 403);
      const link = await client.query<{ last_source_revision: number }>(
        `SELECT last_source_revision FROM patient_source_links
        WHERE installation_id=$1 AND local_patient_id=$2 AND person_id=$3`,
        [installationId, body.localPatientId, input.personId],
      );
      if (!link.rows[0]) throw new HistoryError('HISTORY_NOT_AVAILABLE', 404);
      const conflict = await client.query(
        `SELECT 1 FROM sync_records WHERE installation_id=$1 AND resource_type='PATIENT'
        AND local_resource_id=$2 AND source_revision >= $3 AND status='REJECTED' LIMIT 1`,
        [
          installationId,
          body.localPatientId,
          link.rows[0].last_source_revision,
        ],
      );
      if (conflict.rows.length)
        throw new HistoryError('HISTORY_IDENTITY_REVIEW_REQUIRED', 409);
      const review = await client.query(
        `SELECT 1 FROM identity_review_cases review
        WHERE review.status='OPEN' AND (
          (review.installation_id=$1 AND review.local_patient_id=$2)
          OR EXISTS (SELECT 1 FROM identity_review_candidates candidate
            JOIN desktop_installations source ON source.id=review.installation_id
            WHERE candidate.review_case_id=review.id AND candidate.person_id=$3 AND source.organization_id=$4)) LIMIT 1`,
        [installationId, body.localPatientId, input.personId, organizationId],
      );
      if (review.rows.length)
        throw new HistoryError('HISTORY_IDENTITY_REVIEW_REQUIRED', 409);
      scope = { kind: 'ORGANIZATIONS', organizationIds: [organizationId] };
      ownerKey = hash([
        caller.kind,
        caller.authorization,
        installationId,
        body.localPatientId,
        body.requesterLocalActorId,
        scope,
      ]);
    } else {
      const principal = await authorizePatientRead(
        client,
        caller.identity,
        now,
      );
      operationsUserId = principal.operationsUserId;
      scope = principal.patientAccessScope;
      if (scope.kind === 'ORGANIZATIONS') {
        scope = {
          ...scope,
          organizationIds: [...scope.organizationIds].sort(),
        };
        if (scope.organizationIds.length === 1)
          organizationId = scope.organizationIds[0]!;
      }
      ownerKey = hash([caller.kind, operationsUserId, scope]);
    }
    const global = scope.kind === 'GLOBAL';
    const organizationIds =
      scope.kind === 'ORGANIZATIONS' ? scope.organizationIds : [];
    const eligibility = await client.query<{
      patient: Readonly<Record<string, unknown>>;
    }>(
      `SELECT jsonb_build_object(
      'personId',p.id,'chsMedicalId',(SELECT identifier_value FROM person_identifiers WHERE person_id=p.id AND identifier_system=$4 AND identifier_type_code=$5 AND status='ACTIVE' AND is_primary),
      'displayName',p.display_name,'givenName',p.given_name,'familyName',p.family_name,'otherNames',p.other_names,
      'dateOfBirth',p.date_of_birth,'approximateAgeYears',p.approximate_age_years,'ageAsOfDate',p.age_as_of_date,
      'sex',p.sex,'status',p.status,'phone',p.phone,'alternateContactName',p.alternate_contact_name,
      'alternateContactPhone',p.alternate_contact_phone,'village',p.village,'quarter',p.quarter,
      'residenceNotes',p.residence_notes,'acknowledgmentStatus',p.acknowledgment_status,'lastUpdatedAt',p.updated_at
    ) patient FROM persons p
      WHERE p.id=$1 AND EXISTS (SELECT 1 FROM person_identifiers identifier
        WHERE identifier.person_id=p.id AND identifier.identifier_system=$4
          AND identifier.identifier_type_code=$5 AND identifier.status='ACTIVE' AND identifier.is_primary)
      AND ($2::boolean OR EXISTS (SELECT 1 FROM patient_source_links link
        JOIN desktop_installations installation ON installation.id=link.installation_id
        WHERE link.person_id=p.id AND installation.organization_id=ANY($3::uuid[])))`,
      [
        input.personId,
        global,
        organizationIds,
        CHS_MEDICAL_ID_SYSTEM,
        CHS_MEDICAL_ID_TYPE,
      ],
    );
    if (!eligibility.rows.length)
      throw new HistoryError('HISTORY_NOT_AVAILABLE', 404);

    const patient = eligibility.rows[0]!.patient;
    const queryKey = hash([
      input.personId,
      input.reasonCode,
      input.fromDate,
      input.toDate,
      types,
      limit,
    ]);
    const end = new Date(Date.parse(input.toDate) + 86_400_000).toISOString();
    const parameters = [
      input.personId,
      global,
      organizationIds,
      `${input.fromDate}T00:00:00.000Z`,
      end,
    ];
    // Hash ordered, small provenance/version rows, not clinical bodies. Any changed
    // resource in the requested range invalidates continuation instead of skipping it.
    const version = await client.query<{ version: string }>(
      `${historyIndexSql}
      SELECT md5(COALESCE(string_agg(md5(to_jsonb(i)::text), '' ORDER BY resource_type,id),'')
        || COALESCE((SELECT max(updated_at)::text FROM practitioners),'') || $6::text
      ) version FROM history_index i`,
      [...parameters, hash(patient)],
    );
    const dataVersion = version.rows[0]!.version;
    let cursor: CursorRow | undefined;
    if (input.cursor) {
      const found = await client.query<CursorRow>(
        `SELECT data_version,after_time,after_type,after_id,retrieved_at,expires_at
        FROM patient_history_cursors WHERE id=$1 AND owner_key=$2 AND query_key=$3`,
        [input.cursor, ownerKey, queryKey],
      );
      cursor = found.rows[0];
      if (
        !cursor ||
        cursor.expires_at <= now ||
        cursor.data_version !== dataVersion
      )
        throw new HistoryError('HISTORY_CURSOR_STALE', 409);
    }
    const retrievedAt = cursor?.retrieved_at ?? now;
    const candidates = await client.query<HistoryRow>(
      `${historyIndexSql}
      SELECT * FROM history_index WHERE resource_type=ANY($6::text[])
        AND ($7::timestamptz IS NULL OR (occurred_at,resource_type,id) < ($7::timestamptz,$8::text,$9::uuid))
      ORDER BY occurred_at DESC,resource_type DESC,id DESC LIMIT $10`,
      [
        ...parameters,
        types,
        cursor?.after_time ?? null,
        cursor?.after_type ?? null,
        cursor?.after_id ?? null,
        limit + 1,
      ],
    );
    const items: HistoryItem[] = [];
    let bytes = 2048 + Buffer.byteLength(JSON.stringify(patient));
    for (const row of candidates.rows.slice(0, limit)) {
      const item: HistoryItem = {
        resourceType: row.resource_type,
        resourceId: row.id,
        parentResourceId: row.parent_id,
        sourceRevision: row.revision,
        occurredAt: row.occurred_at.toISOString(),
        receivedAt: row.received_at.toISOString(),
        author: { practitionerId: row.author_id, displayName: row.author_name },
        encounter: {
          encounterId: row.encounter_id,
          status: row.encounter_status,
          startedAt: row.encounter_started_at.toISOString(),
          amendmentOfEncounterId: row.amendment_of_encounter_id,
          amendmentReason: row.amendment_reason,
          voidReason: row.void_reason,
        },
        source: {
          organizationId: row.organization_id,
          organizationName: row.organization_name,
          locationId: row.location_id,
          locationName: row.location_name,
          installationId: row.installation_id,
          deploymentName: row.deployment_name,
        },
        data: await historyPayload(client, row.resource_type, row.id),
      };
      const itemBytes = Buffer.byteLength(JSON.stringify(item));
      if (bytes + itemBytes > maxResponseBytes) {
        if (!items.length)
          throw new HistoryError('HISTORY_RECORD_TOO_LARGE', 503);
        break;
      }
      bytes += itemBytes;
      items.push(item);
    }
    let nextCursor: string | null = null;
    if (items.length < candidates.rows.length) {
      const last = candidates.rows[items.length - 1]!;
      // Cleanup is bounded, while expiry is enforced even before cleanup runs.
      await client.query(
        `DELETE FROM patient_history_cursors WHERE id IN
        (SELECT id FROM patient_history_cursors WHERE expires_at <= $1 ORDER BY expires_at LIMIT 1000)`,
        [now.toISOString()],
      );
      const next = await client.query<{ id: string }>(
        `INSERT INTO patient_history_cursors
        (id,owner_key,query_key,data_version,after_time,after_type,after_id,retrieved_at,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (owner_key,query_key,data_version,after_time,after_type,after_id,retrieved_at)
        DO UPDATE SET id=patient_history_cursors.id RETURNING id`,
        [
          randomUUID(),
          ownerKey,
          queryKey,
          dataVersion,
          last.occurred_at,
          last.resource_type,
          last.id,
          retrievedAt.toISOString(),
          new Date(retrievedAt.getTime() + 15 * 60_000).toISOString(),
        ],
      );
      nextCursor = next.rows[0]!.id;
    }
    const result: HistoryPage = {
      patient,
      contractVersion: '1.0',
      personId: input.personId,
      retrievedAt: retrievedAt.toISOString(),
      fromDate: input.fromDate,
      toDate: input.toDate,
      items,
      nextCursor,
    };
    if (!isHistoryPage(result))
      throw new HistoryError('HISTORY_DATA_UNAVAILABLE', 503);
    await audit('SUCCESS', items.length);
    await client.query('COMMIT');
    transaction = false;
    return result;
  } catch (error) {
    if (transaction) {
      if (
        error instanceof HistoryError ||
        error instanceof InstallationAuthenticationError ||
        error instanceof OperationsAuthorizationError
      ) {
        if (error instanceof OperationsAuthorizationError)
          operationsUserId = error.operationsUserId;
        try {
          await audit(
            error instanceof HistoryError && error.statusCode === 404
              ? 'NOT_FOUND'
              : error instanceof HistoryError && error.statusCode >= 500
                ? 'ERROR'
                : 'DENIED',
          );
          await client.query('COMMIT');
        } catch (auditError) {
          await client.query('ROLLBACK');
          throw auditError;
        }
      } else await client.query('ROLLBACK');
    }
    throw error;
  } finally {
    client.release();
  }
}
