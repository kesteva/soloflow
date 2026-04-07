---
description: Show current SoloFlow sprint state and task progress
allowed-tools: [Read, Glob, Bash]
---

# /soloflow-status

Display the current SoloFlow workflow state for this project.

## Steps

1. **Check initialization.** If `.soloflow/` does not exist, report: "SoloFlow is not initialized in this project. Run `/soloflow-idea-extractor` to begin."

2. **Read state files:**
   - `.soloflow/active/backlog.json` for backlog tasks
   - `.soloflow/active/sprint.json` for active sprint and in-flight tasks
   - `.soloflow/counters.json` for global counters
   - `.soloflow/checkpoint.md` for last checkpoint info
   - `.soloflow/human-review-queue.md` for pending reviews

3. **Count archive files:**
   - Count `.md` files in `.soloflow/archive/done/` for completed tasks
   - Count `.md` files in `.soloflow/archive/solutions/` for captured solutions

4. **Display the report:**

```
## SoloFlow Status

### Sprint
- **ID:** {sprint ID or "No active sprint"}
- **Status:** {active / complete / none}
- **Started:** {timestamp or "—"}

### Active Tasks
- **Ready:** {count}
- **In progress:** {count}
- **Blocked:** {count}
- **Stuck:** {count}
- **Human-needed:** {count}

### Archive
- **Completed:** {count from archive/done/}
- **Solutions:** {count from archive/solutions/}

### Human Review Queue
- **Pending:** {count or "Empty"}

### Last Checkpoint
- **Updated:** {timestamp or "No checkpoint"}
- **Next action:** {from checkpoint frontmatter or "—"}
```

If there are stuck tasks, list them with their task IDs. If there are human-needed tasks, list them too.
