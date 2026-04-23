#!/usr/bin/env node
'use strict';

// Cruft detection for /soloflow:review-queue step 1a.
// Read-only. Emits JSON grouped by scenario. The orchestrator gates each
// item with AskUserQuestion and applies resolutions via the existing
// settle-task.js, git mv, or explicit rm commands — no mutations here.
//
// Scenarios:
//   1. orphan_plan          — plan exists in active/plans AND a done report exists
//   2. ghost_sprint_entry   — sprint.json task in stuck/blocked/human_needed but
//                             no plan or stuck file on disk
//   3. stale_stuck_file     — stuck file whose TASK isn't in sprint.json
//   4. mid_commit_settle    — done report exists AND task still listed in sprint.json
//   5. empty_epic           — epic folder with no TASK plans AND no tasks in sprint.json
//                             matching the epic slug
//   6. malformed_queue      — human-review-queue entries missing required fields
//   7. completed_in_backlog — done report exists AND task still listed in backlog.json

const fs = require('fs');
const path = require('path');
const yaml = require('../lib/yaml');
const paths = require('../lib/paths');
const rq = require('../lib/review-queue');

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

function readSprint(cwd) {
  const p = paths.sprintJsonPath(cwd);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

function readBacklog(cwd) {
  const p = paths.backlogJsonPath(cwd);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

function readFm(p) {
  try { return yaml.splitFrontmatter(fs.readFileSync(p, 'utf8')).frontmatter || {}; }
  catch { return {}; }
}

function taskIdFromFilename(file) {
  const m = path.basename(file).match(/^TASK-(\d+)-(?:plan|stuck|done)\.md$/);
  return m ? `TASK-${m[1]}` : null;
}

function main() {
  const cwd = process.cwd();
  const state = readSprint(cwd);
  const sprintTasks = (state && state.tasks) || {};
  const backlog = readBacklog(cwd);
  const backlogTasks = (backlog && backlog.tasks) || {};

  const planFiles = globRecursive(path.join(paths.activeDir(cwd), 'plans'), (n) => /^TASK-\d+-plan\.md$/.test(n));
  const doneFiles = globRecursive(path.join(paths.archiveDir(cwd), 'done'), (n) => /^TASK-\d+-done\.md$/.test(n));
  const stuckFiles = globRecursive(path.join(paths.activeDir(cwd), 'stuck'), (n) => /^TASK-\d+-stuck\.md$/.test(n));

  const doneByTask = new Map();
  for (const d of doneFiles) { const id = taskIdFromFilename(d); if (id) doneByTask.set(id, d); }
  const planByTask = new Map();
  for (const p of planFiles) { const id = taskIdFromFilename(p); if (id) planByTask.set(id, p); }
  const stuckByTask = new Map();
  for (const s of stuckFiles) { const id = taskIdFromFilename(s); if (id) stuckByTask.set(id, s); }

  // Scenario 1 — orphan plan.
  const orphan_plan = [];
  for (const [id, planPath] of planByTask) {
    if (doneByTask.has(id)) orphan_plan.push({ task_id: id, plan_path: planPath, done_path: doneByTask.get(id) });
  }

  // Scenario 2 — ghost sprint entry.
  const ghost_sprint_entry = [];
  if (state) {
    for (const [id, t] of Object.entries(sprintTasks)) {
      if (!t) continue;
      if (!['stuck', 'blocked', 'human_needed'].includes(t.status)) continue;
      if (!planByTask.has(id) && !stuckByTask.has(id)) {
        ghost_sprint_entry.push({ task_id: id, status: t.status });
      }
    }
  }

  // Scenario 3 — stale stuck file.
  const stale_stuck_file = [];
  for (const [id, stuckPath] of stuckByTask) {
    if (sprintTasks[id]) continue;
    const has_done = doneByTask.has(id);
    stale_stuck_file.push({ task_id: id, stuck_path: stuckPath, has_done_report: has_done });
  }

  // Scenario 4 — mid-commit settle crash.
  const mid_commit_settle = [];
  if (state) {
    for (const [id, donePath] of doneByTask) {
      if (sprintTasks[id]) mid_commit_settle.push({ task_id: id, done_path: donePath, sprint_status: sprintTasks[id].status });
    }
  }

  // Scenario 5 — empty epic folder.
  const empty_epic = [];
  const plansRoot = path.join(paths.activeDir(cwd), 'plans');
  if (fs.existsSync(plansRoot)) {
    for (const e of fs.readdirSync(plansRoot, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const dir = path.join(plansRoot, e.name);
      const files = fs.readdirSync(dir);
      const hasTaskPlans = files.some((f) => /^TASK-\d+-plan\.md$/.test(f));
      if (hasTaskPlans) continue;
      const epicFiles = files.filter((f) => /^EPIC-.+\.md$/.test(f));
      if (epicFiles.length === 0) continue;
      // Check sprint.json for tasks with this epic slug.
      const hasActiveTaskInEpic = state ? Object.values(sprintTasks).some((t) => t && t.epic === e.name) : false;
      if (hasActiveTaskInEpic) continue;
      empty_epic.push({ epic_slug: e.name, epic_path: path.join(dir, epicFiles[0]), plans_dir: dir });
    }
  }

  // Scenario 6 — malformed queue entries.
  const malformed_queue = [];
  try {
    const queue = rq.parseFile(paths.reviewQueuePath(cwd));
    for (const e of queue.entries) {
      if (!e || typeof e !== 'object') { malformed_queue.push({ entry: e, reason: 'not_an_object' }); continue; }
      if (!e.task) malformed_queue.push({ entry: e, reason: 'missing_task' });
      else if (!e.type) malformed_queue.push({ entry: e, reason: 'missing_type' });
    }
  } catch (err) {
    malformed_queue.push({ entry: null, reason: `queue_parse_error: ${err.message}` });
  }

  // Scenario 7 — completed task still in backlog.
  const completed_in_backlog = [];
  for (const id of Object.keys(backlogTasks)) {
    if (doneByTask.has(id)) completed_in_backlog.push({ task_id: id, done_path: doneByTask.get(id) });
  }

  const total =
    orphan_plan.length + ghost_sprint_entry.length + stale_stuck_file.length +
    mid_commit_settle.length + empty_epic.length + malformed_queue.length +
    completed_in_backlog.length;

  process.stdout.write(JSON.stringify({
    total,
    orphan_plan,
    ghost_sprint_entry,
    stale_stuck_file,
    mid_commit_settle,
    empty_epic,
    malformed_queue,
    completed_in_backlog,
  }, null, 2) + '\n');
}

main();
