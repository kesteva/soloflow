# SoloFlow → Claude Code Plugin Migration Plan

## Context

SoloFlow today installs via `scripts/install.sh`, which symlinks `agents/`, `commands/`, and registers hooks by writing absolute paths into the project's `.claude/settings.json`. This works on one machine but fails for OSS distribution: no Windows support, no per-project version pinning, dangling symlinks across machines, and a leaky update story (`update.sh` has to guard the source clone's git state).

The repo's `CLAUDE.md` already states the intended distribution is a Claude Code plugin. The good news: the existing directory layout (`agents/`, `commands/`, `skills/`, `.mcp.json`) is *already* what the plugin spec expects — components are auto-discovered by location. The migration is mostly additive.

This plan delivers two install paths:

1. **Primary:** native Claude Code plugin (`/plugin install`, marketplace, auto-update, version-pinned).
2. **Fallback:** a script installer that *copies* (not symlinks) files into a project, for users who want to vendor SoloFlow into a repo or who aren't using the plugin system.

---

## Phase A — Plugin packaging (primary path)

### A1. Add the plugin manifest

Create `.claude-plugin/plugin.json` at the repo root:

```json
{
  "name": "soloflow",
  "version": "0.1.0",
  "description": "Hooks-based workflow orchestration: ideas → plans → execution → verification → learning",
  "author": { "name": "..." },
  "repository": "https://github.com/<owner>/soloflow"
}
```

`name` must be kebab-case; it becomes the namespace prefix (e.g. `/soloflow:idea-extractor`).

### A2. Convert hook registration to `hooks/hooks.json`

Today, hooks are written into `.claude/settings.json` by `install.sh` using absolute paths. For the plugin, move that logic into a static `hooks/hooks.json` and use `${CLAUDE_PLUGIN_ROOT}` for paths so it resolves correctly from the plugin cache (`~/.claude/plugins/cache/soloflow/`).

```json
{
  "SessionStart": [
    { "hooks": [{ "type": "command", "command": "node ${CLAUDE_PLUGIN_ROOT}/hooks/soloflow-session-start.js", "timeout": 10 }] }
  ],
  "PostToolUse": [
    { "matcher": "Write|Edit", "hooks": [{ "type": "command", "command": "node ${CLAUDE_PLUGIN_ROOT}/hooks/soloflow-post-tool-use.js", "timeout": 15 }] }
  ],
  "TaskCompleted": [
    { "hooks": [{ "type": "command", "command": "node ${CLAUDE_PLUGIN_ROOT}/hooks/soloflow-task-completed.js", "timeout": 120 }] }
  ],
  "PreCompact": [
    { "hooks": [{ "type": "command", "command": "node ${CLAUDE_PLUGIN_ROOT}/hooks/soloflow-pre-compact.js", "timeout": 10 }] }
  ],
  "SubagentStop": [
    { "hooks": [{ "type": "command", "command": "node ${CLAUDE_PLUGIN_ROOT}/hooks/soloflow-subagent-stop.js", "timeout": 10 }] }
  ]
}
```

This is the same structure the Node block in `scripts/install.sh:46-117` produces today, just declared statically. `install.sh`'s hook-registration logic can be deleted entirely once the plugin path is the default.

### A3. Audit hook scripts for cwd assumptions

Hooks run in the user's cwd (the project root), so writes to `.soloflow/` continue to work. **Action:** grep each `hooks/soloflow-*.js` for any assumption about the script's own location (e.g. `path.resolve(__dirname, '../config')`). Anything that needs a plugin-relative path must use `process.env.CLAUDE_PLUGIN_ROOT`. Anything that needs project state must stay relative to `process.cwd()`.

**Test:** add a one-liner at the top of each hook that fails loudly if `CLAUDE_PLUGIN_ROOT` is unset (during plugin runs) — surfaces drift early.

### A4. Decide command naming: `/soloflow-foo` vs `/soloflow:foo`

Plugin-installed commands are namespaced as `/<plugin-name>:<command>`. Today, every command file is named `soloflow-foo.md` and invoked as `/soloflow-foo`. Under the plugin model, the natural name becomes `/soloflow:idea-extractor` (filename becomes `idea-extractor.md`).

**Recommendation:** rename command files to drop the `soloflow-` prefix and rely on the plugin namespace. This is a breaking change for existing users — call it out in the changelog and keep a one-line shim doc page mapping old → new names. Same treatment for agent files (`agents/soloflow-executor.md` → `agents/executor.md`).

