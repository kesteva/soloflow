#!/usr/bin/env bash
set -euo pipefail

# SoloFlow uninstaller (script fallback) — removes the files recorded in
# `.claude/soloflow-install/manifest.json` and unregisters hooks from
# `.claude/settings.json`. Optionally also removes `.soloflow/` data.
#
# If SoloFlow was installed via the Claude Code plugin system
# (`/plugin install soloflow`), use `/plugin uninstall soloflow` instead.
#
# Usage: bash uninstall.sh [project_dir] [flags]
# Defaults to current directory if no project_dir given.
#
# Flags:
#   --scaffolding   Remove only installed files + hook entries. Keep .soloflow/.
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
RUNTIME_DIR="$PROJECT_DIR/.claude/soloflow-install"
MANIFEST="$RUNTIME_DIR/manifest.json"

echo "Uninstalling SoloFlow from $PROJECT_DIR"
if $DRY_RUN; then echo "  (dry run — no changes will be made)"; fi
echo ""

if [ ! -f "$MANIFEST" ]; then
  echo "  [error] no script install detected (missing $MANIFEST)" >&2
  echo "          If you installed via the Claude Code plugin system, run" >&2
  echo "          '/plugin uninstall soloflow' inside Claude Code instead." >&2
  exit 1
fi

# --- Prompt for mode if not specified ---
if [ -z "$MODE" ]; then
  echo "What would you like to remove?"
  echo "  1) Scaffolding only — installed files + hook entries (keeps .soloflow/)"
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

# --- Remove tracked files + unregister hooks via node ---
node <<NODE
const fs = require('fs');
const path = require('path');

const projectDir = '$PROJECT_DIR';
const runtimeDir = '$RUNTIME_DIR';
const manifestPath = '$MANIFEST';
const dryRun = $DRY_RUN;
const settingsFile = path.join(projectDir, '.claude', 'settings.json');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

// Remove each tracked file.
for (const rel of manifest.files) {
  const abs = path.join(projectDir, rel);
  if (fs.existsSync(abs)) {
    if (dryRun) {
      console.log('  [dry-run] remove ' + rel);
    } else {
      fs.unlinkSync(abs);
      console.log('  [done] remove ' + rel);
    }
  }
}

// Prune empty directories under .claude/ (bottom-up).
const dirsToCheck = new Set();
for (const rel of manifest.files) {
  let dir = path.dirname(path.join(projectDir, rel));
  while (dir.startsWith(path.join(projectDir, '.claude'))) {
    dirsToCheck.add(dir);
    dir = path.dirname(dir);
  }
}
// Sort deepest-first so we remove children before parents.
const sortedDirs = Array.from(dirsToCheck).sort((a, b) => b.length - a.length);
for (const d of sortedDirs) {
  try {
    if (!fs.existsSync(d)) continue;
    if (fs.readdirSync(d).length === 0) {
      if (dryRun) {
        console.log('  [dry-run] rmdir ' + path.relative(projectDir, d));
      } else {
        fs.rmdirSync(d);
        console.log('  [done] rmdir ' + path.relative(projectDir, d));
      }
    }
  } catch (e) { /* ignore */ }
}

// Remove runtime dir (VERSION, manifest.json, hooks/) entirely.
if (fs.existsSync(runtimeDir)) {
  if (dryRun) {
    console.log('  [dry-run] rm -rf ' + path.relative(projectDir, runtimeDir));
  } else {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
    console.log('  [done] rm -rf ' + path.relative(projectDir, runtimeDir));
  }
}

// Unregister hooks by absolute-path substring match against the old runtime dir.
if (fs.existsSync(settingsFile)) {
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  if (settings.hooks) {
    let removed = 0;
    for (const event of Object.keys(settings.hooks)) {
      const before = settings.hooks[event].length;
      settings.hooks[event] = settings.hooks[event].filter((group) =>
        !(group.hooks && group.hooks.some((h) => h.command && h.command.includes(runtimeDir)))
      );
      removed += before - settings.hooks[event].length;
      if (settings.hooks[event].length === 0) delete settings.hooks[event];
    }
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

    if (dryRun) {
      console.log('  [dry-run] unregister ' + removed + ' hook(s) from settings.json');
    } else {
      fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
      console.log('  [done] unregistered ' + removed + ' hook(s) from settings.json');
    }
  }
}
NODE

# --- Remove state directory (only in --all mode) ---
if [ "$MODE" = "all" ]; then
  if [ -d "$PROJECT_DIR/.soloflow" ]; then
    if $DRY_RUN; then
      echo "  [dry-run] rm -rf .soloflow/ (task history, ideas, archive)"
    else
      rm -rf "$PROJECT_DIR/.soloflow"
      echo "  [done] rm -rf .soloflow/ (task history, ideas, archive)"
    fi
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
