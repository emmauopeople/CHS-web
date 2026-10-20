import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { loadFhirSnapshot } from './snapshot.js';
import type { MappedResource } from './mapping.js';
const hash = (v: unknown) =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex');
export type FhirTransport = {
  transaction(bundle: unknown): Promise<void>;
  read(type: string, id: string): Promise<Record<string, unknown>>;
};
export function createFhirTransport(
  baseUrl: string,
  fetcher: typeof fetch = fetch,
): FhirTransport {
  async function request(path: string, body?: unknown) {
    const r = await fetcher(`${baseUrl.replace(/\/$/, '')}/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        accept: 'application/fhir+json',
        ...(body ? { 'content-type': 'application/fhir+json' } : {}),
      },
      signal: AbortSignal.timeout(body ? 45000 : 10000),
      redirect: 'error',
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!r.ok) throw new Error('FHIR_SERVER_UNAVAILABLE');
    const length = Number(r.headers.get('content-length') ?? 0);
    if (length > 5 * 1024 * 1024) throw new Error('FHIR_RESPONSE_LIMIT');
    const reader = r.body?.getReader();
    if (!reader) throw new Error('FHIR_SERVER_INVALID_RESPONSE');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > 5 * 1024 * 1024) {
        await reader.cancel();
        throw new Error('FHIR_RESPONSE_LIMIT');
      }
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
      string,
      unknown
    >;
  }
  return {
    async transaction(bundle) {
      const transaction = bundle as {
        resourceType: string;
        type: string;
        entry: { request: { url: string }; [key: string]: unknown }[];
      };
      const data = await request('', {
        ...transaction,
        entry: transaction.entry.map((entry) => ({
          ...entry,
          fullUrl:
            entry.fullUrl ??
            `${baseUrl.replace(/\/$/, '')}/${entry.request.url}`,
        })),
      });
      const entries = data.entry as
        { response?: { status?: string } }[] | undefined;
      if (
        data.resourceType !== 'Bundle' ||
        data.type !== 'transaction-response' ||
        !entries ||
        entries.length !== (bundle as { entry: unknown[] }).entry.length ||
        entries.some((e) => !/^2\d\d\b/.test(e.response?.status ?? ''))
      )
        throw new Error('FHIR_TRANSACTION_REJECTED');
    },
    async read(type, id) {
      if (!/^[A-Za-z]+$/.test(type) || !/^chs-[a-f0-9-]{1,59}$/.test(id))
        throw new Error('FHIR_RESOURCE_INVALID');
      return request(`${type}/${id}`);
    },
  };
}
export async function publishNextPatient(pool: Pool, transport: FhirTransport) {
  const lease = randomUUID();
  const claim = await pool.query<{
    person_id: string;
    generation: string;
    attempts: number;
  }>(
    `UPDATE fhir_publish_queue q SET status='PUBLISHING',lease_id=$1,lease_until=now()+interval '2 minutes',attempts=attempts+1,updated_at=now()
  WHERE person_id=(SELECT person_id FROM fhir_publish_queue WHERE ((status IN ('PENDING','RETRY') AND next_attempt_at<=now()) OR (status='PUBLISHING' AND lease_until<now())) ORDER BY next_attempt_at,person_id FOR UPDATE SKIP LOCKED LIMIT 1)
  RETURNING person_id,generation,attempts`,
    [lease],
  );
  const job = claim.rows[0];
  if (!job) return false;
  const db = await pool.connect();
  let resources: MappedResource[] = [];
  try {
    // Serialize a patient's publications even if a crashed worker's lease expires.
    // Sync writers never acquire this session lock and remain independent.
    await db.query('SELECT pg_advisory_lock(hashtextextended($1,20261020))', [
      job.person_id,
    ]);
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await db.query("SET LOCAL statement_timeout='10s'");
    resources = await loadFhirSnapshot(db, job.person_id);
    const previous = await db.query<{
      resource_type: string;
      resource_id: string;
      content_hash: string;
    }>(
      `SELECT resource_type,resource_id,content_hash FROM fhir_resource_registry WHERE person_id=$1 OR EXISTS
        (SELECT 1 FROM jsonb_to_recordset($2::jsonb) wanted(resource_type text,resource_id text)
          WHERE wanted.resource_type=fhir_resource_registry.resource_type AND wanted.resource_id=fhir_resource_registry.resource_id)`,
      [
        job.person_id,
        JSON.stringify(
          resources.map((r) => ({
            resource_type: r.resource.resourceType,
            resource_id: r.resource.id,
          })),
        ),
      ],
    );
    await db.query('COMMIT');
    const changed = resources.filter(
      (r) =>
        !previous.rows.some(
          (p) =>
            p.resource_type === r.resource.resourceType &&
            p.resource_id === r.resource.id &&
            p.content_hash === hash(r.resource),
        ),
    );
    // Deletes are restricted to this patient's previously published clinical resources.
    const stale = await pool.query<{
      resource_type: string;
      resource_id: string;
    }>(
      'SELECT resource_type,resource_id FROM fhir_resource_registry WHERE person_id=$1',
      [job.person_id],
    );
    const deleted = stale.rows.filter(
      (p) =>
        !resources.some(
          (r) =>
            r.resource.resourceType === p.resource_type &&
            r.resource.id === p.resource_id,
        ),
    );
    const entry = [
      ...changed.map((r) => ({
        resource: r.resource,
        request: {
          method: 'PUT',
          url: `${r.resource.resourceType}/${r.resource.id}`,
        },
      })),
      ...deleted.map((r) => ({
        request: {
          method: 'DELETE',
          url: `${r.resource_type}/${r.resource_id}`,
        },
      })),
    ];
    if (entry.length)
      await transport.transaction({
        resourceType: 'Bundle',
        type: 'transaction',
        entry,
      });
    await db.query('BEGIN');
    const owned = await db.query(
      'SELECT person_id FROM fhir_publish_queue WHERE person_id=$1 AND lease_id=$2 FOR UPDATE',
      [job.person_id, lease],
    );
    if (!owned.rowCount) {
      await db.query('ROLLBACK');
      return true;
    }
    for (const r of resources)
      await db.query(
        `INSERT INTO fhir_resource_registry(resource_type,resource_id,source_id,person_id,organization_id,content_hash)
   VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(resource_type,resource_id) DO UPDATE SET content_hash=$6,published_at=now(),organization_id=$5`,
        [
          r.resource.resourceType,
          r.resource.id,
          r.sourceId,
          r.personId,
          r.organizationId,
          hash(r.resource),
        ],
      );
    for (const r of deleted)
      await db.query(
        'DELETE FROM fhir_resource_registry WHERE resource_type=$1 AND resource_id=$2 AND person_id=$3',
        [r.resource_type, r.resource_id, job.person_id],
      );
    await db.query(
      `UPDATE fhir_publish_queue SET published_generation=$3,status=CASE WHEN generation=$3 THEN 'PUBLISHED' ELSE 'PENDING' END,
   lease_id=NULL,lease_until=NULL,error_code=NULL,next_attempt_at=now(),updated_at=now() WHERE person_id=$1 AND lease_id=$2`,
      [job.person_id, lease, job.generation],
    );
    await db.query(
      "INSERT INTO fhir_publication_events(id,person_id,generation,outcome,resource_count) VALUES($1,$2,$3,'PUBLISHED',$4)",
      [randomUUID(), job.person_id, job.generation, resources.length],
    );
    await db.query('COMMIT');
    return true;
  } catch (error) {
    await db.query('ROLLBACK');
    const blocked =
      error instanceof Error &&
      ['FHIR_PATIENT_LIMIT', 'FHIR_PERSON_NOT_FOUND'].includes(error.message);
    const code = blocked ? (error as Error).message : 'FHIR_PUBLICATION_FAILED';
    await db.query('BEGIN');
    await db.query(
      `UPDATE fhir_publish_queue SET status=CASE WHEN generation<>$6 THEN 'PENDING' ELSE $3 END,error_code=$4,lease_id=NULL,lease_until=NULL,
        next_attempt_at=CASE WHEN generation<>$6 THEN now() ELSE now()+make_interval(secs=>$5) END,updated_at=now() WHERE person_id=$1 AND lease_id=$2`,
      [
        job.person_id,
        lease,
        blocked ? 'BLOCKED' : 'RETRY',
        code,
        Math.min(3600, 30 * 2 ** Math.min(job.attempts, 7)),
        job.generation,
      ],
    );
    await db.query(
      'INSERT INTO fhir_publication_events(id,person_id,generation,outcome,resource_count,error_code) VALUES($1,$2,$3,$4,0,$5)',
      [
        randomUUID(),
        job.person_id,
        job.generation,
        blocked ? 'BLOCKED' : 'RETRY',
        code,
      ],
    );
    await db.query('COMMIT');
    return true;
  } finally {
    try {
      await db.query(
        'SELECT pg_advisory_unlock(hashtextextended($1,20261020))',
        [job.person_id],
      );
    } finally {
      db.release();
    }
  }
}
