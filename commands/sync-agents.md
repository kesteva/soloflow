---
description: Re-sync MCP-dependent agent shadows in .claude/agents/ against the current plugin version
allowed-tools: [Bash]
model: haiku
---

# /soloflow:sync-agents

Updates the four MCP-dependent agent shadows in `.claude/agents/` to match the current SoloFlow plugin version. Use this after a plugin update (or whenever `/soloflow:sprint`'s preflight warns about drift).

**Why these shadows exist.** Plugin-scoped subagents silently ignore the `mcpServers:` frontmatter key, so a plugin-scoped verifier would never receive Playwright/context7 bindings. Project-local copies in `.claude/agents/` DO honor the declaration. To ensure no competing plugin-scoped `shadow-verifier` (etc.) overrides the project-local copy, the templates live at `{plugin_root}/agent-templates/` — outside the plugin's auto-discovered `agents/` directory. The plugin therefore exposes zero `shadow-*` agents of its own; the only ones the harness sees are the ones this command writes into `.claude/agents/`. Each shadow's `tools:` array also explicitly lists its MCP tool bindings (e.g. `mcp__playwright__*`, `mcp__context7__*`) — Claude Code treats `tools:` as a strict allowlist, so `mcpServers:` alone does not grant tool access. Each shadow carries its own version stamp as a YAML comment at the top of the frontmatter (`# soloflow-shadow: version=X synced=Y`) — invisible to Claude Code's YAML parser and to the LLM, but readable by this utility's drift check.

Note: Maestro is no longer listed — since 0.9.3, mobile visual verification runs via the Maestro CLI directly and does not require MCP tool bindings. The shadows remain because Playwright (web) and context7 (research) still use MCP.

## Managed agents

| Agent | Declares | Used by |
|---|---|---|
| `shadow-verifier.md` | `mcpServers: [playwright]` | per-task Level 2 visual verification |
| `shadow-sprint-verifier.md` | `mcpServers: [playwright]` | end-of-sprint visual check |
| `shadow-researcher.md` | `mcpServers: [context7]` | idea research |
| `shadow-roadmap-researcher.md` | `mcpServers: [context7]` | roadmap research |

## Steps

1. **Preflight check.** Run:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/init/shadow-agents.js" --mode check
   ```
   Parse the JSON output. Key fields: `plugin_version`, `drifted` (bool), `needs_update` (array of names), `shadows[]` (per-agent `status`: `current` | `stale` | `untracked` | `not_installed`).

2. **If CLAUDE_PLUGIN_ROOT isn't set** (the script exits non-zero with that reason): print `⚠ CLAUDE_PLUGIN_ROOT not set — this command only works with SoloFlow installed as a Claude Code plugin. If you script-installed via scripts/install.sh, your agents are already project-local and don't need this utility.` Stop.

3. **Print status table.** One line per shadow: `{name} — {status} {recorded_version ? "(v" + recorded_version + ")" : ""}`. After the table, print `Plugin version: v{plugin_version}`.

4. **Nothing to do path.** If `drifted` is `false` AND every shadow is `current`, print `✓ All shadow agents current (v{plugin_version}). Nothing to do.` and stop.

5. **Sync.** If there's drift (or any shadow is `not_installed`), run:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/init/shadow-agents.js" --mode sync --set all
   ```
   Parse the JSON result. Print:
   - `✓ Synced {count}: {list}` for the `synced` array
   - `⚠ Failed {count}: {name} — {reason}` for each `failed` entry (if any)

6. **Restart reminder.** Print:
   ```
   ⚠ Restart Claude Code for the shadow updates to take effect — subagents load at session
     start, so freshly-written shadow agents aren't picked up until the next session.
   ```

## Scope

Read/write only inside `.claude/agents/`. Never touches `.soloflow/`, never commits, never runs git. This is a leaf-node sync utility.
