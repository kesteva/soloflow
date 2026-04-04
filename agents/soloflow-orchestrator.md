---
name: soloflow-orchestrator
description: Reference instructions for Phase 3 execution sprint logic. Used by /soloflow-start directly, not spawned as a subagent (subagents cannot spawn subagents).
model: opus
tools: [Read, Write, Glob, Grep, Bash, Agent]
---

# Phase 3: Execution Sprint Algorithm

This document describes the orchestration logic for Phase 3. It is followed by the `/soloflow-start` command running in the main session. It is NOT spawned as a subagent — the main session IS the orchestrator.

## 1. Sprint Initialization

1. Read all approved plans from `.soloflow/active/plans/`
2. Create a sprint entry in `progress.json`:
   ```json
   {
     "sprint": {
       "id": "SPRINT-{NNN}",
       "status": "active",
       "started": "{ISO timestamp}",
       "idea": "{IDEA-NNN}",
       "tasks": ["{TASK-NNN}", ...]
     }
   }
   ```
3. Increment `counters.sprints`

## 2. Dependency Graph

Build from each plan's `depends_on` field:
- Tasks with empty `depends_on` are immediately ready
- Tasks whose dependencies are all in the completed set become ready
- Circular dependencies are an error — report to user and stop

## 3. Execution Loop

```
completed_set = {}
checkpoint_counter = 0

WHILE tasks remain that are not completed/stuck/human_needed:
  ready_tasks = tasks where all depends_on are in completed_set
  
  IF ready_tasks is empty AND uncompleted tasks exist:
    # All remaining tasks are blocked by stuck/human_needed deps
    BREAK
  
  FOR each ready_task:
    loop_count = 0
    
    WHILE loop_count < executor_retry_max (default 3):
      # Spawn executor
      Spawn soloflow-executor with plan content
      
      IF executor returns COMPLETED:
        # Spawn verifier
        Spawn soloflow-verifier with plan + executor report
        
        IF verifier says APPROVED:
          Write done report to .soloflow/archive/done/TASK-NNN-done.md
          Remove task from progress.json
          Add TASK-NNN to completed_set
          checkpoint_counter++
          BREAK
        
        ELIF verifier says NEEDS_CHANGES:
          loop_count++
          IF loop_count >= executor_retry_max:
            Write stuck report to .soloflow/active/stuck/
            Update progress.json status to "stuck"
            BREAK
          # Continue loop with verifier feedback
        
        ELIF verifier says HUMAN_NEEDED:
          Add to .soloflow/human-review-queue.md
          Update progress.json status to "human_needed"
          BREAK
      
      ELIF executor returns BLOCKED:
        Update progress.json status to "blocked"
        BREAK
      
      ELIF executor returns STUCK:
        Write stuck report
        Update progress.json status to "stuck"
        BREAK
    
    # Checkpoint every N completed tasks
    IF checkpoint_counter >= checkpoint_interval (default 3):
      Write checkpoint to .soloflow/checkpoint.md
      checkpoint_counter = 0
```

## 4. Sprint Completion

1. Update `progress.json`: set `sprint.status` to `"complete"`
2. Write final checkpoint
3. Report summary: tasks completed, stuck, human_needed, total executor loops

## 5. Checkpoint Format

```markdown
---
last_updated: {ISO timestamp}
active_sprint: SPRINT-{NNN}
phase: 3
tasks_completed: [TASK-NNN, ...]
tasks_in_flight: [TASK-NNN, ...]
tasks_stuck: [TASK-NNN, ...]
tasks_human_needed: [TASK-NNN, ...]
next_action: "{what to do next}"
---

# Session Checkpoint

{Human-readable summary of sprint state}
```

## 6. Stuck Detection

A task is stuck when the executor-verifier loop has run `executor_retry_max` times (default 3) without an APPROVED verdict. When stuck:
1. Write a stuck report capturing: the task plan, each executor attempt's changes, each verifier's feedback
2. Update progress.json to `status: "stuck"`
3. Move on to the next ready task — do not stop the sprint
