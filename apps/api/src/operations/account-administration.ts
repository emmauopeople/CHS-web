import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  authorizeOperationsPermission,
  type OperationsPrincipal,
} from './access.js';
import type { AccountIdentity } from '../administration/account-identity.js';
import { temporaryPassword } from '../administration/account-identity.js';

export const staffPermissions = [
  'PATIENT_READ',
  'MEDICAL_ID_RECOVER',
  'IDENTITY_REVIEW',
  'IDENTITY_REVIEW_RESOLVE',
  'SYNC_MONITOR',
  'DESKTOP_INSTALLATION_MANAGE',
  'FHIR_READ',
] as const;
export type AccountRole = 'STAFF' | 'ADMIN' | 'SUPER_ADMIN' | 'FHIR_VIEWER';
type Account = {
  id: string;
  oidc_issuer: string;
  oidc_subject: string;
  account_role: AccountRole;
  display_name: string;
  username: string | null;
  email: string | null;
  status: 'ACTIVE' | 'SUSPENDED';
};
export class AccountAdministrationError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode = 403,
  ) {
    super(code);
  }
}
export type AccountActor = {
  principal: OperationsPrincipal;
  role: 'ADMIN' | 'SUPER_ADMIN';
};

export async function accountActor(
  db: Pick<Pool, 'query'> | PoolClient,
  principal: OperationsPrincipal,
): Promise<AccountActor> {
  principal = await authorizeOperationsPermission(
    db,
    principal.identity,
    'USER_MANAGE',
  );
  const {
    rows: [actor],
  } = await db.query<Account>(
    "SELECT * FROM operations_users WHERE id=$1 AND status='ACTIVE'",
    [principal.operationsUserId],
  );
  if (
    !actor ||
    !['ADMIN', 'SUPER_ADMIN'].includes(actor.account_role) ||
    (actor.account_role === 'SUPER_ADMIN' &&
      principal.patientAccessScope.kind !== 'GLOBAL')
  ) {
    throw new AccountAdministrationError('ACCOUNT_MANAGEMENT_NOT_PERMITTED');
  }
  return { principal, role: actor.account_role as AccountActor['role'] };
}
function inScope(actor: AccountActor, organizationId: string | null) {
  const scope = actor.principal.patientAccessScope;
  if (
    scope.kind !== 'GLOBAL' &&
    (!organizationId || !scope.organizationIds.includes(organizationId))
  )
    throw new AccountAdministrationError('ACCOUNT_SCOPE_NOT_PERMITTED');
}
async function audit(
  db: PoolClient,
  actor: AccountActor,
  requestId: string,
  action: string,
  targetId: string,
) {
  await db.query(
    `INSERT INTO audit_events
    (id,operations_user_id,action_code,entity_type,entity_id,reason_code,request_id,occurred_at,outcome_code,metadata)
    VALUES ($1,$2,$3,'OPERATIONS_USER',$4,'ACCOUNT_ADMINISTRATION',$5,now(),'SUCCESS','{}')`,
    [
      randomUUID(),
      actor.principal.operationsUserId,
      action,
      targetId,
      requestId,
    ],
  );
}
async function targetAccount(
  db: PoolClient,
  actor: AccountActor,
  targetId: string,
) {
  const {
    rows: [target],
  } = await db.query<Account>(
    'SELECT * FROM operations_users WHERE id=$1 FOR UPDATE',
    [targetId],
  );
  if (!target || target.oidc_issuer !== actor.principal.identity.issuer)
    throw new AccountAdministrationError('ACCOUNT_NOT_FOUND', 404);
  if (actor.role === 'ADMIN' && target.account_role !== 'STAFF')
    throw new AccountAdministrationError('ACCOUNT_NOT_FOUND', 404);
  const scope = actor.principal.patientAccessScope;
  if (scope.kind !== 'GLOBAL') {
    // Every grant must be within the administrator's scope, including inactive grants.
    const outside = await db.query(
      `SELECT 1 FROM operations_access_grants WHERE operations_user_id=$1
      AND (scope_kind='GLOBAL' OR NOT (organization_id=ANY($2::uuid[]))) LIMIT 1`,
      [targetId, scope.organizationIds],
    );
    const inside = await db.query(
      `SELECT 1 FROM operations_access_grants WHERE operations_user_id=$1
      AND organization_id=ANY($2::uuid[]) LIMIT 1`,
      [targetId, scope.organizationIds],
    );
    if (outside.rowCount || !inside.rowCount)
      throw new AccountAdministrationError('ACCOUNT_NOT_FOUND', 404);
  }
  if (target.id === actor.principal.operationsUserId)
    throw new AccountAdministrationError('ACCOUNT_SELF_CHANGE_NOT_PERMITTED');
  return target;
}

