#!/usr/bin/env bash
set -euo pipefail

# SoloFlow scaffold + repair script.
#
# This script is idempotent: running it on an already-initialized project will
# create any missing directories or state files without touching files that
# already exist. Use it as the shell fallback when you can't invoke
# /soloflow:init from inside Claude Code.

TASKS_DIR="${1:-.soloflow}"

MODE="fresh"
if [ -d "$TASKS_DIR" ]; then
  MODE="repair"
fi

# write_if_missing <path> <<EOF ... EOF
# Writes heredoc content to <path> only if the file does not already exist.
write_if_missing() {
  local path=$1
  if [ -e "$path" ]; then
    return 0
  fi
  # Read heredoc from stdin into the file.
  cat > "$path"
}

# Active state — read during execution
mkdir -p "$TASKS_DIR"/active/{ideas,research,plans,stuck,roadmaps,findings,compound}

# Archive — never read during execution
mkdir -p "$TASKS_DIR"/archive/{done,reviews,findings,compound,roadmaps}

# .gitkeep files so empty subdirs get tracked by git
for sub in active/ideas active/research active/plans active/stuck active/roadmaps \
           active/findings active/compound \
           archive/done archive/reviews \
           archive/findings archive/compound archive/roadmaps; do
  [ -e "$TASKS_DIR/$sub/.gitkeep" ] || touch "$TASKS_DIR/$sub/.gitkeep"
done

# Plans are the queue: each plan file under active/plans/ carries
# `status: ready|deferred|in-flight|done` in its frontmatter. There is no
# separate backlog.json; nothing to scaffold for the queue itself.

# Sprint — active sprint state and in-flight tasks (written/read by execution)
write_if_missing "$TASKS_DIR/active/sprint.json" << 'EOF'
{
  "version": 2,
  "sprint": null,
  "tasks": {}
}
EOF

# Context restoration after compaction
write_if_missing "$TASKS_DIR/checkpoint.md" << 'EOF'
---
last_updated: null
active_sprint: null
tasks_in_flight: []
---

# Session Checkpoint

No checkpoint data yet. Updated by the pre-compact hook to preserve state across context compactions.
EOF

# Batched items for human review
write_if_missing "$TASKS_DIR/human-review-queue.md" << 'EOF'
---
pending_count: 0
items: []
---

# Human Review Queue

No items pending review.
EOF

# Findings queue — one file per sprint under active/findings/. Created on
# demand by sprint-initiator when a sprint starts. We do NOT scaffold a
# global findings.md here anymore (it is the legacy pre-backlog layout).
#
# Legacy migration (one-shot): if an old global `active/findings.md` still
# exists AND an active sprint is present in sprint.json AND no per-sprint
# file exists yet, move the legacy file to the per-sprint path so agents
# start writing to the new location on the next sprint action. If no
# active sprint exists, leave the legacy file alone and print an advisory
# — the next /soloflow:compound will pick it up via its migration branch.
if [ -f "$TASKS_DIR/active/findings.md" ]; then
  sprint_id=""
  if [ -f "$TASKS_DIR/active/sprint.json" ]; then
    # shellcheck disable=SC2016
    sprint_id=$(sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$TASKS_DIR/active/sprint.json" | head -n1)
  fi
  if [ -n "$sprint_id" ] && [ "$sprint_id" != "null" ] && [ ! -f "$TASKS_DIR/active/findings/${sprint_id}-findings.md" ]; then
    mv "$TASKS_DIR/active/findings.md" "$TASKS_DIR/active/findings/${sprint_id}-findings.md"
    echo "Migrated legacy active/findings.md -> active/findings/${sprint_id}-findings.md"
  else
    echo "Legacy active/findings.md detected; leaving in place. Next /soloflow:compound will attribute it to the selected sprint."
  fi
fi

if [ "$MODE" = "fresh" ]; then
  echo "Initialized SoloFlow at $TASKS_DIR"
else
  echo "Repaired SoloFlow at $TASKS_DIR (missing directories/files created; existing files preserved)"
fi
