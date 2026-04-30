#!/usr/bin/env node
'use strict';

// SoloFlow ID allocator.
//   --kind sprint               → next SPRINT-NNN
//   --kind task                 → next TASK-NNN
//   --kind finding --sprint ID  → next FIND-<sprint_id>-N
//
// Zero-padding: 3 for sprints/tasks, none for findings.

const fs = require('fs');
const path = require('path');
const { parse, die } = require('../lib/args');
const paths = require('../lib/paths');
const { withFileLock } = require('../lib/lock');

function globAll(root, re) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else if (entry.isFile() && re.test(entry.name)) out.push(p);
    }
  }
  return out;
}

function extractMaxNumericSuffix(files, re) {
  let max = 0;
  for (const f of files) {
    const base = path.basename(f);
    const m = base.match(re);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (!Number.isNaN(n) && n > max) max = n;
  }
  return max;
}

function nextSprintId(cwd) {
  // Glob archive/compound + archive/findings + active/findings + active/compound,
  // plus the current sprint.json's sprint.id.
  const re = /^SPRINT-(\d+)-(?:proposal|findings)\.md$/;
  const candidates = [
    path.join(paths.archiveDir(cwd), 'compound'),
    path.join(paths.archiveDir(cwd), 'findings'),
    path.join(paths.activeDir(cwd), 'findings'),
    path.join(paths.activeDir(cwd), 'compound'),
  ];

  let max = 0;
  for (const dir of candidates) {
    const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    for (const f of files) {
      // Also handle span filenames SPRINT-AAA-BBB-proposal.md — take MAX.
      const span = f.match(/^SPRINT-(\d+)-(\d+)-proposal\.md$/);
      if (span) {
        const hi = parseInt(span[2], 10);
        if (hi > max) max = hi;
        continue;
      }
      const m = f.match(re);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > max) max = n;
      }
    }
  }

  // Active sprints (per-sprint layout: active/sprints/<id>/sprint.json)
  for (const entry of paths.findActiveSprintIds(cwd)) {
    const m = String(entry.id).match(/^SPRINT-(\d+)$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }

  const next = max + 1;
  return 'SPRINT-' + String(next).padStart(3, '0');
}

function nextTaskIdSync(cwd) {
  const re = /^TASK-(\d+)-(?:plan|stuck|done)\.md$/;
  const roots = [
    path.join(paths.activeDir(cwd), 'plans'),
    path.join(paths.activeDir(cwd), 'stuck'),
    path.join(paths.archiveDir(cwd), 'done'),
    path.join(paths.archiveDir(cwd), 'stuck'),
  ];
  let files = [];
  for (const r of roots) files = files.concat(globAll(r, re));
  const max = extractMaxNumericSuffix(files, re);
  return 'TASK-' + String(max + 1).padStart(3, '0');
}

// Locked variant: serializes the read-and-suggest window so concurrent
// allocators don't compute the same "next" id at the same instant. The
// final write-time uniqueness guarantee still relies on the caller's
// wx/noclobber semantics — the lock just narrows the race window.
async function nextTaskId(cwd) {
  return withFileLock(paths.idAllocatorLockPath(cwd), () => nextTaskIdSync(cwd));
}

function nextFindingId(sprintId, cwd) {
  if (!/^SPRINT-\d+(?:-\w+)?$/.test(sprintId)) die('next-ids', `invalid --sprint: ${sprintId}`);
  const p = paths.findingsFilePath(sprintId, cwd);
  if (!fs.existsSync(p)) return `FIND-${sprintId}-1`;
  const text = fs.readFileSync(p, 'utf8');
  const re = new RegExp(`^##\\s+FIND-${sprintId.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}-(\\d+)`, 'gm');
  let max = 0;
  let m;
  while ((m = re.exec(text))) {
    const n = parseInt(m[1], 10);
    if (n > max) max = n;
  }
  return `FIND-${sprintId}-${max + 1}`;
}

async function main() {
  const { opts } = parse(process.argv.slice(2));
  const kind = opts.kind;
  if (!kind) die('next-ids', 'usage: next-ids.js --kind {sprint|task|finding [--sprint SPRINT-NNN]}');
  const cwd = process.cwd();
  let result;
  if (kind === 'sprint') result = nextSprintId(cwd);
  else if (kind === 'task') result = await nextTaskId(cwd);
  else if (kind === 'finding') {
    if (!opts.sprint) die('next-ids', '--kind finding requires --sprint SPRINT-NNN');
    result = nextFindingId(opts.sprint, cwd);
  } else die('next-ids', `unknown --kind: ${kind}`);
  process.stdout.write(result + '\n');
}

main().catch((e) => die('next-ids', e.message || String(e)));
