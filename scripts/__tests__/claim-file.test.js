'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const yaml = require('../lib/yaml');
const { mktmp, scaffold, run, writePlan } = require('./helpers');

function readFm(planPath) {
  return yaml.splitFrontmatter(fs.readFileSync(planPath, 'utf8')).frontmatter || {};
}

test('claim-file add: grants when no other in-flight task owns the path', () => {
  const cwd = scaffold(mktmp());
  const planPath = writePlan(cwd, 'TASK-001', { status: 'in-flight', files_owned: ['src/a.js'] });

  const r = run('state/claim-file.js', ['add', 'TASK-001', 'src/b.js'], { cwd });
  assert.equal(r.ok, true, r.err);

  const data = JSON.parse(r.out);
  assert.equal(data.ok, true);
  assert.deepEqual(data.files_owned, ['src/a.js', 'src/b.js']);

  const fm = readFm(planPath);
  assert.deepEqual(fm.files_owned, ['src/a.js', 'src/b.js']);
});

test('claim-file add: denies when another in-flight task owns the path', () => {
  const cwd = scaffold(mktmp());
  writePlan(cwd, 'TASK-001', { status: 'in-flight', files_owned: ['src/shared.js'] });
  writePlan(cwd, 'TASK-002', { status: 'in-flight', files_owned: [] });

  const r = run('state/claim-file.js', ['add', 'TASK-002', 'src/shared.js'], { cwd });
  assert.equal(r.ok, true, r.err);

  const data = JSON.parse(r.out);
  assert.equal(data.ok, false);
  assert.equal(data.conflict_with, 'TASK-001');
  assert.equal(data.path, 'src/shared.js');
});

test('claim-file add: ignores ready/deferred/done plans (only in-flight count)', () => {
  const cwd = scaffold(mktmp());
  writePlan(cwd, 'TASK-001', { status: 'ready', files_owned: ['src/shared.js'] });
  writePlan(cwd, 'TASK-002', { status: 'in-flight', files_owned: [] });

  const r = run('state/claim-file.js', ['add', 'TASK-002', 'src/shared.js'], { cwd });
  assert.equal(r.ok, true, r.err);

  const data = JSON.parse(r.out);
  assert.equal(data.ok, true);
});

test('claim-file add: idempotent — re-claim of already-owned path is a no-op grant', () => {
  const cwd = scaffold(mktmp());
  writePlan(cwd, 'TASK-001', { status: 'in-flight', files_owned: ['src/a.js'] });

  const r = run('state/claim-file.js', ['add', 'TASK-001', 'src/a.js'], { cwd });
  assert.equal(r.ok, true, r.err);

  const data = JSON.parse(r.out);
  assert.equal(data.ok, true);
  assert.equal(data.already_owned, true);
});

test('claim-file list: returns current files_owned', () => {
  const cwd = scaffold(mktmp());
  writePlan(cwd, 'TASK-001', { status: 'in-flight', files_owned: ['src/a.js', 'src/b.js'] });

  const r = run('state/claim-file.js', ['list', 'TASK-001'], { cwd });
  assert.equal(r.ok, true, r.err);

  const data = JSON.parse(r.out);
  assert.equal(data.task, 'TASK-001');
  assert.deepEqual(data.files_owned, ['src/a.js', 'src/b.js']);
});

test('claim-file add: missing plan returns error result', () => {
  const cwd = scaffold(mktmp());
  const r = run('state/claim-file.js', ['add', 'TASK-099', 'src/x.js'], { cwd });
  // Exits 2 on the no-plan error case.
  assert.equal(r.code, 2);
  const data = JSON.parse(r.out);
  assert.equal(data.ok, false);
  assert.match(data.error, /no plan file/);
});

test('claim-file add: rejects malformed task ID', () => {
  const cwd = scaffold(mktmp());
  const r = run('state/claim-file.js', ['add', 'TASK-NOPE', 'src/x.js'], { cwd });
  assert.equal(r.ok, false);
  assert.match(r.err, /invalid task ID/);
});

test('claim-file add: concurrent claimers serialize via the lock (no double-grant)', async () => {
  const cwd = scaffold(mktmp());
  writePlan(cwd, 'TASK-001', { status: 'in-flight', files_owned: [] });
  writePlan(cwd, 'TASK-002', { status: 'in-flight', files_owned: [] });

  const root = path.resolve(__dirname, '..', '..');
  const script = path.join(root, 'scripts', 'state', 'claim-file.js');

  function spawnClaim(taskId, claimPath) {
    return new Promise((resolve) => {
      const child = spawn('node', [script, 'add', taskId, claimPath], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (b) => { out += b.toString(); });
      child.stderr.on('data', (b) => { err += b.toString(); });
      child.on('close', (code) => resolve({ code, out, err }));
    });
  }

  const [r1, r2] = await Promise.all([
    spawnClaim('TASK-001', 'src/contended.js'),
    spawnClaim('TASK-002', 'src/contended.js'),
  ]);

  const d1 = JSON.parse(r1.out);
  const d2 = JSON.parse(r2.out);

  // Exactly one grant, exactly one denial.
  const oks = [d1.ok, d2.ok];
  const grants = oks.filter((x) => x === true).length;
  const denies = oks.filter((x) => x === false).length;
  assert.equal(grants, 1, `expected exactly one grant, got d1=${JSON.stringify(d1)} d2=${JSON.stringify(d2)}`);
  assert.equal(denies, 1);

  // The denied one must reference the granted one.
  const denied = d1.ok ? d2 : d1;
  const granted = d1.ok ? 'TASK-001' : 'TASK-002';
  assert.equal(denied.conflict_with, granted);
});
