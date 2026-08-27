import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatFindings, scanText } from './scan-repository-secrets.mjs';

test('detects high-confidence credential formats without returning values', () => {
  const awsKey = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
  const privateKeyHeader = ['-----BEGIN RSA ', 'PRIVATE KEY-----'].join('');
  const content = `cloud=${awsKey}\nkey=${privateKeyHeader}\n`;

  const findings = scanText('synthetic.txt', content);

  assert.deepEqual(findings, [
    { path: 'synthetic.txt', line: 1, rule: 'aws-access-key-id' },
    { path: 'synthetic.txt', line: 2, rule: 'private-key' },
  ]);
  assert.doesNotMatch(JSON.stringify(findings), new RegExp(awsKey));
  assert.doesNotMatch(formatFindings(findings), new RegExp(awsKey));
});

test('does not flag documented placeholders or local-only test credentials', () => {
  const content = [
    'DATABASE_URL=postgresql://chs:chs-local-only@localhost:5432/chs',
    'Authorization: Bearer <installation-token>',
    'token=replace-me',
  ].join('\n');

  assert.deepEqual(scanText('.env.example', content), []);
});

test('reports every matching line without exposing matched text', () => {
  const githubToken = ['ghp_', 'A'.repeat(36)].join('');
  const npmToken = ['npm_', 'B'.repeat(36)].join('');

  const findings = scanText(
    'credentials.txt',
    `first=${githubToken}\nsecond=${npmToken}\n`,
  );

  assert.equal(
    formatFindings(findings),
    [
      'credentials.txt:1: github-token',
      'credentials.txt:2: npm-access-token',
    ].join('\n'),
  );
});