export async function listAccounts(
  db: Pool,
  actor: AccountActor,
  page: number,
) {
  const ids =
    actor.principal.patientAccessScope.kind === 'GLOBAL'
      ? null
      : actor.principal.patientAccessScope.organizationIds;
  const result = await db.query(
    `SELECT u.id, u.username, u.display_name AS "displayName", u.email, u.account_role AS role, u.status,
    COALESCE((SELECT jsonb_agg(DISTINCT g.organization_id) FILTER (WHERE g.organization_id IS NOT NULL)
      FROM operations_access_grants g WHERE g.operations_user_id=u.id), '[]') AS "organizationIds"
    FROM operations_users u WHERE u.oidc_issuer=$1 AND ($2::uuid[] IS NULL OR
      (u.account_role='STAFF' AND EXISTS (SELECT 1 FROM operations_access_grants g WHERE g.operations_user_id=u.id AND g.organization_id=ANY($2))
      AND NOT EXISTS (SELECT 1 FROM operations_access_grants g WHERE g.operations_user_id=u.id AND
        (g.scope_kind='GLOBAL' OR NOT(g.organization_id=ANY($2))))))
    ORDER BY u.display_name,u.id LIMIT 51 OFFSET $3`,
    [actor.principal.identity.issuer, ids, (page - 1) * 50],
  );
  const orgs = await db.query(
    `SELECT id,name FROM organizations WHERE active=true AND ($1::uuid[] IS NULL OR id=ANY($1)) ORDER BY name,id LIMIT 500`,
    [ids],
  );
  return {
    items: result.rows.slice(0, 50),
    hasMore: result.rows.length > 50,
    page,
    organizations: orgs.rows,
    actorId: actor.principal.operationsUserId,
    actorRole: actor.role,
  };
}

