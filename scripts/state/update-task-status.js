#!/usr/bin/env node

// SoloFlow state helper — update a single task's status in sprint.json.
// Usage:
//   node update-task-status.js <TASK-ID> <status>
//       [--note "..."] [--executor-loops N]
//       [--create [--plan <path>] [--epic <slug>]]
//
// --create: upsert. If sprint.json is missing, scaffold a minimal quick-mode
// sprint. If the task entry is missing, insert it. Without --create, a missing
// file or missing task is a hard error.

const fs = require('fs');
const path = require('path');

const VALID_STATUSES = new Set(['pending', 'in_progress', 'blocked', 'stuck', 'human_needed']);

function die(msg, code = 1) {
  process.stderr.write(`update-task-status: ${msg}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const positional = [];
  const opts = { create: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--note') opts.note = argv[++i];
    else if (a === '--executor-loops') opts.executorLoops = argv[++i];
    else if (a === '--create') opts.create = true;
    else if (a === '--plan') opts.plan = argv[++i];
    else if (a === '--epic') opts.epic = argv[++i];
    else if (a.startsWith('--')) die(`unknown flag: ${a}`);
    else positional.push(a);
  }
  if (positional.length !== 2) die('usage: update-task-status.js <TASK-ID> <status> [--note "..."] [--executor-loops N] [--create [--plan <path>] [--epic <slug>]]');
  return { taskId: positional[0], status: positional[1], ...opts };
}

function writeAtomic(filePath, content) {
  const tmp = filePath + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

function compactTimestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function scaffoldQuickSprint() {
  const now = new Date().toISOString();
  return {
    version: 2,
    sprint: { id: `SPRINT-quick-${compactTimestamp()}`, status: 'active', started: now },
    tasks: {},
  };
}

function main() {
  const { taskId, status, note, executorLoops, create, plan, epic } = parseArgs(process.argv.slice(2));

  if (!/^TASK-\d{3,}$/.test(taskId)) die(`invalid task ID: ${taskId}`);
  if (!VALID_STATUSES.has(status)) die(`invalid status: ${status} (expected one of: ${[...VALID_STATUSES].join(', ')})`);
  if ((plan !== undefined || epic !== undefined) && !create) die('--plan / --epic require --create');

  const sprintDir = path.join(process.cwd(), '.soloflow', 'active');
  const sprintPath = path.join(sprintDir, 'sprint.json');

  let state;
  if (fs.existsSync(sprintPath)) {
    try {
      state = JSON.parse(fs.readFileSync(sprintPath, 'utf8'));
    } catch (e) {
      die(`${sprintPath} is not valid JSON: ${e.message}`);
    }
  } else if (create) {
    fs.mkdirSync(sprintDir, { recursive: true });
    state = scaffoldQuickSprint();
  } else {
    die(`${sprintPath} not found`);
  }

  if (!state.tasks || typeof state.tasks !== 'object') {
    if (create) state.tasks = {};
    else die(`${sprintPath} missing tasks map`);
  }

  if (!state.tasks[taskId]) {
    if (create) state.tasks[taskId] = {};
    else die(`${taskId} not found in active sprint`);
  }

  const task = state.tasks[taskId];
  task.status = status;
  const now = new Date().toISOString();
  if (status === 'in_progress' && !task.started) task.started = now;
  if (status === 'blocked' || status === 'stuck' || status === 'human_needed') task.verdict_at = now;
  if (note !== undefined) task.note = note;
  if (plan !== undefined) task.plan = plan;
  if (epic !== undefined) task.epic = epic;
  if (executorLoops !== undefined) {
    const n = Number(executorLoops);
    if (!Number.isInteger(n) || n < 0) die(`--executor-loops must be a non-negative integer, got: ${executorLoops}`);
    task.executor_loops = n;
  }

  writeAtomic(sprintPath, JSON.stringify(state, null, 2) + '\n');
  process.stdout.write(`${taskId}: ${status}${create ? ' (create)' : ''}\n`);
}

main();
