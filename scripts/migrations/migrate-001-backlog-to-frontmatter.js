#!/usr/bin/env node
'use strict';

// Migrate from backlog.json (legacy) to per-plan frontmatter status.
//
// For each task in .soloflow/active/backlog.json, find the matching plan
// file under active/plans/**/TASK-NNN-plan.md and write `status` (and
// `deferred_at` if present) into its frontmatter. After all tasks process
// successfully, move backlog.json to archive/legacy/backlog.json and stamp
// .soloflow/state-version.
//
// Idempotent: re-running is a no-op once backlog.json is gone.
//
// Usage:
//   node migrate-001-backlog-to-frontmatter.js [--apply]
//
// Without --apply, prints the change set as a dry run and exits 0.

const fs = require('fs');
const path = require('path');
const yaml = require('../lib/yaml');
const paths = require('../lib/paths');
const { writeAtomic } = require('../lib/fs-atomic');

const MIGRATION_ID = '001-backlog-to-frontmatter';

function die(msg, code = 1) {
  process.stderr.write(`migrate-${MIGRATION_ID}: ${msg}\n`);
  process.exit(code);
}

function globPlans(plansRoot) {
  const out = [];
  if (!fs.existsSync(plansRoot)) return out;
  const stack = [plansRoot];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && /^TASK-\d+-plan\.md$/.test(e.name)) out.push(p);
    }
  }
  return out;
}

function taskIdFromFilename(file) {
  const m = path.basename(file).match(/^TASK-(\d+)-plan\.md$/);
  return m ? `TASK-${m[1]}` : null;
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

function archiveBacklog(cwd) {
  const src = paths.backlogJsonPath(cwd);
  const dstDir = path.join(paths.archiveDir(cwd), 'legacy');
  fs.mkdirSync(dstDir, { recursive: true });
  const dst = path.join(dstDir, 'backlog.json');
  fs.renameSync(src, dst);
  return dst;
}

function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const cwd = process.cwd();

  const backlogPath = paths.backlogJsonPath(cwd);
  if (!fs.existsSync(backlogPath)) {
    process.stdout.write(`migrate-${MIGRATION_ID}: backlog.json not present; nothing to migrate\n`);
    return;
  }

  const stateVersion = readStateVersion(cwd);
  if (stateVersion[`migrated_${MIGRATION_ID.split('-')[0]}`]) {
    process.stdout.write(`migrate-${MIGRATION_ID}: already applied at ${stateVersion[`migrated_${MIGRATION_ID.split('-')[0]}`]}\n`);
    return;
  }

  let backlog;
  try { backlog = JSON.parse(fs.readFileSync(backlogPath, 'utf8')); }
  catch (e) { die(`backlog.json is not valid JSON: ${e.message}`); }

  const tasks = (backlog && backlog.tasks) || {};
  const taskIds = Object.keys(tasks);

  const planFiles = globPlans(path.join(paths.activeDir(cwd), 'plans'));
  const planByTask = new Map();
  for (const p of planFiles) {
    const id = taskIdFromFilename(p);
    if (id) planByTask.set(id, p);
  }

  const changes = [];
  const skipped = [];
  for (const id of taskIds) {
    const t = tasks[id] || {};
    const planPath = planByTask.get(id);
    if (!planPath) {
      skipped.push({ id, reason: 'no plan file on disk', backlog_status: t.status || null });
      continue;
    }
    const text = fs.readFileSync(planPath, 'utf8');
    const split = yaml.splitFrontmatter(text);
    const fm = split.frontmatter || {};
    const updates = {};
    if (t.status !== undefined && fm.status !== t.status) updates.status = t.status;
    if (t.deferred_at !== undefined && fm.deferred_at !== t.deferred_at) updates.deferred_at = t.deferred_at;
    if (Object.keys(updates).length === 0) {
      skipped.push({ id, reason: 'frontmatter already matches', backlog_status: t.status || null });
      continue;
    }
    changes.push({ id, plan_path: path.relative(cwd, planPath), updates });
    if (apply) {
      const newFm = { ...fm, ...updates };
      writeAtomic(planPath, yaml.joinFrontmatter(newFm, split.body));
    }
  }

  const summary = {
    backlog_path: path.relative(cwd, backlogPath),
    total_in_backlog: taskIds.length,
    plans_to_update: changes.length,
    skipped: skipped.length,
    changes,
    skipped_detail: skipped,
    apply,
  };

  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');

  if (!apply) {
    process.stdout.write(`\nDry run. Re-run with --apply to mutate state.\n`);
    return;
  }

  const archived = archiveBacklog(cwd);
  writeStateVersion(cwd, {
    ...stateVersion,
    [`migrated_001`]: new Date().toISOString(),
  });
  process.stdout.write(`\nApplied. Archived backlog.json → ${path.relative(cwd, archived)}\n`);
}

main();
