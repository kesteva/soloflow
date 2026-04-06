#!/usr/bin/env node

// SoloFlow pre-compact hook — saves progress before context compression
// Writes checkpoint.md so state can be restored after compaction

const fs = require('fs');
const path = require('path');

const cwd = process.cwd();
const soloflowDir = path.join(cwd, '.soloflow');

// Silent exit if SoloFlow not initialized
if (!fs.existsSync(soloflowDir)) {
  process.exit(0);
}

const backlogPath = path.join(soloflowDir, 'active', 'backlog.json');
const sprintPath = path.join(soloflowDir, 'active', 'sprint.json');
const checkpointPath = path.join(soloflowDir, 'checkpoint.md');

if (!fs.existsSync(sprintPath)) {
  process.exit(0);
}

try {
  const sprintData = JSON.parse(fs.readFileSync(sprintPath, 'utf8'));
  const sprintTasks = Object.entries(sprintData.tasks);

  // Also read backlog for ready tasks
  let backlogTasks = [];
  if (fs.existsSync(backlogPath)) {
    const backlog = JSON.parse(fs.readFileSync(backlogPath, 'utf8'));
    backlogTasks = Object.entries(backlog.tasks);
  }

  const now = new Date().toISOString();

  const inFlight = sprintTasks.filter(([_, t]) => t.status === 'in_progress').map(([id]) => id);
  const stuck = sprintTasks.filter(([_, t]) => t.status === 'stuck').map(([id]) => id);
  const humanNeeded = sprintTasks.filter(([_, t]) => t.status === 'human_needed').map(([id]) => id);
  const ready = backlogTasks.filter(([_, t]) => t.status === 'ready').map(([id]) => id);

  // Determine current phase
  let phase = 'idle';
  if (sprintData.sprint && sprintData.sprint.status === 'active') {
    phase = '3 (execution sprint)';
  } else if (backlogTasks.length > 0) {
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
