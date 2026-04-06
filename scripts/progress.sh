#!/usr/bin/env bash
set -euo pipefail

TASKS_DIR="${1:-.soloflow}"
BACKLOG="$TASKS_DIR/active/backlog.json"
SPRINT="$TASKS_DIR/active/sprint.json"
DONE_DIR="$TASKS_DIR/archive/done"

if [ ! -f "$BACKLOG" ] || [ ! -f "$SPRINT" ]; then
  echo "State files not found. Run init.sh first."
  exit 1
fi

node -e "
  const fs = require('fs');
  const backlog = JSON.parse(fs.readFileSync('$BACKLOG', 'utf8'));
  const sprint = JSON.parse(fs.readFileSync('$SPRINT', 'utf8'));

  const backlogTasks = Object.values(backlog.tasks);
  const sprintTasks = Object.values(sprint.tasks);

  // Count by status across both files
  const byStatus = {};
  backlogTasks.forEach(t => {
    byStatus[t.status] = (byStatus[t.status] || 0) + 1;
  });
  sprintTasks.forEach(t => {
    byStatus[t.status] = (byStatus[t.status] || 0) + 1;
  });

  // Count archived completions
  const doneDir = '$DONE_DIR';
  let doneCount = 0;
  if (fs.existsSync(doneDir)) {
    doneCount = fs.readdirSync(doneDir).filter(f => f.endsWith('.md')).length;
  }

  if (sprint.sprint) {
    console.log('Sprint: ' + sprint.sprint.id + ' (' + sprint.sprint.status + ')');
  } else {
    console.log('No active sprint.');
  }

  const total = backlogTasks.length + sprintTasks.length;
  console.log('Backlog: ' + backlogTasks.length + ' tasks');
  console.log('In sprint: ' + sprintTasks.length + ' tasks');
  Object.entries(byStatus).forEach(([status, count]) => {
    console.log('  ' + status + ': ' + count);
  });
  console.log('Completed: ' + doneCount);
"
