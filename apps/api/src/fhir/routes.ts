import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import {
  type OperationsTokenVerifier,
  OperationsAuthenticationError,
} from '../operations/authentication.js';
import { authorizeProvider, ProviderAccessError } from '../providers/access.js';
import {
  authorizeOperationsPermission,
  OperationsAuthorizationError,
} from '../operations/access.js';
import {
  accountActor,
  AccountAdministrationError,
} from '../operations/account-administration.js';
import type { FhirTransport } from './publication.js';
import { collectionUrl, collectionResource } from './collection.js';

export async function registerFhirRoutes(
  app: FastifyInstance,
  {
    database,
    tokenVerifier,
    transport,
  }: {
    database: Pool;
    tokenVerifier: OperationsTokenVerifier;
    transport: FhirTransport | null;
  },
) {
  app.post<{
    Body: {
      reasonCode: string;
      personId: string;
      page?: number;
      generation?: string;
    };
  }>(
    '/api/v1/providers/fhir/patient',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            reasonCode: {
              type: 'string',
              enum: ['CARE_DELIVERY', 'CARE_COORDINATION', 'PATIENT_REQUEST'],
            },
            personId: { type: 'string', format: 'uuid' },
            page: { type: 'integer', minimum: 1, maximum: 200 },
            generation: { type: 'string', pattern: '^[0-9]{1,20}$' },
          },
          required: ['reasonCode', 'personId'],
        },
      },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      const db = await database.connect();
      try {
        const verified = await tokenVerifier.verify(req.headers.authorization);
        const input = req.body,
          page = input.page ?? 1;
        await db.query('BEGIN');
        const access = await authorizeProvider(
          db,
          verified,
          'fhir:read',
          input.personId,
        );
        const eligible = await db.query(
          `SELECT 1 FROM patient_source_links p JOIN desktop_installations i ON i.id=p.installation_id
    WHERE p.person_id=$1 AND i.organization_id=ANY($2::uuid[]) LIMIT 1`,
          [input.personId, access.organizationIds],
        );
        if (!eligible.rowCount)
          throw new ProviderAccessError('FHIR_PATIENT_NOT_FOUND', 404);
        const {
          rows: [queue],
        } = await db.query<{
          generation: string;
          published_generation: string;
          status: string;
        }>(
          'SELECT generation,published_generation,status FROM fhir_publish_queue WHERE person_id=$1',
          [input.personId],
        );
        if (
          !transport ||
          !queue ||
          queue.status !== 'PUBLISHED' ||
          queue.generation !== queue.published_generation
        )
          throw new ProviderAccessError('FHIR_PUBLICATION_NOT_READY', 503);
        if (
          (page > 1 && !input.generation) ||
          (input.generation && input.generation !== queue.generation)
        )
          throw new ProviderAccessError('FHIR_PAGE_STALE', 409);
        const records = await db.query<{
          resource_type: string;
          resource_id: string;
        }>(
          `SELECT resource_type,resource_id FROM fhir_resource_registry
    WHERE (person_id=$1 AND (organization_id IS NULL OR organization_id=ANY($2::uuid[]))) OR
     (person_id IS NULL AND organization_id=ANY($2::uuid[]) AND EXISTS(SELECT 1 FROM screening_encounters e WHERE e.person_id=$1 AND e.organization_id=fhir_resource_registry.organization_id
       AND (resource_type='Organization' OR (resource_type='Location' AND e.location_id=fhir_resource_registry.source_id))))
    ORDER BY resource_type,resource_id LIMIT 26 OFFSET $3`,
          [input.personId, access.organizationIds, (page - 1) * 25],
        );
        const entry = [];
        const deadline = Date.now() + 45000;
        for (const r of records.rows.slice(0, 25)) {
          if (Date.now() > deadline)
            throw new ProviderAccessError('FHIR_SERVICE_UNAVAILABLE', 503);
          const resource = await transport.read(r.resource_type, r.resource_id);
          if (
            resource.resourceType !== r.resource_type ||
            resource.id !== r.resource_id
          )
            throw new Error('FHIR_INVALID_RESOURCE_RESPONSE');
          entry.push({
            fullUrl: collectionUrl(r.resource_type, r.resource_id),
            resource: collectionResource(resource),
          });
        }
        // Read-committed recheck after the remote reads: revoked sharing never delivers a response.
        await authorizeProvider(db, verified, 'fhir:read', input.personId);
        const current = await db.query(
          'SELECT generation FROM fhir_publish_queue WHERE person_id=$1',
          [input.personId],
        );
        if (current.rows[0]?.generation !== queue.generation)
          throw new ProviderAccessError('FHIR_PAGE_STALE', 409);
        await db.query(
          `INSERT INTO audit_events(id,action_code,entity_type,entity_id,reason_code,request_id,occurred_at,outcome_code,metadata)
    VALUES($1,'PROVIDER_FHIR_READ','PERSON',$2,$3,$4,now(),'SUCCESS',$5::jsonb)`,
          [
            randomUUID(),
            input.personId,
            input.reasonCode,
            req.id,
            JSON.stringify({
              providerClientId: access.clientId,
              itemCount: entry.length,
            }),
          ],
        );
        await db.query('COMMIT');
        return {
          bundle: { resourceType: 'Bundle', type: 'collection', entry },
          generation: queue.generation,
          nextPage: records.rows.length > 25 ? page + 1 : null,
        };
      } catch (error) {
        await db.query('ROLLBACK');
        const known =
          error instanceof ProviderAccessError ||
          error instanceof OperationsAuthenticationError;
        await db.query(
          `INSERT INTO audit_events(id,action_code,entity_type,reason_code,request_id,occurred_at,outcome_code,metadata)
    VALUES($1,'PROVIDER_FHIR_READ','PERSON',$2,$3,now(),$4,'{}')`,
          [
            randomUUID(),
            req.body.reasonCode,
            req.id,
            known && error.statusCode === 403 ? 'DENIED' : 'ERROR',
          ],
        );
        return reply.code(known ? error.statusCode : 503).send({
          code: known ? error.code : 'FHIR_SERVICE_UNAVAILABLE',
          requestId: req.id,
        });
      } finally {
        db.release();
      }
    },
  );
  app.post<{ Body: { reasonCode: string; page?: number } }>(
    '/api/v1/operations/fhir/status',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            reasonCode: { type: 'string', const: 'FHIR_ADMINISTRATION' },
            page: { type: 'integer', minimum: 1, maximum: 10000 },
          },
          required: ['reasonCode'],
        },
      },
    },
    async (req, reply) => {
      try {
        const principal = await authorizeOperationsPermission(
          database,
          await tokenVerifier.verify(req.headers.authorization),
          'USER_MANAGE',
        );
        if ((await accountActor(database, principal)).role !== 'SUPER_ADMIN')
          throw new ProviderAccessError();
        const counts = await database.query(
          'SELECT status,count(*)::integer count FROM fhir_publish_queue GROUP BY status ORDER BY status',
        );
        const failures = await database.query(
          `SELECT person_id AS "personId",status,attempts,error_code AS "errorCode",updated_at AS "updatedAt" FROM fhir_publish_queue WHERE status IN ('RETRY','BLOCKED') ORDER BY updated_at DESC,person_id LIMIT 50 OFFSET $1`,
          [((req.body.page ?? 1) - 1) * 50],
        );
        await database.query(
          `INSERT INTO audit_events(id,operations_user_id,action_code,entity_type,reason_code,request_id,occurred_at,outcome_code,metadata)
    VALUES($1,$2,'FHIR_STATUS_READ','FHIR_PUBLICATION','FHIR_ADMINISTRATION',$3,now(),'SUCCESS','{}')`,
          [randomUUID(), principal.operationsUserId, req.id],
        );
        return {
          configured: transport !== null,
          counts: counts.rows,
          failures: failures.rows,
        };
      } catch (error) {
        if (
          error instanceof OperationsAuthenticationError ||
          error instanceof OperationsAuthorizationError ||
          error instanceof AccountAdministrationError ||
          error instanceof ProviderAccessError
        )
          return reply
            .code(error.statusCode)
            .send({ code: error.code, requestId: req.id });
        throw error;
      }
    },
  );
}
