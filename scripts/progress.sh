#!/usr/bin/env bash
set -euo pipefail

TASKS_DIR="${1:-.soloflow}"
PROGRESS="$TASKS_DIR/active/progress.json"
DONE_DIR="$TASKS_DIR/archive/done"

if [ ! -f "$PROGRESS" ]; then
  echo "No progress.json found. Run init.sh first."
  exit 1
fi

node -e "
  const fs = require('fs');
  const progress = JSON.parse(fs.readFileSync('$PROGRESS', 'utf8'));
  const tasks = Object.values(progress.tasks);

  // Count active tasks by status
  const byStatus = {};
  tasks.forEach(t => {
    byStatus[t.status] = (byStatus[t.status] || 0) + 1;
  });

  // Count archived completions
  const doneDir = '$DONE_DIR';
  let doneCount = 0;
  if (fs.existsSync(doneDir)) {
    doneCount = fs.readdirSync(doneDir).filter(f => f.endsWith('.md')).length;
  }

  const sprint = progress.sprint;
  if (sprint) {
    console.log('Sprint: ' + sprint.id + ' (' + sprint.status + ')');
  } else {
    console.log('No active sprint.');
  }

  console.log('Active: ' + tasks.length + ' tasks');
  Object.entries(byStatus).forEach(([status, count]) => {
    console.log('  ' + status + ': ' + count);
  });
  console.log('Completed: ' + doneCount);
"
