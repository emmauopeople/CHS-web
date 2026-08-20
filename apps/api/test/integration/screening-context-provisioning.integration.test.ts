import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateWithClient } from '../../../../packages/database/src/migration-runner.mjs';
import {
  parseScreeningContextProvisioningInput,
  provisionScreeningContext,
} from '../../src/administration/screening-context-provisioning.js';

const connectionString = process.env.DATABASE_TEST_URL;
const runIntegration = connectionString ? describe : describe.skip;
const now = new Date('2026-08-19T12:00:00.000Z');
const organizationId = '10000000-0000-4000-8000-000000000091';
const firstLocationId = '30000000-0000-4000-8000-000000000091';
const secondLocationId = '30000000-0000-4000-8000-000000000092';

runIntegration('screening context provisioning with PostgreSQL', () => {
  const schema = `chs_context_${randomUUID().replaceAll('-', '')}`;
  let administrationPool: pg.Pool;
  let servicePool: pg.Pool;

  beforeAll(async () => {
    administrationPool = new pg.Pool({ connectionString });
    const migrationClient = await administrationPool.connect();
    await migrationClient.query(`CREATE SCHEMA "${schema}"`);
    await migrationClient.query(`SET search_path TO "${schema}"`);
    await migrateWithClient({ client: migrationClient, logger: { info() {} } });
    migrationClient.release();

    servicePool = new pg.Pool({
      connectionString,
      options: `-c search_path=${schema}`,
    });
  });

  afterAll(async () => {
    await servicePool.end();
    await administrationPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await administrationPool.end();
  });

  it('atomically creates a canonical organization/location pair and audit', async () => {
    const ids = [
      organizationId,
      firstLocationId,
      '81000000-0000-4000-8000-000000000091',
      '82000000-0000-4000-8000-000000000091',
    ];
    await expect(
      provisionScreeningContext(servicePool, firstInput(), {
        now,
        randomId: () => ids.shift()!,
      }),
    ).resolves.toEqual({
      kind: 'PROVISIONED',
      organizationId,
      locationId: firstLocationId,
      organizationCreated: true,
      locationCreated: true,
      processedAt: now.toISOString(),
    });

    const canonical = await servicePool.query(
      `SELECT
         organization.identifier_system AS organization_system,
         organization.identifier_value AS organization_value,
         organization.name AS organization_name,
         organization.active AS organization_active,
         location.identifier_system AS location_system,
         location.identifier_value AS location_value,
         location.name AS location_name,
         location.physical_type_code,
         location.active AS location_active
       FROM organizations AS organization
       JOIN locations AS location ON location.organization_id = organization.id`,
    );
    expect(canonical.rows[0]).toEqual({
      organization_system: 'https://chs.example/id/organization',
      organization_value: 'ORG-NORTHWEST-091',
      organization_name: 'Northwest Screening Program',
      organization_active: true,
      location_system: 'urn:chs:screening-location',
      location_value: 'LOC-BAFOUSSAM-091',
      location_name: 'Bafoussam Community Site',
      physical_type_code: 'MOBILE',
      location_active: true,
    });
    const audit = await servicePool.query(
      `SELECT action_code, entity_type, entity_id, outcome_code, metadata
       FROM audit_events`,
    );
    expect(audit.rows[0]).toEqual({
      action_code: 'SCREENING_CONTEXT_PROVISION',
      entity_type: 'ORGANIZATION',
      entity_id: organizationId,
      outcome_code: 'SUCCESS',
      metadata: {
        locationId: firstLocationId,
        locationIdentifierSystem: 'urn:chs:screening-location',
        locationIdentifierValue: 'LOC-BAFOUSSAM-091',
        operatorIdentifier: 'platform-admin@example.test',
        organizationCreated: true,
        organizationIdentifierSystem: 'https://chs.example/id/organization',
        organizationIdentifierValue: 'ORG-NORTHWEST-091',
      },
    });
  });

  it('returns the existing IDs for an exact retry without duplicate audit', async () => {
    await expect(
      provisionScreeningContext(servicePool, firstInput(), {
        now: new Date('2026-08-19T12:30:00.000Z'),
        randomId: () => {
          throw new Error('Exact retry must not allocate IDs');
        },
      }),
    ).resolves.toEqual({
      kind: 'ALREADY_PROVISIONED',
      organizationId,
      locationId: firstLocationId,
      organizationCreated: false,
      locationCreated: false,
      processedAt: '2026-08-19T12:30:00.000Z',
    });
    expect(await counts()).toEqual({ organizations: 1, locations: 1, audits: 1 });
  });

  it('adds another location to the same exact organization', async () => {
    const ids = [
      secondLocationId,
      '81000000-0000-4000-8000-000000000092',
      '82000000-0000-4000-8000-000000000092',
    ];
    await expect(
      provisionScreeningContext(servicePool, secondLocationInput(), {
        now: new Date('2026-08-19T13:00:00.000Z'),
        randomId: () => ids.shift()!,
      }),
    ).resolves.toMatchObject({
      kind: 'PROVISIONED',
      organizationId,
      locationId: secondLocationId,
      organizationCreated: false,
      locationCreated: true,
    });
    expect(await counts()).toEqual({ organizations: 1, locations: 2, audits: 2 });
  });

  it('rejects changed canonical data under existing identifiers', async () => {
    const before = await counts();
    await expect(
      provisionScreeningContext(servicePool, {
        ...firstInput(),
        organizationName: 'Changed Organization Name',
      }),
    ).rejects.toMatchObject({ code: 'ORGANIZATION_IDENTIFIER_CONFLICT' });
    await expect(
      provisionScreeningContext(servicePool, {
        ...firstInput(),
        locationName: 'Changed Location Name',
      }),
    ).rejects.toMatchObject({ code: 'LOCATION_IDENTIFIER_CONFLICT' });
    expect(await counts()).toEqual(before);
  });

  function firstInput() {
    return parseScreeningContextProvisioningInput({
      organizationIdentifierSystem: 'https://chs.example/id/organization',
      organizationIdentifierValue: 'ORG-NORTHWEST-091',
      organizationName: 'Northwest Screening Program',
      organizationTypeCode: 'SCREENING_PROGRAM',
      locationIdentifierSystem: 'urn:chs:screening-location',
      locationIdentifierValue: 'LOC-BAFOUSSAM-091',
      locationName: 'Bafoussam Community Site',
      locationTypeCode: 'SCREENING_SITE',
      physicalTypeCode: 'MOBILE',
      village: 'Bafoussam',
      subdivision: null,
      region: 'West',
      directions: null,
      operatorIdentifier: 'platform-admin@example.test',
      reasonCode: 'INITIAL_PROVISIONING',
    });
  }

  function secondLocationInput() {
    return parseScreeningContextProvisioningInput({
      ...firstInput(),
      locationIdentifierValue: 'LOC-BAMENDA-092',
      locationName: 'Bamenda Community Site',
      village: 'Bamenda',
      region: 'Northwest',
      reasonCode: 'ADD_SCREENING_LOCATION',
    });
  }

  async function counts() {
    const result = await servicePool.query(
      `SELECT
         (SELECT count(*)::integer FROM organizations) AS organizations,
         (SELECT count(*)::integer FROM locations) AS locations,
         (SELECT count(*)::integer FROM audit_events) AS audits`,
    );
    return result.rows[0];
  }
});
