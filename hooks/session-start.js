#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const cwd = process.cwd();
const tasksDir = path.join(cwd, '.soloflow');

let autoInitialized = false;

// Auto-initialize .soloflow/ on first session, so the plugin is usable
// immediately after `/plugin install soloflow` without a separate setup step.
//
// Guards:
//   - Only inside a git repository (avoids polluting $HOME or scratch dirs).
//   - Skipped entirely when SOLOFLOW_AUTOINIT=0 (opt-out for CI/experiments).
if (!fs.existsSync(tasksDir)) {
  const autoInitDisabled = process.env.SOLOFLOW_AUTOINIT === '0';
  const insideGitRepo = fs.existsSync(path.join(cwd, '.git'));

  if (autoInitDisabled || !insideGitRepo) {
    process.exit(0);
  }

  try {
    initStateDir(tasksDir);
    autoInitialized = true;
  } catch (e) {
    // Don't block session start if init fails — just bail silently.
    process.exit(0);
  }
}

function initStateDir(root) {
  const subdirs = [
    'active/ideas',
    'active/research',
    'active/plans',
    'active/stuck',
    'archive/done',
    'archive/reviews',
    'archive/solutions',
  ];
  for (const sub of subdirs) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
    fs.writeFileSync(path.join(root, sub, '.gitkeep'), '');
  }

  fs.writeFileSync(
    path.join(root, 'active', 'backlog.json'),
    JSON.stringify({ version: 2, tasks: {} }, null, 2) + '\n'
  );
  fs.writeFileSync(
    path.join(root, 'active', 'sprint.json'),
    JSON.stringify({ version: 2, sprint: null, tasks: {} }, null, 2) + '\n'
  );
  fs.writeFileSync(
    path.join(root, 'counters.json'),
    JSON.stringify({ ideas: 0, tasks: 0, sprints: 0, solutions: 0 }, null, 2) + '\n'
  );
  fs.writeFileSync(
    path.join(root, 'checkpoint.md'),
    '---\nlast_updated: null\nactive_sprint: null\ntasks_in_flight: []\n---\n\n' +
    '# Session Checkpoint\n\n' +
    'No checkpoint data yet. Updated by the pre-compact hook to preserve state across context compactions.\n'
  );
  fs.writeFileSync(
    path.join(root, 'human-review-queue.md'),
    '---\npending_count: 0\nitems: []\n---\n\n# Human Review Queue\n\nNo items pending review.\n'
  );
}

const backlogPath = path.join(tasksDir, 'active', 'backlog.json');
const sprintPath = path.join(tasksDir, 'active', 'sprint.json');
const checkpointPath = path.join(tasksDir, 'checkpoint.md');
const reviewQueuePath = path.join(tasksDir, 'human-review-queue.md');
const doneDir = path.join(tasksDir, 'archive', 'done');

let lines = ['## SoloFlow Status'];

if (autoInitialized) {
  lines.push('Initialized `.soloflow/` in this project. Run `/soloflow:idea-extractor "<description>"` to create your first idea, or set `SOLOFLOW_AUTOINIT=0` to disable auto-init.');
}

// Read state from split files
if (fs.existsSync(backlogPath) && fs.existsSync(sprintPath)) {
  try {
    const backlog = JSON.parse(fs.readFileSync(backlogPath, 'utf8'));
    const sprint = JSON.parse(fs.readFileSync(sprintPath, 'utf8'));
    const backlogTasks = Object.entries(backlog.tasks);
    const sprintTasks = Object.entries(sprint.tasks);

    if (sprint.sprint) {
      lines.push(`Sprint: ${sprint.sprint.id} (${sprint.sprint.status})`);
    }

    const allTasks = [...backlogTasks, ...sprintTasks];
    if (allTasks.length > 0) {
      const byStatus = {};
      allTasks.forEach(([_, t]) => {
        byStatus[t.status] = (byStatus[t.status] || 0) + 1;
      });

      // Count archived completions
      let doneCount = 0;
      if (fs.existsSync(doneDir)) {
        doneCount = fs.readdirSync(doneDir).filter(f => f.endsWith('.md')).length;
      }

      const parts = [];
      if (byStatus.in_progress) parts.push(`${byStatus.in_progress} in progress`);
      if (byStatus.ready) parts.push(`${byStatus.ready} ready`);
      if (byStatus.blocked) parts.push(`${byStatus.blocked} blocked`);
      if (byStatus.stuck) parts.push(`${byStatus.stuck} stuck`);
      if (byStatus.human_needed) parts.push(`${byStatus.human_needed} awaiting human`);
      if (doneCount) parts.push(`${doneCount} completed`);

      lines.push(`Backlog: ${backlogTasks.length} | Sprint: ${sprintTasks.length}`);
      lines.push(`Tasks: ${parts.join(', ')}`);
    } else {
      lines.push('No active tasks.');
    }
  } catch (e) {
    lines.push('Error reading state files: ' + e.message);
  }
} else {
  lines.push('State files not found. Run init.sh to set up.');
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

const output = {
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: lines.join('\n')
  }
};

console.log(JSON.stringify(output));
