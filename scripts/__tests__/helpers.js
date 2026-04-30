'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function mktmp(prefix = 'soloflow-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function run(scriptRelative, args, opts = {}) {
  const root = path.resolve(__dirname, '..', '..');
  const abs = path.join(root, 'scripts', scriptRelative);
  const { spawnSync } = require('child_process');
  const result = spawnSync('node', [abs, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: opts.cwd || process.cwd(),
    env: { ...process.env, ...(opts.env || {}) },
  });
  const out = (result.stdout || '').toString().trim();
  const err = (result.stderr || '').toString().trim();
  const code = result.status == null ? -1 : result.status;
  return { ok: code === 0, out, err, code };
}

function scaffold(root, { withSprint = false, sprintTasks = {} } = {}) {
  const dirs = [
    'active/ideas', 'active/research', 'active/plans', 'active/stuck',
    'active/roadmaps', 'active/findings', 'active/compound',
    'archive/done', 'archive/reviews', 'archive/findings', 'archive/compound', 'archive/roadmaps',
  ];
  for (const d of dirs) fs.mkdirSync(path.join(root, '.soloflow', d), { recursive: true });
  fs.writeFileSync(path.join(root, '.soloflow/active/backlog.json'), JSON.stringify({ version: 2, tasks: {} }, null, 2));
  if (withSprint) {
    fs.writeFileSync(path.join(root, '.soloflow/active/sprint.json'), JSON.stringify({
      version: 2,
      sprint: { id: 'SPRINT-001', status: 'active', started: '2026-04-22T00:00:00Z' },
      tasks: sprintTasks,
    }, null, 2));
  } else {
    fs.writeFileSync(path.join(root, '.soloflow/active/sprint.json'), JSON.stringify({ version: 2, sprint: null, tasks: {} }, null, 2));
  }
  fs.writeFileSync(path.join(root, '.soloflow/human-review-queue.md'),
    '---\npending_count: 0\nitems: []\n---\n\n# Human Review Queue\n\nNo items pending review.\n');
  return root;
}

function writePlan(cwd, taskId, fm = {}, opts = {}) {
  const yaml = require(path.resolve(__dirname, '..', 'lib', 'yaml'));
  const epic = opts.epic !== undefined ? opts.epic : (fm && fm.epic) || null;
  const dir = epic
    ? path.join(cwd, '.soloflow/active/plans', epic)
    : path.join(cwd, '.soloflow/active/plans');
  fs.mkdirSync(dir, { recursive: true });
  const planPath = path.join(dir, `${taskId}-plan.md`);
  const merged = { id: taskId, ...fm };
  if (epic && merged.epic === undefined) merged.epic = epic;
  const body = opts.body || `# ${taskId}\n\nplan body\n`;
  fs.writeFileSync(planPath, yaml.joinFrontmatter(merged, body));
  return planPath;
}

module.exports = { mktmp, run, scaffold, writePlan };
