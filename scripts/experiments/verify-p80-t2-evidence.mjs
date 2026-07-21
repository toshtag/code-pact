#!/usr/bin/env node
// Verify P80-T2 trial evidence archive.
// Usage: node scripts/experiments/verify-p80-t2-evidence.mjs <zip-path>

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

const zipPath = process.argv[2];

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

if (!zipPath || !fs.existsSync(zipPath)) {
  fail(`evidence ZIP not found: ${zipPath}`);
}

const required = [
  'manifest.json',
  'model-identity.json',
  'capability-source.ts',
  'capability-oracle.mjs',
  'capability-prompt.txt',
  'capability-response.json',
  'capability-metrics.json',
  'pair-source.ts',
  'hidden-oracle.mjs',
  'reference.patch',
  'oracle-preflight.json',
  'baseline-prompt.txt',
  'baseline-response.json',
  'baseline-metrics.json',
  'code-pact-prompt.txt',
  'code-pact-response.json',
  'code-pact-metrics.json',
  'final-metrics.json',
  'command-log.json',
  'p80-task.yaml',
  'contract-lock.yaml',
  'start-event.yaml',
  'hashes.json'
];

const tmpDir = fs.mkdtempSync('/tmp/p80-t2-verify-');
try {
  execSync(`unzip -q "${zipPath}" -d "${tmpDir}"`);

  for (const f of required) {
    const p = path.join(tmpDir, f);
    if (!fs.existsSync(p)) {
      fail(`missing required file: ${f}`);
    }
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(tmpDir, 'manifest.json'), 'utf8'));
  if (manifest.trial_id !== 'P80-T2') {
    fail(`trial_id mismatch: ${manifest.trial_id}`);
  }
  if (manifest.pair_status !== 'non_discriminating' && manifest.pair_status !== 'qualified' && manifest.pair_status !== 'not_started') {
    fail(`unexpected pair_status: ${manifest.pair_status}`);
  }

  const expected = JSON.parse(fs.readFileSync(path.join(tmpDir, 'hashes.json'), 'utf8'));
  for (const f in expected) {
    const p = path.join(tmpDir, f);
    if (!fs.existsSync(p)) {
      fail(`hashes.json references missing file: ${f}`);
    }
    const actual = sha256File(p);
    if (actual !== expected[f]) {
      fail(`hash mismatch for ${f}: expected ${expected[f]}, actual ${actual}`);
    }
  }

  console.log('OK: P80-T2 evidence archive is complete and hash-verified.');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
