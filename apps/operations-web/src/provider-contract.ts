export type ProviderRequest = {
  id: string;
  organizationName: string;
  registrationIdentifier: string;
  contactEmail: string;
  purpose: string;
  status: string;
  createdAt: string;
  clientId: string | null;
  oauthClientId: string | null;
  clientStatus: string | null;
  scopes: string[] | null;
  expiresAt: string | null;
  organizationIds: string[];
};
export type ProviderPage = {
  items: ProviderRequest[];
  page: number;
  hasMore: boolean;
  organizations: { id: string; name: string }[];
};
export type ProviderSecret = {
  clientId?: string;
  oauthClientId?: string;
  clientSecret?: string;
  tokenEndpoint?: string;
  status?: string;
  id?: string;
};
export type ProviderReview = {
  reasonCode: 'PROVIDER_ADMINISTRATION';
  id: string;
  decision: 'APPROVE' | 'REJECT';
  reviewReason: string;
  organizationIds?: string[];
  scopes?: string[];
  expiresAt?: string;
  confirmed: true;
};
export type ProviderPatientAccess = {
  reasonCode: 'PROVIDER_ADMINISTRATION';
  clientId: string;
  personId: string;
  action: 'GRANT' | 'REVOKE';
  basis: string;
  expiresAt?: string;
  confirmed: true;
};
const obj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;
const uuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9-]{36}$/i.test(v);
export const providerPage = (v: unknown): v is ProviderPage =>
  obj(v) &&
  Array.isArray(v.items) &&
  v.items.length <= 50 &&
  v.items.every(
    (r) =>
      obj(r) &&
      uuid(r.id) &&
      typeof r.organizationName === 'string' &&
      typeof r.registrationIdentifier === 'string' &&
      typeof r.contactEmail === 'string' &&
      typeof r.purpose === 'string' &&
      ['PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED'].includes(
        String(r.status),
      ) &&
      (r.clientId === null || uuid(r.clientId)) &&
      r.clientSecret === undefined &&
      Array.isArray(r.organizationIds) &&
      r.organizationIds.every(uuid),
  ) &&
  Array.isArray(v.organizations) &&
  v.organizations.length <= 500 &&
  v.organizations.every(
    (o) => obj(o) && uuid(o.id) && typeof o.name === 'string',
  ) &&
  Number.isInteger(v.page) &&
  typeof v.hasMore === 'boolean';
export const providerSecret = (v: unknown): v is ProviderSecret =>
  obj(v) &&
  (uuid(v.clientId) || uuid(v.id)) &&
  (v.clientSecret === undefined ||
    (typeof v.clientSecret === 'string' &&
      v.clientSecret.length >= 20 &&
      v.clientSecret.length <= 256 &&
      typeof v.tokenEndpoint === 'string' &&
      typeof v.oauthClientId === 'string'));
export type FhirStatus = {
  configured: boolean;
  counts: { status: string; count: number }[];
  failures: {
    personId: string;
    status: string;
    attempts: number;
    errorCode: string;
    updatedAt: string;
  }[];
};
export const fhirStatus = (v: unknown): v is FhirStatus =>
  obj(v) &&
  typeof v.configured === 'boolean' &&
  Array.isArray(v.counts) &&
  v.counts.every(
    (c) => obj(c) && typeof c.status === 'string' && Number.isInteger(c.count),
  ) &&
  Array.isArray(v.failures) &&
  v.failures.length <= 50 &&
  v.failures.every(
    (f) =>
      obj(f) &&
      uuid(f.personId) &&
      typeof f.status === 'string' &&
      Number.isInteger(f.attempts) &&
      typeof f.errorCode === 'string',
  );
