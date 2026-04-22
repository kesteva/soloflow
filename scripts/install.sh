#!/usr/bin/env bash
set -euo pipefail

# SoloFlow installer (script fallback) — copies agents, commands, skills, and
# hook scripts into a target project's `.claude/` directory. This is the
# vendoring path for users who can't or don't want to use `/plugin install`.
#
# The primary install path is `/plugin install soloflow` inside Claude Code.
# This script exists for: CI environments, air-gapped machines, Windows users
# without Developer Mode, and anyone who prefers explicit control.
#
# Usage: bash install.sh [project_dir]
# Defaults to current directory if no argument given.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOLOFLOW_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_DIR="$(cd "${1:-.}" && pwd)"

MANIFEST_SRC="$SOLOFLOW_DIR/.claude-plugin/plugin.json"
if [ ! -f "$MANIFEST_SRC" ]; then
  echo "  [error] plugin manifest not found at $MANIFEST_SRC" >&2
  exit 1
fi

VERSION="$(node -e "console.log(require('$MANIFEST_SRC').version)")"

echo "Installing SoloFlow v$VERSION into $PROJECT_DIR"
echo "  Source: $SOLOFLOW_DIR"
echo ""

CLAUDE_DIR="$PROJECT_DIR/.claude"
RUNTIME_DIR="$CLAUDE_DIR/soloflow-install"
INSTALL_MANIFEST="$RUNTIME_DIR/manifest.json"

# Do the copy work in node — it handles the manifest read/write, the
# ownership check against prior installs, and the hooks.json render in one
# pass. Keeps install.sh shell-only for orchestration.
node <<NODE
const fs = require('fs');
const path = require('path');

const src = '$SOLOFLOW_DIR';
const projectDir = '$PROJECT_DIR';
const claudeDir = '$CLAUDE_DIR';
const runtimeDir = '$RUNTIME_DIR';
const installManifestPath = '$INSTALL_MANIFEST';
const version = '$VERSION';

// Load prior install manifest (if any) to know which files we own.
let priorOwned = new Set();
if (fs.existsSync(installManifestPath)) {
  try {
    const prior = JSON.parse(fs.readFileSync(installManifestPath, 'utf8'));
    priorOwned = new Set(prior.files || []);
  } catch (e) {
    console.error('  [warn] prior manifest unreadable, treating as fresh install');
  }
}
const newOwned = [];

function copyFile(srcPath, destRelToProject) {
  const dest = path.join(projectDir, destRelToProject);
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  const exists = fs.existsSync(dest);
  const isOurs = priorOwned.has(destRelToProject);

  if (exists && !isOurs) {
    console.log('  [warn] ' + destRelToProject + ' exists and is not tracked — skipping');
    return;
  }

  fs.copyFileSync(srcPath, dest);
  newOwned.push(destRelToProject);
  console.log('  [copy] ' + destRelToProject);
}

function copyTree(srcDir, destRelDir) {
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const destRel = path.join(destRelDir, entry.name);
    if (entry.isDirectory()) {
      copyTree(srcPath, destRel);
    } else if (entry.isFile()) {
      copyFile(srcPath, destRel);
    }
  }
}

// --- Agents ---
for (const f of fs.readdirSync(path.join(src, 'agents'))) {
  if (f.endsWith('.md')) {
    copyFile(path.join(src, 'agents', f), path.join('.claude', 'agents', f));
  }
}

// --- Commands (nested under soloflow/ so they become /soloflow:name) ---
for (const f of fs.readdirSync(path.join(src, 'commands'))) {
  if (f.endsWith('.md')) {
    copyFile(path.join(src, 'commands', f), path.join('.claude', 'commands', 'soloflow', f));
  }
}

// --- Skills ---
for (const skillName of fs.readdirSync(path.join(src, 'skills'))) {
  const skillSrc = path.join(src, 'skills', skillName);
  if (fs.statSync(skillSrc).isDirectory()) {
    copyTree(skillSrc, path.join('.claude', 'skills', skillName));
  }
}

