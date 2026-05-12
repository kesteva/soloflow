#!/usr/bin/env node
'use strict';

// Migrate from singleton .soloflow/active/sprint.json to per-sprint layout
// at .soloflow/active/sprints/<sprint.id>/sprint.json.
//
// Idempotent: re-running after the move is a no-op (the legacy file is
// gone). Missing legacy file is a clean no-op.
//
// Usage:
//   node migrate-002-per-sprint-sprint-json.js [--apply]
//
// Without --apply, prints the planned move and exits 0.

const fs = require('fs');
const path = require('path');
const yaml = require('../lib/yaml');
const paths = require('../lib/paths');
const { writeAtomic } = require('../lib/fs-atomic');

const MIGRATION_ID = '002-per-sprint-sprint-json';

function die(msg, code = 1) {
  process.stderr.write(`migrate-${MIGRATION_ID}: ${msg}\n`);
  process.exit(code);
}

function readStateVersion(cwd) {
  const p = path.join(paths.stateRoot(cwd), 'state-version');
  if (!fs.existsSync(p)) return {};
  try { return yaml.parse(fs.readFileSync(p, 'utf8')) || {}; }
  catch { return {}; }
}

function writeStateVersion(cwd, version) {
  const p = path.join(paths.stateRoot(cwd), 'state-version');
  const text = yaml.serialize(version);
  const content = (text.startsWith('\n') ? text.slice(1) : text) + '\n';
  writeAtomic(p, content);
}

function main() {
  const apply = process.argv.includes('--apply');
  const cwd = process.cwd();

  const legacyPath = paths.legacySprintJsonPath(cwd);
  if (!fs.existsSync(legacyPath)) {
    process.stdout.write(`migrate-${MIGRATION_ID}: legacy active/sprint.json not present; nothing to migrate\n`);
    return;
  }

  const stateVersion = readStateVersion(cwd);
  if (stateVersion.migrated_002) {
    process.stdout.write(`migrate-${MIGRATION_ID}: already applied at ${stateVersion.migrated_002}\n`);
    return;
  }

  let json;
  try { json = JSON.parse(fs.readFileSync(legacyPath, 'utf8')); }
  catch (e) { die(`legacy sprint.json is not valid JSON: ${e.message}`); }

  if (!json || !json.sprint || !json.sprint.id) {
    die('legacy sprint.json missing sprint.id — cannot derive target directory; manual intervention required');
  }

  const sprintId = json.sprint.id;
  const targetPath = paths.sprintJsonPath(cwd, sprintId);
  const targetDir = paths.sprintDirPath(cwd, sprintId);

  const summary = {
    legacy_path: path.relative(cwd, legacyPath),
    target_path: path.relative(cwd, targetPath),
    sprint_id: sprintId,
    apply,
  };

  if (fs.existsSync(targetPath)) {
    summary.skipped_reason = 'target already exists';
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    return;
  }

  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');

  if (!apply) {
    process.stdout.write(`\nDry run. Re-run with --apply to mutate state.\n`);
    return;
  }

  fs.mkdirSync(targetDir, { recursive: true });
  fs.renameSync(legacyPath, targetPath);

  writeStateVersion(cwd, {
    ...stateVersion,
    migrated_002: new Date().toISOString(),
  });

  process.stdout.write(`\nApplied. Moved active/sprint.json → ${path.relative(cwd, targetPath)}\n`);
}

main();
