#!/usr/bin/env bash
set -euo pipefail

TASKS_DIR="${1:-.tasks}"
PROGRESS="$TASKS_DIR/active/progress.json"
DONE_DIR="$TASKS_DIR/archive/done"

if [ ! -f "$PROGRESS" ]; then
  echo "No progress.json found. Run init.sh first."
  exit 1
fi

node -e "
  const fs = require('fs');
  const path = require('path');
  const progress = JSON.parse(fs.readFileSync('$PROGRESS', 'utf8'));
  const tasks = progress.tasks;

  // Build set of completed task IDs from archive
  const done = new Set();
  const doneDir = '$DONE_DIR';
  if (fs.existsSync(doneDir)) {
    for (const f of fs.readdirSync(doneDir)) {
      // Extract task ID from filename: TASK-001-done.md -> TASK-001
      const match = f.match(/^(TASK-\d+)/);
      if (match) done.add(match[1]);
    }
  }

  const ready = Object.entries(tasks)
    .filter(([_, t]) => t.status === 'ready')
    .filter(([_, t]) => (t.depends_on || []).every(dep => done.has(dep)));

  if (ready.length === 0) {
    console.log('No tasks ready for execution.');
  } else {
    console.log('Ready tasks:');
    ready.forEach(([id, t]) => console.log('  ' + id + ': ' + t.title));
  }
"
