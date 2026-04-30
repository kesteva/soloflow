#!/usr/bin/env node

// SoloFlow pre-compact hook — saves progress before context compression
// Writes checkpoint.md so state can be restored after compaction

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const cwd = process.cwd();
const soloflowDir = path.join(cwd, '.soloflow');

// Silent exit if SoloFlow not initialized
if (!fs.existsSync(soloflowDir)) {
  process.exit(0);
}

const sprintPath = path.join(soloflowDir, 'active', 'sprint.json');
const plansDir = path.join(soloflowDir, 'active', 'plans');
const checkpointPath = path.join(soloflowDir, 'checkpoint.md');

if (!fs.existsSync(sprintPath)) {
  process.exit(0);
}

// Glob plans/ and pick out IDs whose frontmatter status is `ready`.
function readyTaskIdsFromPlans(root) {
  const ids = [];
  if (!fs.existsSync(root)) return ids;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { stack.push(full); continue; }
      const m = entry.name.match(/^TASK-(\d+)-plan\.md$/);
      if (!m) continue;
      try {
        const fd = fs.openSync(full, 'r');
        const buf = Buffer.alloc(1024);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        const head = buf.slice(0, n).toString('utf8');
        if (/(?:^|\n)status:\s*ready\b/.test(head)) ids.push(`TASK-${m[1]}`);
      } catch { /* skip */ }
    }
  }
  return ids.sort();
}

try {
  const sprintData = JSON.parse(fs.readFileSync(sprintPath, 'utf8'));
  const sprintTasks = Object.entries(sprintData.tasks || {});

  const now = new Date().toISOString();

  const inFlight = sprintTasks.filter(([_, t]) => t.status === 'in_progress').map(([id]) => id);
  const stuck = sprintTasks.filter(([_, t]) => t.status === 'stuck').map(([id]) => id);
  const humanNeeded = sprintTasks.filter(([_, t]) => t.status === 'human_needed').map(([id]) => id);
  const ready = readyTaskIdsFromPlans(plansDir);

  // Determine current phase
  let phase = 'idle';
  if (sprintData.sprint && sprintData.sprint.status === 'active') {
    phase = '3 (execution sprint)';
  } else if (ready.length > 0) {
    phase = '2 (refinement)';
  }

  // Determine next action
  let nextAction = 'No active work';
  if (inFlight.length > 0) {
    nextAction = `Resume execution of ${inFlight.join(', ')}`;
  } else if (ready.length > 0) {
    nextAction = `Execute ready tasks: ${ready.join(', ')}`;
  } else if (humanNeeded.length > 0) {
    nextAction = `Review human-needed tasks: ${humanNeeded.join(', ')}`;
  }

  const sprint = sprintData.sprint ? sprintData.sprint.id : 'none';

  const checkpoint = `---
last_updated: ${now}
active_sprint: ${sprint}
phase: ${phase}
tasks_in_flight: [${inFlight.join(', ')}]
tasks_stuck: [${stuck.join(', ')}]
tasks_human_needed: [${humanNeeded.join(', ')}]
tasks_ready: [${ready.join(', ')}]
next_action: "${nextAction}"
---

# Session Checkpoint

Sprint: ${sprint}
Phase: ${phase}
In-flight: ${inFlight.length} | Ready: ${ready.length} | Stuck: ${stuck.length} | Human-needed: ${humanNeeded.length}

Next: ${nextAction}
`;

  fs.writeFileSync(checkpointPath, checkpoint);

  // Commit the checkpoint if we're inside a git repo and .soloflow/ is tracked.
  // Never `git add .` — stage only the checkpoint file. Swallow all errors so
  // we never block compaction on git state.
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd, stdio: 'ignore' });
    // Refuse to commit if .soloflow/ is gitignored (check-ignore exits 0 if ignored).
    let ignored = false;
    try {
      execFileSync('git', ['check-ignore', '-q', '.soloflow'], { cwd, stdio: 'ignore' });
      ignored = true;
    } catch (_) { /* not ignored */ }
    if (!ignored) {
      execFileSync('git', ['add', '.soloflow/checkpoint.md'], { cwd, stdio: 'ignore' });
      // Only commit if there are staged changes for the checkpoint.
      try {
        execFileSync('git', ['diff', '--cached', '--quiet', '--', '.soloflow/checkpoint.md'], { cwd, stdio: 'ignore' });
        // exit 0 → no staged changes → skip
      } catch (_) {
        execFileSync('git', ['commit', '-m', 'chore: checkpoint before compact', '--', '.soloflow/checkpoint.md'], { cwd, stdio: 'ignore' });
      }
    }
  } catch (_) { /* ignore all git errors */ }

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreCompact',
      additionalContext: `Checkpoint saved. Sprint: ${sprint}, ${inFlight.length} in-flight, ${ready.length} ready. Next: ${nextAction}`
    }
  }));
} catch (e) {
  // Don't block compaction on errors
}

process.exit(0);