If breaking the names is too aggressive for v0.2, leave the filenames alone — both `/soloflow-foo` and `/soloflow:soloflow-foo` work, just ugly.

### A5. Skill: `skills/soloflow-visual-verify/`

Auto-discovered. No changes needed beyond confirming `SKILL.md` exists at the expected path. Same naming question as commands — consider renaming to `skills/visual-verify/`.

### A6. MCP servers: `.mcp.json`

Auto-discovered at the plugin root. No changes needed.

### A7. Marketplace listing

Create a minimal marketplace entry (or publish to the official Anthropic marketplace) so users can run `/plugin install soloflow`. Document the git-URL fallback (`claude plugin install https://github.com/<owner>/soloflow`) for users who don't want the marketplace flow.

### A8. State directory: stays in cwd

`.soloflow/` continues to live in the project root (cwd) — it is per-project user data and must be tracked in *the user's* git history, not in `${CLAUDE_PLUGIN_DATA}`. Confirm this in docs so future contributors don't move it.

**Action:** keep `scripts/init.sh` but invoke it from a new `/soloflow:init` command (or first-run hook) instead of from `install.sh`. The plugin install itself shouldn't create files in the user's repo without their knowledge.

### A9. Files to add / modify / delete

| File | Action |
|---|---|
| `.claude-plugin/plugin.json` | **Add** |
| `hooks/hooks.json` | **Add** |
| `commands/soloflow-*.md` | **Rename** (drop `soloflow-` prefix) — optional but recommended |
| `agents/soloflow-*.md` | **Rename** — optional |
| `skills/soloflow-visual-verify/` | **Rename** to `skills/visual-verify/` — optional |
| `hooks/soloflow-*.js` | **Audit** for cwd vs plugin-root path assumptions |
| `scripts/install.sh` | **Repurpose** for fallback path (Phase B) |
| `scripts/update.sh` | **Delete** — replaced by `claude plugin update soloflow` |
| `README.md` / `CLAUDE.md` | **Update** install instructions |
| `CHANGELOG.md` | **Bump** to v0.2.0 with breaking-change note |

---

## Phase B — Script-based fallback (copy installer)

Some users will want to vendor SoloFlow into a repo without the plugin system (CI environments, air-gapped machines, users who prefer explicit control). The fallback installer should:

1. **Copy** files instead of symlinking. No dangling links across machines.
2. **Write a `VERSION` file** into `.claude/soloflow-version` so updates can detect drift and the user can pin per project.
3. **Use the same `hooks/hooks.json`** as the plugin path — but rewrite `${CLAUDE_PLUGIN_ROOT}` to the actual install location at copy time, and merge into the project's `.claude/settings.json` (preserving any user hooks already there).

### B1. Rewrite `scripts/install.sh`

Pseudocode:

```
SOURCE = repo root (or downloaded tarball)
TARGET = $PROJECT_DIR/.claude

cp -r SOURCE/agents/*.md          TARGET/agents/
cp -r SOURCE/commands/             TARGET/commands/soloflow/
cp -r SOURCE/skills/visual-verify  TARGET/skills/
cp    SOURCE/.mcp.json             TARGET/  # merge if present

# Render hooks/hooks.json into settings.json with absolute paths
node scripts/render-hooks.js \
  --template SOURCE/hooks/hooks.json \
  --plugin-root "$PROJECT_DIR/.claude/soloflow-hooks" \
  --settings    "$PROJECT_DIR/.claude/settings.json"

cp -r SOURCE/hooks/  TARGET/soloflow-hooks/

echo "$VERSION" > TARGET/soloflow-version
```

Key differences from today's `install.sh`:
- **Copy, not symlink** (`cp -r` instead of `ln -s`).
- **Hook commands** read from `hooks/hooks.json` template, not hardcoded in the install script.
- **Version stamp** lets `update.sh` know what's installed.

### B2. New `scripts/update.sh` (fallback)

1. Read `.claude/soloflow-version` from the project.
2. Compare to source `.claude-plugin/plugin.json#version`.
3. If differs:
   - Copy new files over (overwriting scaffolding).
   - Prune scaffolding files that no longer exist in the source.
   - Re-render hooks in `.claude/settings.json`.
   - Update `.claude/soloflow-version`.
4. **Never touch `.soloflow/`**.
5. Print `git log --oneline OLD_VERSION..NEW_VERSION` from the source.

### B3. New `scripts/uninstall.sh` (already exists, lightly adapted)

