export type DesktopInstallation = {
  id: string;
  organizationId: string;
  organizationName: string;
  configuredLocationId: string;
  locationName: string;
  deploymentName: string;
  timezone: string;
  status: string;
  enrolledAt: string;
  lastSeenAt: string | null;
  credentialId: string | null;
  tokenPrefix: string | null;
  credentialExpiresAt: string | null;
  credentialStatus: 'ACTIVE' | 'EXPIRED' | 'REVOKED';
};
export type InstallationLocation = {
  id: string;
  organizationId: string;
  name: string;
  organizationName: string;
};
export type InstallationPage = {
  items: DesktopInstallation[];
  page: number;
  hasMore: boolean;
  locations: InstallationLocation[];
  locationsTruncated: boolean;
};
export type InstallationToken = {
  installationId: string;
  credentialId: string;
  credentialExpiresAt: string | null;
  installationToken: string;
  issuedAt: string;
};
export type EnrollmentInput = {
  reasonCode: 'INSTALLATION_ADMINISTRATION';
  installationId: string;
  organizationId: string;
  configuredLocationId: string;
  sourceLocationId: string;
  deploymentName: string;
  timezone: string;
  credentialLabel: string;
  credentialExpiresAt: string;
};
export type RotationInput = {
  reasonCode: 'INSTALLATION_ADMINISTRATION';
  installationId: string;
  expectedCredentialId: string;
  credentialLabel: string;
  credentialExpiresAt: string;
  confirmation: 'ROTATE_INSTALLATION_CREDENTIAL';
};
export type RevocationInput = {
  reasonCode: 'INSTALLATION_ADMINISTRATION';
  installationId: string;
  credentialId: string;
  confirmation: 'REVOKE_INSTALLATION_CREDENTIAL';
};
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
const instant = (value: unknown) =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));
export function installationPage(value: unknown): value is InstallationPage {
  return (
    object(value) &&
    Number.isInteger(value.page) &&
    Number(value.page) >= 1 &&
    typeof value.hasMore === 'boolean' &&
    typeof value.locationsTruncated === 'boolean' &&
    Array.isArray(value.items) &&
    value.items.length <= 50 &&
    value.items.every(
      (row) =>
        object(row) &&
        uuid(row.id) &&
        uuid(row.organizationId) &&
        uuid(row.configuredLocationId) &&
        [
          'organizationName',
          'locationName',
          'deploymentName',
          'timezone',
          'status',
        ].every((key) => typeof row[key] === 'string') &&
        instant(row.enrolledAt) &&
        (row.lastSeenAt === null || instant(row.lastSeenAt)) &&
        (row.credentialId === null || uuid(row.credentialId)) &&
        (row.tokenPrefix === null ||
          (typeof row.tokenPrefix === 'string' &&
            row.tokenPrefix.length <= 20)) &&
        (row.credentialExpiresAt === null ||
          instant(row.credentialExpiresAt)) &&
        ['ACTIVE', 'EXPIRED', 'REVOKED'].includes(
          String(row.credentialStatus),
        ) &&
        !('installationToken' in row) &&
        !('tokenHash' in row) &&
        !('token_hash' in row),
    ) &&
    Array.isArray(value.locations) &&
    value.locations.length <= 500 &&
    value.locations.every(
      (row) =>
        object(row) &&
        uuid(row.id) &&
        uuid(row.organizationId) &&
        typeof row.name === 'string' &&
        typeof row.organizationName === 'string',
    )
  );
}
export function installationToken(value: unknown): value is InstallationToken {
  return (
    object(value) &&
    uuid(value.installationId) &&
    uuid(value.credentialId) &&
    typeof value.installationToken === 'string' &&
    /^chs_inst_v1_[A-Za-z0-9_-]{43}$/.test(value.installationToken) &&
    (value.credentialExpiresAt === null ||
      instant(value.credentialExpiresAt)) &&
    instant(value.issuedAt)
  );
}
export function installationRevocation(
  value: unknown,
): value is {
  kind: 'REVOKED' | 'ALREADY_REVOKED';
  installationId: string;
  credentialId: string;
  revokedAt: string;
} {
  return (
    object(value) &&
    ['REVOKED', 'ALREADY_REVOKED'].includes(String(value.kind)) &&
    uuid(value.installationId) &&
    uuid(value.credentialId) &&
    instant(value.revokedAt)
  );
}
