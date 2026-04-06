#!/usr/bin/env bash
set -euo pipefail

# SoloFlow uninstaller — removes agents, commands, and hooks from a target project.
# Optionally also removes task history and state.
#
# Usage: bash uninstall.sh [project_dir] [flags]
# Defaults to current directory if no project_dir given.
#
# Flags:
#   --scaffolding   Remove only agents/commands/hooks. Keep .soloflow/ data.
#   --all           Remove scaffolding AND .soloflow/ data (task history, ideas, archive).
#   --dry-run       Show what would be removed without doing it.
#
# If neither --scaffolding nor --all is given, you will be prompted.

MODE=""
DRY_RUN=false
PROJECT_ARG=""

for arg in "$@"; do
  case "$arg" in
    --scaffolding) MODE="scaffolding" ;;
    --all)         MODE="all" ;;
    --dry-run)     DRY_RUN=true ;;
    *)             PROJECT_ARG="$arg" ;;
  esac
done

PROJECT_DIR="$(cd "${PROJECT_ARG:-.}" && pwd)"

echo "Uninstalling SoloFlow from $PROJECT_DIR"
if $DRY_RUN; then echo "  (dry run — no changes will be made)"; fi
echo ""

# --- Prompt for mode if not specified ---
if [ -z "$MODE" ]; then
  echo "What would you like to remove?"
  echo "  1) Scaffolding only — agents, commands, hooks (keeps .soloflow/ task history)"
  echo "  2) Everything       — scaffolding AND .soloflow/ data (ideas, plans, archive)"
  echo ""
  read -r -p "Choose [1/2]: " choice
  case "$choice" in
    1) MODE="scaffolding" ;;
    2) MODE="all" ;;
    *) echo "Invalid choice. Aborting."; exit 1 ;;
  esac
  echo ""
fi

run() {
  if $DRY_RUN; then
    echo "  [dry-run] $1"
  else
    eval "$2"
    echo "  [done] $1"
  fi
}

# --- Remove agent files ---
if [ -d "$PROJECT_DIR/.claude/agents" ]; then
  for agent in "$PROJECT_DIR"/.claude/agents/soloflow-*.md; do
    [ -e "$agent" ] || [ -L "$agent" ] || continue
    name="$(basename "$agent")"
    run "remove agents/$name" "rm -f '$agent'"
  done
fi

# --- Remove command files ---
if [ -d "$PROJECT_DIR/.claude/commands/soloflow" ]; then
  for cmd in "$PROJECT_DIR"/.claude/commands/soloflow/soloflow-*.md; do
    [ -e "$cmd" ] || [ -L "$cmd" ] || continue
    name="$(basename "$cmd")"
    run "remove commands/soloflow/$name" "rm -f '$cmd'"
  done

  if $DRY_RUN; then
    echo "  [dry-run] remove commands/soloflow/ (if empty)"
  else
    rmdir "$PROJECT_DIR/.claude/commands/soloflow" 2>/dev/null && \
      echo "  [done] remove commands/soloflow/" || true
  fi
fi

# --- Remove hooks from settings.json ---
SETTINGS_FILE="$PROJECT_DIR/.claude/settings.json"

if [ -f "$SETTINGS_FILE" ]; then
  if $DRY_RUN; then
    echo "  [dry-run] remove soloflow hooks from settings.json"
  else
    node -e "
const fs = require('fs');

const settingsFile = '$SETTINGS_FILE';
const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));

if (settings.hooks) {
  let removed = 0;
  for (const event of Object.keys(settings.hooks)) {
    const before = settings.hooks[event].length;
    settings.hooks[event] = settings.hooks[event].filter(group =>
      !(group.hooks && group.hooks.some(h => h.command && h.command.includes('soloflow')))
    );
    removed += before - settings.hooks[event].length;

    if (settings.hooks[event].length === 0) {
      delete settings.hooks[event];
    }
  }

  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
  console.log('  [done] removed ' + removed + ' hook(s) from settings.json');
} else {
  console.log('  [skip] no hooks found in settings.json');
}
"
  fi
else
  echo "  [skip] no settings.json found"
fi

# --- Remove state directory (only in --all mode) ---
if [ "$MODE" = "all" ]; then
  if [ -d "$PROJECT_DIR/.soloflow" ]; then
    run "remove .soloflow/ (task history, ideas, archive)" "rm -rf '$PROJECT_DIR/.soloflow'"
  else
    echo "  [skip] no .soloflow/ directory"
  fi
else
  if [ -d "$PROJECT_DIR/.soloflow" ]; then
    echo "  [keep] .soloflow/ (scaffolding-only mode)"
  fi
fi

echo ""
if $DRY_RUN; then
  echo "Dry run complete. Re-run without --dry-run to apply."
else
  echo "SoloFlow uninstalled from $PROJECT_DIR"
  if [ "$MODE" = "scaffolding" ] && [ -d "$PROJECT_DIR/.soloflow" ]; then
    echo "  Task history preserved at .soloflow/"
  fi
fi
