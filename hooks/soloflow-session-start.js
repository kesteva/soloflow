#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const cwd = process.cwd();
const tasksDir = path.join(cwd, '.soloflow');

// Silent exit if SoloFlow not initialized in this project
if (!fs.existsSync(tasksDir)) {
  process.exit(0);
}

const progressPath = path.join(tasksDir, 'active', 'progress.json');
const checkpointPath = path.join(tasksDir, 'checkpoint.md');
const reviewQueuePath = path.join(tasksDir, 'human-review-queue.md');
const doneDir = path.join(tasksDir, 'archive', 'done');

let lines = ['## SoloFlow Status'];

// Read active sprint state
if (fs.existsSync(progressPath)) {
  try {
    const progress = JSON.parse(fs.readFileSync(progressPath, 'utf8'));
    const tasks = Object.entries(progress.tasks);

    if (progress.sprint) {
      lines.push(`Sprint: ${progress.sprint.id} (${progress.sprint.status})`);
    }

    if (tasks.length > 0) {
      const byStatus = {};
      tasks.forEach(([_, t]) => {
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

      lines.push(`Tasks: ${parts.join(', ')}`);
    } else {
      lines.push('No active tasks.');
    }
  } catch (e) {
    lines.push('Error reading progress.json: ' + e.message);
  }
} else {
  lines.push('No progress.json found. Run init.sh to set up.');
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