`scripts/uninstall.sh` already distinguishes scaffolding vs data — the modes carry over. Adjust the file glob to match the new copy locations (`.claude/soloflow-hooks/` rather than absolute paths to a clone).

### B4. Local development affordance

For SoloFlow's *own* contributors, add `scripts/dev-link.sh` that does the symlink trick (current behavior) but is clearly marked as a developer-only convenience, not the user-facing install. Or just document `claude --plugin-dir ./soloflow` from the official docs as the dev workflow.

---

## Phase C — Documentation & migration

### C1. README rewrite

Three install sections, in order:

1. **Plugin (recommended):** `/plugin install soloflow`
2. **From git:** `claude plugin install https://github.com/<owner>/soloflow`
3. **Vendored / scripted:** `curl -sSL .../install.sh | bash` or `git clone && bash scripts/install.sh`

### C2. Migration guide for existing users

`docs/MIGRATION-0.1-to-0.2.md`:
- Run `bash scripts/uninstall.sh --scaffolding` (preserves `.soloflow/`).
- Install via `/plugin install soloflow`.
- If command names changed (Phase A4), note the renames.

### C3. CLAUDE.md update

Replace any references to symlink-based install with the plugin model. Note that `.soloflow/` is the only thing that lives in the user's project; everything else is plugin-managed.

---

## Verification

End-to-end test on a fresh project for **each install path**:

1. **Plugin path:**
   - `claude plugin install <local plugin dir>` (using `claude --plugin-dir ./soloflow` for development).
   - Confirm agents/commands/skills appear in `/help`.
   - Run `/soloflow:idea-extractor "test idea"` → idea file lands in `./.soloflow/active/ideas/`.
   - Trigger a `Write` tool call → `soloflow-post-tool-use.js` fires (add a temporary `console.error` to confirm).
   - Bump `plugin.json#version`, run `claude plugin update soloflow`, confirm files refresh.

2. **Script fallback:**
   - `bash scripts/install.sh /tmp/fresh-project`
   - Confirm `.claude/agents/`, `.claude/commands/soloflow/`, `.claude/soloflow-hooks/` are populated with **real files**, not symlinks (`test ! -L`).
   - `.claude/settings.json` contains all 5 hook entries pointing at `/tmp/fresh-project/.claude/soloflow-hooks/...`.
   - `.claude/soloflow-version` matches `plugin.json#version`.
   - Make a change, bump version, run `bash scripts/update.sh` → files update, `.soloflow/` untouched.
   - `bash scripts/uninstall.sh --scaffolding` removes scaffolding, leaves `.soloflow/`.

3. **Cross-platform smoke test:** the script fallback should run on macOS, Linux, and (best effort) Git Bash on Windows, since copies don't need Developer Mode.

---

## Risks & open questions

- **Command renames are breaking.** If we ship Phase A4 in v0.2, every existing user's muscle memory breaks. Mitigation: ship the plugin with old names first (v0.2), do the rename in v0.3 with a deprecation warning. Decision needed before implementation.
- **Hook script auditing in A3.** If any hook reads files from the repo (not from cwd), it will silently break under the plugin path because the working directory is the user's project, not the plugin cache. Must grep before shipping.
- **`.mcp.json` merging in B1.** If the user already has an `.mcp.json` with their own servers, the install must merge, not overwrite. Reuse the same JSON-merge approach today's `install.sh` uses for `settings.json`.
- **Marketplace publishing.** Submitting to the official Anthropic marketplace has its own review/approval flow; the git-URL install path is the immediate fallback while that's pending.
- **`init.sh` ownership.** Should the plugin auto-create `.soloflow/` on first session (via `SessionStart` hook), or require an explicit `/soloflow:init`? The hook approach is friendlier; the explicit approach is less surprising. Recommend the hook, with a config flag to disable.

---

## Critical files (for the executor)

- `.claude-plugin/plugin.json` (new)
- `hooks/hooks.json` (new)
- `hooks/soloflow-*.js` (audit, possibly edit)
- `scripts/install.sh` (rewrite for copy-based fallback)
- `scripts/update.sh` (rewrite for version-diff-based fallback)
- `scripts/uninstall.sh` (minor path updates)
- `commands/`, `agents/`, `skills/` (optional renames — gated on Phase A4 decision)
- `README.md`, `CLAUDE.md`, `CHANGELOG.md`, `docs/MIGRATION-0.1-to-0.2.md`
