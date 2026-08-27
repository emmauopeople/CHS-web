import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_SCANNED_FILE_BYTES = 5 * 1024 * 1024;

const secretRules = Object.freeze([
  {
    id: 'private-key',
    pattern:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/gu,
  },
  {
    id: 'github-token',
    pattern: /\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{36,255}\b/gu,
  },
  {
    id: 'github-fine-grained-token',
    pattern: /\bgithub_pat_[A-Za-z0-9_]{82,255}\b/gu,
  },
  {
    id: 'aws-access-key-id',
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu,
  },
  {
    id: 'google-api-key',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/gu,
  },
  {
    id: 'npm-access-token',
    pattern: /\bnpm_[A-Za-z0-9]{36}\b/gu,
  },
  {
    id: 'slack-token',
    pattern: /\bxox(?:a|b|p|r|s)-[A-Za-z0-9-]{20,}\b/gu,
  },
  {
    id: 'stripe-live-secret-key',
    pattern: /\bsk_live_[A-Za-z0-9]{20,}\b/gu,
  },
]);

function lineNumberAt(content, index) {
  let line = 1;
  for (let offset = 0; offset < index; offset += 1) {
    if (content.charCodeAt(offset) === 10) line += 1;
  }
  return line;
}

export function scanText(path, content) {
  const findings = [];

  for (const rule of secretRules) {
    rule.pattern.lastIndex = 0;
    for (const match of content.matchAll(rule.pattern)) {
      findings.push({
        path,
        line: lineNumberAt(content, match.index),
        rule: rule.id,
      });
    }
  }

  return findings.sort(
    (left, right) =>
      left.line - right.line || left.rule.localeCompare(right.rule),
  );
}

function trackedFiles(repositoryRoot) {
  const output = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  return output.split('\0').filter(Boolean);
}

function isBinary(buffer) {
  return buffer.includes(0);
}

export function scanRepository(repositoryRoot = process.cwd()) {
  const findings = [];

  for (const path of trackedFiles(repositoryRoot)) {
    const absolutePath = resolve(repositoryRoot, path);
    const file = lstatSync(absolutePath);
    if (!file.isFile() || file.size > MAX_SCANNED_FILE_BYTES) continue;

    const buffer = readFileSync(absolutePath);
    if (isBinary(buffer)) continue;
    findings.push(...scanText(path, buffer.toString('utf8')));
  }

  return findings.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.line - right.line ||
      left.rule.localeCompare(right.rule),
  );
}

export function formatFindings(findings) {
  return findings
    .map(({ path, line, rule }) => `${path}:${line}: ${rule}`)
    .join('\n');
}

export function main() {
  const findings = scanRepository();
  if (findings.length === 0) {
    process.stdout.write('Repository secret scan passed.\n');
    return;
  }

  process.stderr.write(
    `Repository secret scan found ${findings.length} high-confidence finding(s).\n`,
  );
  process.stderr.write(`${formatFindings(findings)}\n`);
  process.exitCode = 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) main();