export async function createAccount(
  db: Pool,
  identity: AccountIdentity,
  principal: OperationsPrincipal,
  input: {
    username: string;
    displayName: string;
    email?: string;
    role: AccountRole;
    organizationId?: string;
    permissions: string[];
  },
  requestId: string,
) {
  const client = await db.connect();
  let subject: string | undefined;
  let committed = false;
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('chs-account-administration'))",
    );
    const actor = await accountActor(client, principal);
    if (actor.role === 'ADMIN' && input.role !== 'STAFF')
      throw new AccountAdministrationError('ACCOUNT_ROLE_NOT_PERMITTED');
    const organizationId = input.organizationId ?? null;
    if (input.role !== 'SUPER_ADMIN' && !organizationId)
      throw new AccountAdministrationError(
        'ACCOUNT_ORGANIZATION_REQUIRED',
        400,
      );
    if (input.role === 'SUPER_ADMIN' && organizationId)
      throw new AccountAdministrationError(
        'ACCOUNT_SUPER_ADMIN_REQUIRES_GLOBAL_SCOPE',
        400,
      );
    inScope(actor, organizationId);
    if (organizationId) {
      const org = await client.query(
        'SELECT id FROM organizations WHERE id=$1 AND active=true FOR SHARE',
        [organizationId],
      );
      if (!org.rowCount)
        throw new AccountAdministrationError(
          'ACCOUNT_ORGANIZATION_NOT_FOUND',
          404,
        );
    }
    const permissions =
      input.role === 'FHIR_VIEWER' ? ['FHIR_READ'] : input.role === 'STAFF'
        ? [...new Set(input.permissions)]
        : [...staffPermissions, 'USER_MANAGE'];
    if (input.role === 'STAFF' && permissions.includes('USER_MANAGE'))
      throw new AccountAdministrationError('ACCOUNT_PERMISSIONS_INVALID', 400);
    if (
      !permissions.length ||
      permissions.some(
        (p) =>
          p !== 'USER_MANAGE' &&
          !staffPermissions.includes(p as (typeof staffPermissions)[number]),
      )
    )
      throw new AccountAdministrationError('ACCOUNT_PERMISSIONS_INVALID', 400);
    const delegatedExpiry = new Map<string, Date | null>();
    // Delegation cannot outlive either the operational grant or account-management authority.
    if (actor.role === 'ADMIN') {
      const grants = await client.query<{
        permission_code: string;
        expires_at: Date | null;
      }>(
        `SELECT permission_code,expires_at FROM operations_access_grants
        WHERE operations_user_id=$1 AND active=true AND (expires_at IS NULL OR expires_at>now())
        AND (scope_kind='GLOBAL' OR organization_id=$2)`,
        [principal.operationsUserId, organizationId],
      );
      if (
        permissions.some(
          (p) => !grants.rows.some((g) => g.permission_code === p),
        )
      )
        throw new AccountAdministrationError(
          'ACCOUNT_PERMISSION_DELEGATION_NOT_PERMITTED',
        );
      const expires = (permission: string) =>
        Math.max(
          ...grants.rows
            .filter((g) => g.permission_code === permission)
            .map((g) => g.expires_at?.getTime() ?? Infinity),
        );
      for (const permission of permissions) {
        const until = Math.min(expires(permission), expires('USER_MANAGE'));
        delegatedExpiry.set(
          permission,
          Number.isFinite(until) ? new Date(until) : null,
        );
      }
    }
    const password = temporaryPassword();
    subject = await identity.create(
      input.username,
      input.displayName,
      input.email ?? null,
      password,
    );
    const id = randomUUID();
    await client.query(
      `INSERT INTO operations_users(id,oidc_issuer,oidc_subject,display_name,email,status,created_at,updated_at,account_role,username)
      VALUES($1,$2,$3,$4,$5,'ACTIVE',now(),now(),$6,$7)`,
      [
        id,
        principal.identity.issuer,
        subject,
        input.displayName,
        input.email ?? null,
        input.role,
        input.username,
      ],
    );
    for (const permission of permissions)
      await client.query(
        `INSERT INTO operations_access_grants
      (id,operations_user_id,permission_code,scope_kind,organization_id,active,granted_at,created_at,updated_at,expires_at)
      VALUES($1,$2,$3,$4,$5,true,now(),now(),now(),$6)`,
        [
          randomUUID(),
          id,
          permission,
          organizationId ? 'ORGANIZATION' : 'GLOBAL',
          organizationId,
          delegatedExpiry.get(permission) ?? null,
        ],
      );
    await audit(client, actor, requestId, 'ACCOUNT_CREATE', id);
    await identity.enable(subject, true);
    await client.query('COMMIT');
    committed = true;
    return {
      id,
      username: input.username,
      temporaryPassword: password,
      requiresPasswordChange: true,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    if (subject && !committed) {
      // A failed application write must not leave a usable identity behind.
      try {
        await identity.remove(subject);
      } catch {
        /* No application grants exist after rollback. */
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function changeAccount(
  db: Pool,
  identity: AccountIdentity,
  principal: OperationsPrincipal,
  input: { id: string; action: 'SUSPEND' | 'ACTIVATE' | 'RESET_PASSWORD' },
  requestId: string,
) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('chs-account-administration'))",
    );
    const actor = await accountActor(client, principal);
    const target = await targetAccount(client, actor, input.id);
    if (
      input.action === 'SUSPEND' &&
      target.account_role === 'SUPER_ADMIN' &&
      target.status === 'ACTIVE'
    ) {
      const result = await client.query(
        `SELECT 1 FROM operations_users u WHERE u.id<>$1 AND u.status='ACTIVE' AND u.account_role='SUPER_ADMIN'
        AND u.oidc_issuer=$2 AND EXISTS(SELECT 1 FROM operations_access_grants g WHERE g.operations_user_id=u.id AND g.permission_code='USER_MANAGE'
          AND g.scope_kind='GLOBAL' AND g.active=true AND (g.expires_at IS NULL OR g.expires_at>now()))`,
        [target.id, target.oidc_issuer],
      );
      if (!result.rowCount)
        throw new AccountAdministrationError('ACCOUNT_LAST_SUPER_ADMIN');
    }
    let password: string | undefined;
    if (input.action === 'RESET_PASSWORD') {
      password = temporaryPassword();
      await identity.resetPassword(target.oidc_subject, password);
    } else {
      await identity.enable(target.oidc_subject, input.action === 'ACTIVATE');
      await client.query(
        'UPDATE operations_users SET status=$2,updated_at=now() WHERE id=$1',
        [target.id, input.action === 'ACTIVATE' ? 'ACTIVE' : 'SUSPENDED'],
      );
    }
    await audit(client, actor, requestId, `ACCOUNT_${input.action}`, target.id);
    await client.query('COMMIT');
    return {
      id: target.id,
      username: target.username,
      ...(password
        ? { temporaryPassword: password, requiresPasswordChange: true }
        : {}),
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
