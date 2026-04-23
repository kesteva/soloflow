---
description: Clean up .soloflow/ state cruft (orphan plans, ghost sprint entries, stale stuck files, mid-commit settle crashes, empty epics, malformed queue entries)
argument-hint: "[--dry-run]"
allowed-tools: [Read, Write, Edit, Glob, Grep, Bash, AskUserQuestion]
---

# /soloflow:housekeeping

Focused cruft sweep for `.soloflow/` state. For the full review-queue triage (cruft + actions + visual + refinement), use `/soloflow:review-queue`.

`$ARGUMENTS` optionally includes one flag:
- `--dry-run` — detect and print buckets only; no prompts, no writes.

If `$ARGUMENTS` is non-empty and not `--dry-run`, print usage and stop:
```
/soloflow:housekeeping [--dry-run]
```

---

## Step 0 — Init

1. If `.soloflow/` does not exist, report: "SoloFlow not initialized. Run `/soloflow:init` first." and stop.
2. Initialize `cruft_resolved = 0`.

## Step 1 — Dry-run short-circuit

If `$ARGUMENTS` contains `--dry-run`:

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/state/cruft-detect.js"`.
2. If `total == 0`, print `"No cruft detected."` and stop.
3. Otherwise, for each non-empty bucket, print the scenario name, the count, and a one-line summary per item (e.g., `TASK-NNN — <short reason>`). No prompts, no commits, no writes.
4. Stop.

## Step 2 — Cleanup

Read `docs/CRUFT-CLEANUP.md` via the Read tool and follow its procedure to completion. Use `housekeeping` as the commit-message `<command>` label. The procedure updates the `cruft_resolved` counter initialized in Step 0.

## Step 3 — Report

Print:

```
## Housekeeping — complete

Cruft resolved: {cruft_resolved}
```

If `cruft_resolved == 0` and no cruft was detected, the one-line "No cruft detected." from Step 2 already stands; the final report can be a single line: `Housekeeping — complete. Nothing to clean up.`

---

## Context Limit Self-Monitoring

This command runs in the main session. The context-monitor hook injects warnings when context usage is high.

When you receive a **SOLOFLOW CONTEXT WARNING**: finish the current per-item decision, then write a checkpoint.

When you receive a **SOLOFLOW CONTEXT CRITICAL**: finish the current decision, write a checkpoint, then use **AskUserQuestion** with options: **Compact and continue** / **Save and exit**.
