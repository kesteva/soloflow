#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const cwd = process.cwd();
const tasksDir = path.join(cwd, '.soloflow');

// If .soloflow/ doesn't exist, emit a visible prompt asking the user to run
// /soloflow:init. We intentionally do NOT create files on the user's behalf —
// explicit consent before writing to their project.
if (!fs.existsSync(tasksDir)) {
  const promptOutput = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext:
        '## SoloFlow\n' +
        'SoloFlow is installed but not initialized in this project. ' +
        'Run `/soloflow:init` to scaffold `.soloflow/` state, or ignore this notice if you don\'t want SoloFlow here.',
    },
  };
  console.log(JSON.stringify(promptOutput));
  process.exit(0);
}

const backlogPath = path.join(tasksDir, 'active', 'backlog.json');
const sprintPath = path.join(tasksDir, 'active', 'sprint.json');
const checkpointPath = path.join(tasksDir, 'checkpoint.md');
const reviewQueuePath = path.join(tasksDir, 'human-review-queue.md');
const findingsPath = path.join(tasksDir, 'active', 'findings.md');
const doneDir = path.join(tasksDir, 'archive', 'done');

let lines = ['## SoloFlow Status'];

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

      // Count archived completions (recursive — tasks may live under epic subfolders).
      // Only count TASK-*.md files so EPIC.md manifests don't inflate the total.
      let doneCount = 0;
      if (fs.existsSync(doneDir)) {
        const walk = (dir) => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              walk(full);
            } else if (entry.isFile() && /^TASK-.*\.md$/.test(entry.name)) {
              doneCount++;
            }
          }
        };
        walk(doneDir);
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

// Check for pending out-of-scope findings
if (fs.existsSync(findingsPath)) {
  try {
    const content = fs.readFileSync(findingsPath, 'utf8');
    const match = content.match(/pending_count:\s*(\d+)/);
    const count = match ? parseInt(match[1], 10) : 0;
    if (count > 0) {
      lines.push(`Findings queue: ${count} out-of-scope item${count > 1 ? 's' : ''} awaiting next compound`);
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
