#!/usr/bin/env node
'use strict';

// Compound-pipeline batch discovery and input assembly.
//
// Subcommands:
//   detect-pending                 → { pending, coverage, picker_threshold }
//   build-inputs --sprints ID,ID   → { inputs, span_label, proposal_basename,
//                                      conflicts, idempotency_violations }
//
// Both subcommands are read-only.

const fs = require('fs');
const path = require('path');
const yaml = require('../lib/yaml');
const config = require('../lib/config');
const paths = require('../lib/paths');
const { parse, die } = require('../lib/args');

function pad3(n) { return String(n).padStart(3, '0'); }

function readFm(p) {
  try { return yaml.splitFrontmatter(fs.readFileSync(p, 'utf8')).frontmatter || {}; }
  catch { return {}; }
}

function discoverPendingFindings(cwd) {
  const dir = path.join(paths.activeDir(cwd), 'findings');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    const m = f.match(/^SPRINT-(\d+)-findings\.md$/);
    if (m) out.push({ id: `SPRINT-${m[1]}`, num: parseInt(m[1], 10), path: path.join(dir, f) });
  }
  return out;
}

function coverageFromArchive(cwd) {
  // Returns a set of numeric IDs covered by an archived proposal.
  const covered = new Set();
  const dir = path.join(paths.archiveDir(cwd), 'compound');
  if (!fs.existsSync(dir)) return covered;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('-proposal.md')) continue;
    const single = f.match(/^SPRINT-(\d+)-proposal\.md$/);
    if (single) { covered.add(parseInt(single[1], 10)); continue; }
    const span = f.match(/^SPRINT-(\d+)-(\d+)-proposal\.md$/);
    if (span) {
      const lo = parseInt(span[1], 10), hi = parseInt(span[2], 10);
      for (let n = Math.min(lo, hi); n <= Math.max(lo, hi); n++) covered.add(n);
      continue;
    }
  }
  return covered;
}

function activeDrafts(cwd) {
  const dir = path.join(paths.activeDir(cwd), 'compound');
  const out = [];
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('-proposal.md')) continue;
      const p = path.join(dir, f);
      const fm = readFm(p);
      let sprints = null;
      if (Array.isArray(fm.sprints)) sprints = fm.sprints;
      else if (fm.sprint) sprints = [fm.sprint];
      out.push({ path: p, sprints });
    }
  }
  const legacy = path.join(paths.activeDir(cwd), 'COMPOUND-PROPOSAL.md');
  if (fs.existsSync(legacy)) {
    const fm = readFm(legacy);
    const sprints = Array.isArray(fm.sprints) ? fm.sprints : (fm.sprint ? [fm.sprint] : null);
    out.push({ path: legacy, sprints });
  }
  return out;
}

function globRecursive(root, matcher) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && matcher(e.name, p)) out.push(p);
    }
  }
  return out;
}

function detectPending(cwd) {
  const all = discoverPendingFindings(cwd);
  const covered = coverageFromArchive(cwd);
  const pending = all.filter((f) => !covered.has(f.num)).sort((a, b) => a.num - b.num);
  return {
    pending: pending.map((p) => p.id),
    pending_findings_paths: pending.map((p) => p.path),
    coverage_numeric: Array.from(covered).sort((a, b) => a - b),
    picker_threshold: Number(config.resolve('compound.pending_sprints.picker_threshold', 2, cwd)),
  };
}

function buildInputs(cwd, sprintIds) {
  if (!Array.isArray(sprintIds) || sprintIds.length === 0) die('batch-select', 'provide --sprints SPRINT-NNN[,SPRINT-MMM]');

  const nums = sprintIds.map((id) => {
    const m = String(id).match(/^SPRINT-(\d+)$/);
    if (!m) die('batch-select', `invalid sprint id: ${id}`);
    return parseInt(m[1], 10);
  });

  const covered = coverageFromArchive(cwd);
  const idempotency_violations = [];
  for (let i = 0; i < sprintIds.length; i++) {
    if (covered.has(nums[i])) idempotency_violations.push(sprintIds[i]);
  }

  const drafts = activeDrafts(cwd);
  const conflicts = [];
  for (const d of drafts) {
    if (!d.sprints) continue;
    for (const s of d.sprints) {
      if (sprintIds.includes(s)) conflicts.push({ draft_path: d.path, covers: s });
    }
  }

  const lo = Math.min(...nums), hi = Math.max(...nums);
  const spanLabel = sprintIds.length === 1 ? sprintIds[0] : `SPRINT-${pad3(lo)}-${pad3(hi)}`;
  const proposalBasename = sprintIds.length === 1 ? `${sprintIds[0]}-proposal.md` : `SPRINT-${pad3(lo)}-${pad3(hi)}-proposal.md`;

  // Per-sprint inputs.
  const inputs = [];
  const doneFiles = globRecursive(path.join(paths.archiveDir(cwd), 'done'), (n) => /^TASK-\d+-done\.md$/.test(n));
  const stuckFiles = globRecursive(path.join(paths.activeDir(cwd), 'stuck'), (n) => /^TASK-\d+-stuck\.md$/.test(n));

  for (const id of sprintIds) {
    let findingsPath = path.join(paths.activeDir(cwd), 'findings', `${id}-findings.md`);
    if (!fs.existsSync(findingsPath)) {
      const legacy = path.join(paths.activeDir(cwd), 'findings.md');
      if (fs.existsSync(legacy)) findingsPath = legacy;
    }
    const doneForSprint = doneFiles.filter((p) => (readFm(p).sprint || null) === id);
    const stuckForSprint = stuckFiles.filter((p) => (readFm(p).sprint || null) === id);
    inputs.push({
      sprint_id: id,
      findings_path: findingsPath,
      done_reports: doneForSprint,
      stuck_reports: stuckForSprint,
    });
  }

  return {
    inputs,
    span_label: spanLabel,
    proposal_basename: proposalBasename,
    active_draft_path: path.join(paths.activeDir(cwd), 'compound', proposalBasename),
    archive_destination: path.join(paths.archiveDir(cwd), 'compound', proposalBasename),
    idempotency_violations,
    conflicts,
    review_queue_path: paths.reviewQueuePath(cwd),
  };
}

function main() {
  const [subcmd, ...rest] = process.argv.slice(2);
  if (!subcmd) die('batch-select', 'usage: batch-select.js <detect-pending|build-inputs> [options]');
  const { opts } = parse(rest);

  if (subcmd === 'detect-pending') {
    process.stdout.write(JSON.stringify(detectPending(process.cwd()), null, 2) + '\n');
    return;
  }

  if (subcmd === 'build-inputs') {
    const sprintsArg = opts.sprints;
    if (!sprintsArg || sprintsArg === true) die('batch-select', 'build-inputs needs --sprints SPRINT-NNN[,SPRINT-MMM]');
    const sprintIds = String(sprintsArg).split(',').map((s) => s.trim()).filter(Boolean);
    process.stdout.write(JSON.stringify(buildInputs(process.cwd(), sprintIds), null, 2) + '\n');
    return;
  }

  die('batch-select', `unknown subcommand: ${subcmd}`);
}

main();