// --- Hook scripts into the private runtime dir (always overwritten) ---
fs.mkdirSync(path.join(runtimeDir, 'hooks'), { recursive: true });
for (const f of fs.readdirSync(path.join(src, 'hooks'))) {
  const srcPath = path.join(src, 'hooks', f);
  const destRel = path.join('.claude', 'soloflow-install', 'hooks', f);
  fs.copyFileSync(srcPath, path.join(projectDir, destRel));
  newOwned.push(destRel);
}
console.log('  [copy] soloflow-install/hooks/ (' +
  fs.readdirSync(path.join(runtimeDir, 'hooks')).filter(f => f.endsWith('.js')).length + ' scripts)');

// --- State/config scripts into the private runtime dir (always overwritten) ---
// Agents reference these via \${CLAUDE_PLUGIN_ROOT}/scripts/<subdir>/<file>.js,
// so the layout under soloflow-install/ mirrors the repo.
function copyScriptsTree(srcSubdir) {
  const srcDir = path.join(src, 'scripts', srcSubdir);
  if (!fs.existsSync(srcDir)) return 0;
  const destDir = path.join(runtimeDir, 'scripts', srcSubdir);
  fs.mkdirSync(destDir, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.js')) {
      fs.copyFileSync(path.join(srcDir, entry.name), path.join(destDir, entry.name));
      newOwned.push(path.join('.claude', 'soloflow-install', 'scripts', srcSubdir, entry.name));
      count++;
    }
  }
  return count;
}
let scriptCount = 0;
for (const sub of ['lib', 'config', 'state', 'sprint', 'compound', 'refiner']) {
  scriptCount += copyScriptsTree(sub);
}
console.log('  [copy] soloflow-install/scripts/ (' + scriptCount + ' scripts)');

// --- Render hooks/hooks.json into settings.json ---
const template = JSON.parse(fs.readFileSync(path.join(src, 'hooks', 'hooks.json'), 'utf8'));
const settingsFile = path.join(claudeDir, 'settings.json');
let settings = {};
if (fs.existsSync(settingsFile)) {
  settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
}
if (!settings.hooks) settings.hooks = {};

// \${CLAUDE_PLUGIN_ROOT} in the template resolves to the plugin root, which
// for the script install is the runtime dir itself (it contains hooks/).
const substitute = (s) => s.replace(/\\\$\{CLAUDE_PLUGIN_ROOT\}/g, runtimeDir);

for (const [event, groups] of Object.entries(template.hooks)) {
  if (!settings.hooks[event]) settings.hooks[event] = [];
  for (const group of groups) {
    const rendered = {
      ...(group.matcher ? { matcher: group.matcher } : {}),
      hooks: group.hooks.map((h) => ({ ...h, command: substitute(h.command) })),
    };
    const key = rendered.hooks[0].command;
    const already = settings.hooks[event].some((g) =>
      g.hooks && g.hooks.some((h) => h.command === key)
    );
    if (already) {
      console.log('  [skip] ' + event + ' (already registered)');
    } else {
      settings.hooks[event].push(rendered);
      console.log('  [hook] ' + event);
    }
  }
}
fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');

// --- Write install manifest + version stamp ---
fs.writeFileSync(installManifestPath, JSON.stringify({ version, files: newOwned }, null, 2) + '\n');
fs.writeFileSync(path.join(runtimeDir, 'VERSION'), version + '\n');
console.log('  [stamp] soloflow-install/VERSION = ' + version);
NODE

# --- Initialize state directory ---
echo ""
bash "$SOLOFLOW_DIR/scripts/init.sh" "$PROJECT_DIR/.soloflow"

# --- Stage .soloflow/ in git so task/idea history is tracked ---
if git -C "$PROJECT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if git -C "$PROJECT_DIR" check-ignore -q .soloflow 2>/dev/null; then
    echo "  [warn] .soloflow/ is gitignored — task history will not be tracked"
  else
    git -C "$PROJECT_DIR" add .soloflow >/dev/null 2>&1 && \
      echo "  [git]  staged .soloflow/ for tracking"
  fi
fi

echo ""
echo "Done. SoloFlow v$VERSION installed. Start a Claude Code session and try:"
echo "  /soloflow:status"
echo "  /soloflow:quick \"fix a bug\""
echo "  /soloflow:idea-extractor \"add a new feature\""
echo ""
echo "To update:    bash $SOLOFLOW_DIR/scripts/update.sh $PROJECT_DIR"
echo "To uninstall: bash $SOLOFLOW_DIR/scripts/uninstall.sh $PROJECT_DIR"
