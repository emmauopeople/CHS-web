import type { Pool, PoolClient } from 'pg';
import type { VerifiedOperationsIdentity } from '../operations/authentication.js';
export class ProviderAccessError extends Error {
  constructor(
    readonly code = 'PROVIDER_ACCESS_DENIED',
    readonly statusCode = 403,
  ) {
    super(code);
  }
}
export async function authorizeProvider(
  db: Pick<Pool, 'query'> | PoolClient,
  identity: VerifiedOperationsIdentity,
  scope: 'history:read' | 'fhir:read',
  personId: string,
) {
  const {
    rows: [client],
  } = await db.query<{
    id: string;
    organization_ids: string[];
    tokens_valid_after: Date;
  }>(
    `SELECT c.id,c.tokens_valid_after,array_agg(g.organization_id ORDER BY g.organization_id) organization_ids
  FROM provider_clients c JOIN provider_requests r ON r.id=c.request_id
  JOIN provider_organization_grants g ON g.client_id=c.id JOIN organizations o ON o.id=g.organization_id AND o.active
  JOIN provider_patient_grants p ON p.client_id=c.id AND p.person_id=$4 AND p.active AND p.expires_at>now()
  WHERE c.oidc_issuer=$1 AND c.oidc_subject=$2 AND c.oidc_client_id=$5 AND c.status='ACTIVE' AND r.status='APPROVED'
    AND c.expires_at>now() AND $3=ANY(c.scopes) AND c.tokens_valid_after<=to_timestamp($6)
  GROUP BY c.id`,
    [
      identity.issuer,
      identity.subject,
      scope,
      personId,
      identity.authorizedParty,
      identity.issuedAt ?? 0,
    ],
  );
  if (!client) throw new ProviderAccessError();
  return {
    clientId: client.id,
    organizationIds: client.organization_ids,
    credentialVersion: client.tokens_valid_after.toISOString(),
  };
}
