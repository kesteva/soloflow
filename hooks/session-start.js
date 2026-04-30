#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const cwd = process.cwd();
const tasksDir = path.join(cwd, '.soloflow');

// --- Update check (best-effort) --------------------------------------------
// Refresh the remote-version cache, then read it. Both the spawn and the
// read are wrapped in try/catch so a failure here can never break the
// SessionStart additionalContext payload.

function refreshUpdateCheck() {
  try {
    const root = process.env.CLAUDE_PLUGIN_ROOT;
    if (!root) return;
    const script = path.join(root, 'scripts', 'update', 'check-version.js');
    if (!fs.existsSync(script)) return;
    spawnSync('node', [script], { timeout: 3000, stdio: 'ignore' });
  } catch (e) { /* silent */ }
}

function readUpdateLine() {
  try {
    const cachePath = path.join(os.homedir(), '.cache', 'soloflow', 'update-check.json');
    if (!fs.existsSync(cachePath)) return null;
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (!cache || !cache.update_available) return null;
    return `**Update:** SoloFlow v${cache.current_version} → v${cache.latest_version} available — run \`/soloflow:update\``;
  } catch (e) {
    return null;
  }
}

refreshUpdateCheck();
const updateLine = readUpdateLine();

// If .soloflow/ doesn't exist, emit a visible prompt asking the user to run
// /soloflow:init. We intentionally do NOT create files on the user's behalf —
// explicit consent before writing to their project.
if (!fs.existsSync(tasksDir)) {
  let body =
    '## SoloFlow\n' +
    'SoloFlow is installed but not initialized in this project. ' +
    'Run `/soloflow:init` to scaffold `.soloflow/` state, or ignore this notice if you don\'t want SoloFlow here.';
  if (updateLine) body += '\n\n' + updateLine;
  const promptOutput = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: body,
    },
  };
  console.log(JSON.stringify(promptOutput));
  process.exit(0);
}

const sprintPath = path.join(tasksDir, 'active', 'sprint.json');
const plansDir = path.join(tasksDir, 'active', 'plans');
const checkpointPath = path.join(tasksDir, 'checkpoint.md');
const reviewQueuePath = path.join(tasksDir, 'human-review-queue.md');
const findingsDir = path.join(tasksDir, 'active', 'findings');
const legacyFindingsPath = path.join(tasksDir, 'active', 'findings.md');
const doneDir = path.join(tasksDir, 'archive', 'done');

let lines = ['## SoloFlow Status'];

// Plan frontmatter is the queue source of truth. Glob plans/ and group by
// status field; merge with sprint.json for in-flight verdict states
// (in_progress / blocked / stuck / human_needed).
function readPlanStatus(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const head = buf.slice(0, n).toString('utf8');
    const m = head.match(/(?:^|\n)status:\s*(\S+)/);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

function countPlansByStatus(root) {
  const byStatus = {};
  let total = 0;
  if (!fs.existsSync(root)) return { byStatus, total };
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { stack.push(full); continue; }
      if (!/^TASK-\d+-plan\.md$/.test(entry.name)) continue;
      total++;
      const status = readPlanStatus(full) || 'unknown';
      byStatus[status] = (byStatus[status] || 0) + 1;
    }
  }
  return { byStatus, total };
}

