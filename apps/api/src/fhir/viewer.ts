import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import {
  authorizeOperationsPermission,
  OperationsAuthorizationError,
  operationsPrincipalFingerprint,
} from '../operations/access.js';
import {
  OperationsAuthenticationError,
  type OperationsTokenVerifier,
  type VerifiedOperationsIdentity,
} from '../operations/authentication.js';
import { normalizeIdentityName } from '../sync/patient-identity-normalization.js';
import { ProviderAccessError } from '../providers/access.js';
import type { FhirTransport } from './publication.js';

export const viewerResourceTypes = [
  'Patient',
  'Encounter',
  'Observation',
  'Organization',
  'Location',
  'Provenance',
  'QuestionnaireResponse',
  'ServiceRequest',
  'Task',
  'Communication',
  'Flag',
] as const;
type Input = {
  reasonCode: string;
  name?: string;
  dateOfBirth?: string;
  personId?: string;
  resourceType?: string;
  page?: number;
  generation?: string;
};
const bodySchema = (
  properties: Record<string, unknown>,
  required: string[],
) => ({
  body: {
    type: 'object',
    additionalProperties: false,
    properties: {
      reasonCode: { type: 'string', const: 'FHIR_DEMONSTRATION' },
      ...properties,
    },
    required: ['reasonCode', ...required],
  },
});
export async function registerFhirViewer(
  app: FastifyInstance,
  database: Pool,
  verifier: OperationsTokenVerifier,
  transport: FhirTransport | null,
) {
  app.post(
    '/api/v1/operations/fhir/access',
    { schema: bodySchema({}, []) },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      try {
        const identity = await verifier.verify(req.headers.authorization);
        const user = await database.query<{
          account_role: string;
          status: string;
        }>(
          'SELECT account_role,status FROM operations_users WHERE oidc_issuer=$1 AND oidc_subject=$2',
          [identity.issuer, identity.subject],
        );
        if (!user.rows[0] || user.rows[0].status !== 'ACTIVE')
          throw new ProviderAccessError();
        return { fhirOnly: user.rows[0].account_role === 'FHIR_VIEWER' };
      } catch (error) {
        if (
          error instanceof OperationsAuthenticationError ||
          error instanceof ProviderAccessError
        )
          return reply
            .code(error.statusCode)
            .send({ code: error.code, requestId: req.id });
        throw error;
      }
    },
  );
  function handler(action: string, search: boolean) {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      reply.header('cache-control', 'no-store').header('pragma', 'no-cache');
      let identity: VerifiedOperationsIdentity | null = null;
      let actor: string | null = null;
      const db = await database.connect();
      try {
        identity = await verifier.verify(req.headers.authorization);
        await db.query('BEGIN');
        const principal = await authorizeOperationsPermission(
          db,
          identity,
          'FHIR_READ',
        );
        actor = principal.operationsUserId;
        if (!transport)
          throw new ProviderAccessError('FHIR_SERVICE_UNAVAILABLE', 503);
        const input = req.body as Input;
        const orgs =
          principal.patientAccessScope.kind === 'GLOBAL'
            ? null
            : principal.patientAccessScope.organizationIds;
        const page = input.page ?? 1;
        let result: unknown;
        if (search) {
          if (!input.name?.trim() && !input.dateOfBirth)
            throw new ProviderAccessError('FHIR_SEARCH_CRITERIA_REQUIRED', 400);
          const name = normalizeIdentityName(input.name ?? '');
          if (input.name && !name)
            throw new ProviderAccessError('FHIR_SEARCH_CRITERIA_REQUIRED', 400);
          const patients = await db.query<{
            person_id: string;
            resource_id: string;
            generation: string;
          }>(
            `SELECT p.id person_id,r.resource_id,q.generation FROM persons p
            JOIN fhir_publish_queue q ON q.person_id=p.id AND q.status='PUBLISHED' AND q.generation=q.published_generation
            JOIN fhir_resource_registry r ON r.person_id=p.id AND r.resource_type='Patient'
            WHERE ($1::text='' OR position($1 in p.name_normalized)>0) AND ($2::date IS NULL OR p.date_of_birth=$2::date)
            AND ($3::uuid[] IS NULL OR EXISTS(SELECT 1 FROM patient_source_links l JOIN desktop_installations i ON i.id=l.installation_id WHERE l.person_id=p.id AND i.organization_id=ANY($3)))
            ORDER BY p.name_normalized,p.id LIMIT 11 OFFSET $4`,
            [name, input.dateOfBirth ?? null, orgs, (page - 1) * 10],
          );
          const items = [];
          const deadline = Date.now() + 45000;
          let bytes = 0;
          for (const p of patients.rows.slice(0, 10)) {
            if (Date.now() > deadline) throw new Error('FHIR_READ_TIMEOUT');
            const resource = await transport.read('Patient', p.resource_id);
            bytes += Buffer.byteLength(JSON.stringify(resource));
            if (bytes > 4 * 1024 * 1024) throw new ProviderAccessError('FHIR_RESPONSE_LIMIT', 413);
            if (
              resource.resourceType !== 'Patient' ||
              resource.id !== p.resource_id
            )
              throw new Error('FHIR_INVALID_RESOURCE_RESPONSE');
            items.push({
              personId: p.person_id,
              generation: p.generation,
              resource,
            });
          }
          result = { items, page, hasMore: patients.rows.length > 10 };
        } else {
          const eligible = await db.query(
            `SELECT q.generation,q.published_generation,q.status FROM fhir_publish_queue q WHERE q.person_id=$1
            AND ($2::uuid[] IS NULL OR EXISTS(SELECT 1 FROM patient_source_links l JOIN desktop_installations i ON i.id=l.installation_id WHERE l.person_id=q.person_id AND i.organization_id=ANY($2)))`,
            [input.personId, orgs],
          );
          const queue = eligible.rows[0];
          if (!queue)
            throw new ProviderAccessError('FHIR_PATIENT_NOT_FOUND', 404);
          if (
            queue.status !== 'PUBLISHED' ||
            queue.generation !== queue.published_generation
          )
            throw new ProviderAccessError('FHIR_PUBLICATION_NOT_READY', 503);
          if (
            (page > 1 && !input.generation) ||
            (input.generation && input.generation !== queue.generation)
          )
            throw new ProviderAccessError('FHIR_PAGE_STALE', 409);
          const rows = await db.query<{
            resource_type: string;
            resource_id: string;
          }>(
            `SELECT resource_type,resource_id FROM fhir_resource_registry r
            WHERE ($3::text IS NULL OR resource_type=$3) AND (
              (person_id=$1 AND ($2::uuid[] IS NULL OR organization_id IS NULL OR organization_id=ANY($2))) OR
              (person_id IS NULL AND EXISTS(SELECT 1 FROM screening_encounters e WHERE e.person_id=$1 AND e.organization_id=r.organization_id
                AND ($2::uuid[] IS NULL OR e.organization_id=ANY($2)) AND (r.resource_type='Organization' OR (r.resource_type='Location' AND e.location_id=r.source_id)))))
            ORDER BY resource_type,resource_id LIMIT 26 OFFSET $4`,
            [input.personId, orgs, input.resourceType ?? null, (page - 1) * 25],
          );
          const entries = [];
          const deadline = Date.now() + 45000;
          let bytes = 0;
          for (const r of rows.rows.slice(0, 25)) {
            if (Date.now() > deadline) throw new Error('FHIR_READ_TIMEOUT');
            const resource = await transport.read(
              r.resource_type,
              r.resource_id,
            );
            if (
              resource.resourceType !== r.resource_type ||
              resource.id !== r.resource_id
            )
              throw new Error('FHIR_INVALID_RESOURCE_RESPONSE');
            bytes += Buffer.byteLength(JSON.stringify(resource));
            if (bytes > 4 * 1024 * 1024)
              throw new ProviderAccessError('FHIR_RESPONSE_LIMIT', 413);
            entries.push({ resource });
          }
          const current = await db.query(
            'SELECT generation FROM fhir_publish_queue WHERE person_id=$1',
            [input.personId],
          );
          if (current.rows[0]?.generation !== queue.generation)
            throw new ProviderAccessError('FHIR_PAGE_STALE', 409);
          result = {
            bundle: {
              resourceType: 'Bundle',
              type: 'collection',
              entry: entries,
            },
            generation: queue.generation,
            page,
            hasMore: rows.rows.length > 25,
          };
        }
        // Live grants are checked again after private server reads, including suspension and expiry.
        const refreshed = await authorizeOperationsPermission(db, identity, 'FHIR_READ');
        if(JSON.stringify(refreshed.patientAccessScope)!==JSON.stringify(principal.patientAccessScope))throw new ProviderAccessError();
        await db.query(
          `INSERT INTO audit_events(id,operations_user_id,action_code,entity_type,reason_code,request_id,occurred_at,outcome_code,metadata)
          VALUES($1,$2,$3,'FHIR_RESOURCE','FHIR_DEMONSTRATION',$4,now(),'SUCCESS','{}')`,
          [randomUUID(), actor, action, req.id],
        );
        await db.query('COMMIT');
        return result;
      } catch (error) {
        await db.query('ROLLBACK');
        const known =
          error instanceof OperationsAuthenticationError ||
          error instanceof OperationsAuthorizationError ||
          error instanceof ProviderAccessError;
        const status = known ? error.statusCode : 503;
        await db.query(
          `INSERT INTO audit_events(id,operations_user_id,action_code,entity_type,reason_code,request_id,occurred_at,outcome_code,metadata)
          VALUES($1,$2,$3,'FHIR_RESOURCE','FHIR_DEMONSTRATION',$4,now(),$5,$6::jsonb)`,
          [
            randomUUID(),
            actor,
            action,
            req.id,
            status === 403 ? 'DENIED' : 'ERROR',
            JSON.stringify(
              identity
                ? {
                    principalFingerprint:
                      operationsPrincipalFingerprint(identity),
                  }
                : {},
            ),
          ],
        );
        if (status === 401) reply.header('www-authenticate', 'Bearer');
        return reply
          .code(status)
          .send({
            code: known ? error.code : 'FHIR_SERVICE_UNAVAILABLE',
            requestId: req.id,
          });
      } finally {
        db.release();
      }
    };
  }
  app.post(
    '/api/v1/operations/fhir/patients/search',
    {
      schema: bodySchema(
        {
          name: {
            type: 'string',
            minLength: 2,
            maxLength: 120,
            pattern: '\\S',
          },
          dateOfBirth: { type: 'string', format: 'date' },
          page: { type: 'integer', minimum: 1, maximum: 1000 },
        },
        [],
      ),
    },
    handler('FHIR_PATIENT_SEARCH', true),
  );
  app.post(
    '/api/v1/operations/fhir/resources/read',
    {
      schema: bodySchema(
        {
          personId: { type: 'string', format: 'uuid' },
          resourceType: { type: 'string', enum: viewerResourceTypes },
          page: { type: 'integer', minimum: 1, maximum: 200 },
          generation: { type: 'string', pattern: '^[0-9]{1,20}$' },
        },
        ['personId'],
      ),
    },
    handler('FHIR_RESOURCE_READ', false),
  );
}
