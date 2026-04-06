#!/usr/bin/env bash
set -euo pipefail

# Migrate from v1 (single progress.json) to v2 (split state files)

TASKS_DIR="${1:-.soloflow}"
PROGRESS="$TASKS_DIR/active/progress.json"

if [ ! -f "$PROGRESS" ]; then
  echo "No progress.json found at $PROGRESS — nothing to migrate."
  exit 0
fi

if [ -f "$TASKS_DIR/active/backlog.json" ]; then
  echo "Already migrated (backlog.json exists). Skipping."
  exit 0
fi

# Create research directory
mkdir -p "$TASKS_DIR/active/research"

node -e "
  const fs = require('fs');
  const path = require('path');

  const progress = JSON.parse(fs.readFileSync('$PROGRESS', 'utf8'));

  // Split tasks by status
  const backlogTasks = {};
  const sprintTasks = {};

  for (const [id, task] of Object.entries(progress.tasks || {})) {
    if (task.status === 'ready' || task.status === 'blocked' || task.status === 'deferred') {
      backlogTasks[id] = task;
    } else {
      // in_progress, stuck, human_needed go to sprint
      sprintTasks[id] = task;
    }
  }

  const backlog = { version: 2, tasks: backlogTasks };
  const sprint = { version: 2, sprint: progress.sprint || null, tasks: sprintTasks };
  const counters = progress.counters || { ideas: 0, tasks: 0, sprints: 0, solutions: 0 };

  fs.writeFileSync('$TASKS_DIR/active/backlog.json', JSON.stringify(backlog, null, 2));
  fs.writeFileSync('$TASKS_DIR/active/sprint.json', JSON.stringify(sprint, null, 2));
  fs.writeFileSync('$TASKS_DIR/counters.json', JSON.stringify(counters, null, 2));

  // Rename old file as backup
  fs.renameSync('$PROGRESS', '$PROGRESS.v1-backup');

  const bCount = Object.keys(backlogTasks).length;
  const sCount = Object.keys(sprintTasks).length;
  console.log('Migration complete:');
  console.log('  Backlog tasks: ' + bCount);
  console.log('  Sprint tasks: ' + sCount);
  console.log('  Old progress.json backed up to progress.json.v1-backup');
"