if (fs.existsSync(sprintPath) || fs.existsSync(plansDir)) {
  try {
    const sprint = fs.existsSync(sprintPath)
      ? JSON.parse(fs.readFileSync(sprintPath, 'utf8'))
      : { sprint: null, tasks: {} };
    const sprintTasks = Object.entries(sprint.tasks || {});
    const { byStatus: planByStatus, total: planTotal } = countPlansByStatus(plansDir);

    if (sprint.sprint) {
      lines.push(`Sprint: ${sprint.sprint.id} (${sprint.sprint.status})`);
    }

    // Count archived completions (recursive — tasks may live under epic subfolders).
    // Only count TASK-*.md files so EPIC-*.md manifests don't inflate the total.
    let doneCount = 0;
    if (fs.existsSync(doneDir)) {
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.isFile() && /^TASK-.*\.md$/.test(entry.name)) doneCount++;
        }
      };
      walk(doneDir);
    }

    const sprintByStatus = {};
    sprintTasks.forEach(([_, t]) => {
      if (t && t.status) sprintByStatus[t.status] = (sprintByStatus[t.status] || 0) + 1;
    });

    if (planTotal > 0 || sprintTasks.length > 0 || doneCount > 0) {
      const parts = [];
      if (sprintByStatus.in_progress) parts.push(`${sprintByStatus.in_progress} in progress`);
      if (planByStatus.ready) parts.push(`${planByStatus.ready} ready`);
      if (planByStatus.deferred) parts.push(`${planByStatus.deferred} deferred`);
      if (sprintByStatus.blocked) parts.push(`${sprintByStatus.blocked} blocked`);
      if (sprintByStatus.stuck) parts.push(`${sprintByStatus.stuck} stuck`);
      if (sprintByStatus.human_needed) parts.push(`${sprintByStatus.human_needed} awaiting human`);
      if (doneCount) parts.push(`${doneCount} completed`);

      lines.push(`Plans: ${planTotal} | Sprint: ${sprintTasks.length}`);
      if (parts.length > 0) lines.push(`Tasks: ${parts.join(', ')}`);
    } else {
      lines.push('No active tasks.');
    }
  } catch (e) {
    lines.push('Error reading state: ' + e.message);
  }
} else {
  lines.push('State files not found. Run /soloflow:init to set up.');
}

// Check for pending human reviews
if (fs.existsSync(reviewQueuePath)) {
  try {
    const content = fs.readFileSync(reviewQueuePath, 'utf8');
    const match = content.match(/pending_count:\s*(\d+)/);
    const count = match ? parseInt(match[1], 10) : 0;
    if (count > 0) {
      lines.push(`Human review queue: ${count} item${count > 1 ? 's' : ''} pending`);
    }
  } catch (e) {
    // Ignore read errors for optional file
  }
}

// Check for pending out-of-scope findings. Layout is one file per sprint
// (active/findings/SPRINT-*-findings.md). Legacy projects may still have a
// single active/findings.md until the next sprint-initiator migrates it.
const findingsBySprint = [];
if (fs.existsSync(findingsDir)) {
  try {
    for (const entry of fs.readdirSync(findingsDir)) {
      if (!/-findings\.md$/.test(entry)) continue;
      const sprintId = entry.replace(/-findings\.md$/, '');
      const full = path.join(findingsDir, entry);
      const content = fs.readFileSync(full, 'utf8');
      const match = content.match(/pending_count:\s*(\d+)/);
      const count = match ? parseInt(match[1], 10) : 0;
      if (count > 0) findingsBySprint.push({ sprintId, count });
    }
  } catch (e) {
    // Ignore directory read errors
  }
}
if (fs.existsSync(legacyFindingsPath)) {
  try {
    const content = fs.readFileSync(legacyFindingsPath, 'utf8');
    const match = content.match(/pending_count:\s*(\d+)/);
    const count = match ? parseInt(match[1], 10) : 0;
    if (count > 0) findingsBySprint.push({ sprintId: 'legacy', count });
  } catch (e) {
    // Ignore read errors for optional file
  }
}
if (findingsBySprint.length > 0) {
  const total = findingsBySprint.reduce((sum, f) => sum + f.count, 0);
  if (findingsBySprint.length === 1) {
    const { sprintId, count } = findingsBySprint[0];
    const label = sprintId === 'legacy' ? 'legacy findings.md' : sprintId;
    lines.push(`Findings queue: ${count} out-of-scope item${count > 1 ? 's' : ''} in ${label} awaiting compound`);
  } else {
    const breakdown = findingsBySprint
      .sort((a, b) => a.sprintId.localeCompare(b.sprintId))
      .map((f) => `${f.sprintId} (${f.count})`)
      .join(', ');
    lines.push(`Findings queue: ${total} items across ${findingsBySprint.length} sprints awaiting compound — ${breakdown}`);
  }
}

// Check for checkpoint (indicates resumed session)
if (fs.existsSync(checkpointPath)) {
  try {
    const content = fs.readFileSync(checkpointPath, 'utf8');
    const match = content.match(/last_updated:\s*(.+)/);
    if (match && match[1] !== 'null') {
      lines.push(`Last checkpoint: ${match[1].trim()}`);
    }
  } catch (e) {
    // Ignore read errors for optional file
  }
}

if (updateLine) lines.push(updateLine);

const output = {
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: lines.join('\n')
  }
};

console.log(JSON.stringify(output));
