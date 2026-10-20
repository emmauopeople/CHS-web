export const accountPermissions = [
  'PATIENT_READ',
  'MEDICAL_ID_RECOVER',
  'IDENTITY_REVIEW',
  'IDENTITY_REVIEW_RESOLVE',
  'SYNC_MONITOR',
  'DESKTOP_INSTALLATION_MANAGE',
] as const;
export type AccountRole = 'STAFF' | 'ADMIN' | 'SUPER_ADMIN';
export type AccountRecord = {
  id: string;
  username: string | null;
  displayName: string;
  email: string | null;
  role: AccountRole;
  status: 'ACTIVE' | 'SUSPENDED';
  organizationIds: string[];
};
export type AccountPage = {
  items: AccountRecord[];
  hasMore: boolean;
  page: number;
  organizations: { id: string; name: string }[];
  actorId: string;
  actorRole: 'ADMIN' | 'SUPER_ADMIN';
};
export type AccountResult = {
  id: string;
  username: string | null;
  temporaryPassword?: string;
  requiresPasswordChange?: boolean;
};
export type AccountCreate = {
  reasonCode: 'ACCOUNT_ADMINISTRATION';
  username: string;
  displayName: string;
  email?: string;
  role: AccountRole;
  organizationId?: string;
  permissions: string[];
};
export type AccountChange = {
  reasonCode: 'ACCOUNT_ADMINISTRATION';
  id: string;
  action: 'SUSPEND' | 'ACTIVATE' | 'RESET_PASSWORD';
  confirmed: true;
};
const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;
const id = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9-]{36}$/i.test(v);
export function accountPage(v: unknown): v is AccountPage {
  return (
    object(v) &&
    Array.isArray(v.items) &&
    v.items.length <= 50 &&
    v.items.every(
      (a) =>
        object(a) &&
        id(a.id) &&
        (a.username === null || typeof a.username === 'string') &&
        typeof a.displayName === 'string' &&
        (a.email === null || typeof a.email === 'string') &&
        ['STAFF', 'ADMIN', 'SUPER_ADMIN'].includes(String(a.role)) &&
        ['ACTIVE', 'SUSPENDED'].includes(String(a.status)) &&
        Array.isArray(a.organizationIds) &&
        a.organizationIds.every(id),
    ) &&
    Array.isArray(v.organizations) &&
    v.organizations.length <= 500 &&
    v.organizations.every(
      (o) => object(o) && id(o.id) && typeof o.name === 'string',
    ) &&
    typeof v.hasMore === 'boolean' &&
    Number.isInteger(v.page) &&
    id(v.actorId) &&
    ['ADMIN', 'SUPER_ADMIN'].includes(String(v.actorRole))
  );
}
export function accountResult(v: unknown): v is AccountResult {
  return (
    object(v) &&
    id(v.id) &&
    (v.username === null || typeof v.username === 'string') &&
    (v.temporaryPassword === undefined ||
      (typeof v.temporaryPassword === 'string' &&
        v.temporaryPassword.length >= 20 &&
        v.temporaryPassword.length <= 120 &&
        v.requiresPasswordChange === true))
  );
}
