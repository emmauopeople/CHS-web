import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  historyPageSchema,
  installationHistoryRequestSchema,
  operationsHistoryRequestSchema,
  isHistoryPage,
  isHistoryRequest,
} from '../src/patient-history.mjs';
const read = async (path) =>
  JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const fixture = await read('../fixtures/history/v1/patient-history-page.json');
const request = await read(
  '../fixtures/history/v1/installation-history-request.json',
);
test('publishes matching JSON schemas accepted by an independent strict validator', async () => {
  const ajv = new Ajv({ strict: true, allErrors: true });
  addFormats(ajv);
  for (const [name, schema] of [
    ['patient-history-page', historyPageSchema],
    ['installation-history-request', installationHistoryRequestSchema],
    ['operations-history-request', operationsHistoryRequestSchema],
  ]) {
    const { $schema, $id, ...published } = await read(
      `../schemas/history/v1/${name}.schema.json`,
    );
    assert.deepEqual(published, schema);
    assert.ok($id);
    assert.ok($schema);
    ajv.compile(schema);
  }
  assert.equal(ajv.compile(historyPageSchema)(fixture), true);
  assert.equal(ajv.compile(installationHistoryRequestSchema)(request), true);
  assert.equal(isHistoryPage(fixture), true);
  assert.equal(isHistoryRequest(request, true), true);
});
test('fails closed on malformed attribution, nested content, unsafe projection and duplicate records', () => {
  for (const mutate of [
    (p) => delete p.items[0].author,
    (p) => (p.items[0].source.installationId = 'invalid'),
    (p) => (p.items[0].sourceRevision = 0),
    (p) => (p.items[0].data.localResourceId = 'source-id'),
    (p) => (p.items[0].data.noteText = 'x'.repeat(2001)),
    (p) => (p.items[1].data.currentStatus = 'INVENTED'),
    (p) => (p.items[3].data.rows[0].author = null),
    (p) => (p.items[4].data.rows[0].currentlyTaking = 'yes'),
    (p) => p.items.push(p.items[0]),
    (p) => (p.items = Array(51).fill(p.items[0])),
    (p) => (p.nextCursor = 'not-opaque'),
    (p) => (p.items[0].occurredAt = 'yesterday'),
  ]) {
    const changed = structuredClone(fixture);
    mutate(changed);
    assert.equal(isHistoryPage(changed), false);
  }
});
test('rejects unsupported scope, unbounded queries and malformed dates', () => {
  for (const mutate of [
    (r) => (r.organizationIds = ['client-scope']),
    (r) => (r.reasonCode = ''),
    (r) => (r.limit = 51),
    (r) => (r.limit = 0),
    (r) => (r.resourceTypes = ['ALL']),
    (r) => (r.fromDate = '2026-02-30'),
    (r) => delete r.localPatientId,
    (r) => delete r.requesterLocalActorId,
  ]) {
    const changed = structuredClone(request);
    mutate(changed);
    assert.equal(isHistoryRequest(changed, true), false);
  }
});
