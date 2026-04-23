---
description: Scaffold or repair the .soloflow/ state directory and run the setup wizard
allowed-tools: [Read, Write, Bash, AskUserQuestion]
model: sonnet
---

# /soloflow:init

Scaffolds the `.soloflow/` state directory that every other SoloFlow command
depends on. **This command is idempotent** — run it once when setting up a
project, and re-run it any time you suspect `.soloflow/` is missing files
(e.g. after a plugin update that adds new state files). Existing files are
never overwritten; only missing pieces are created.

After ensuring the directory tree is in place, a short setup wizard asks
about visual verification and branching preferences and writes the answers
to `.soloflow/config.json`.

---

## Step 1: Detect state

Run `test -d .soloflow` via Bash.

- If `.soloflow/` exists → mode is **repair**. Tell the user:
  ```
  Repairing .soloflow/ — checking for missing files...
  ```
- Otherwise → mode is **fresh**. Tell the user:
  ```
  Initializing .soloflow/ in this project...
  ```

Carry the `mode` forward for the final report. Track two counters throughout
Steps 2–3: `dirs_created`, `files_created` (everything else is "already present").

## Step 2: Ensure directories

For each of these paths, run `mkdir -p` via Bash. For each path that did NOT
exist before the `mkdir` (check with `test -d` first, then create), write an
empty `.gitkeep` file into it.

- `.soloflow/active/ideas`
- `.soloflow/active/research`
- `.soloflow/active/plans`
- `.soloflow/active/stuck`
- `.soloflow/active/findings`
- `.soloflow/active/compound`
- `.soloflow/archive/ideas`
- `.soloflow/archive/done`
- `.soloflow/archive/reviews`
- `.soloflow/archive/findings`
- `.soloflow/archive/compound`
- `.soloflow/active/roadmaps`
- `.soloflow/archive/roadmaps`

Increment `dirs_created` for every directory you actually created.

## Step 3: Ensure state files

For each of these files, run `test -e <path>` first. **Only** write the file
if it does not already exist. Never overwrite — the file may contain live
user state (backlog tasks, sprint data, checkpoint notes). Increment
`files_created` for every file you actually wrote.

**`.soloflow/active/backlog.json`**
```json
{
  "version": 2,
  "tasks": {}
}
```

**`.soloflow/active/sprint.json`**
```json
{
  "version": 2,
  "sprint": null,
  "tasks": {}
}
```

**Findings queue layout**

Findings are written one file per sprint at `.soloflow/active/findings/SPRINT-NNN-findings.md`. The per-sprint file is created by `sprint-initiator` when each sprint starts, so `/soloflow:init` does NOT scaffold a global `findings.md` anymore.

**Legacy migration (one-shot).** If a legacy `.soloflow/active/findings.md` exists and an active sprint is present in `sprint.json`, move the legacy file to `.soloflow/active/findings/{sprint.id}-findings.md` (mirrors `scripts/init.sh` behavior). If no active sprint, leave the legacy file in place and print: `Legacy active/findings.md detected; next /soloflow:compound will attribute it to the selected sprint.` Increment `files_created` only when a move actually happens.

**`.soloflow/checkpoint.md`**
```markdown
---
last_updated: null
active_sprint: null
tasks_in_flight: []
---

# Session Checkpoint

No checkpoint data yet. Updated by the pre-compact hook to preserve state across context compactions.
```

**`.soloflow/human-review-queue.md`**
```markdown
---
pending_count: 0
items: []
---

# Human Review Queue

No items pending review.
```

## Step 4: Setup wizard

First, **read the existing config** if any:
- Run `test -e .soloflow/config.json`. If present, Read it and parse the JSON
  into memory as `config`. If absent, start with `config = {}`.
- Keep existing keys intact — the wizard only touches `verification.visual_mobile`,
  `verification.visual_web`, and `git.branch_per_run`. Everything else the user
  may have added to `config.json` must be preserved through the final write.

When a question has a known "current value" from the parsed config, label
that option with `(current)` in the `AskUserQuestion` call so the user can
see what's already set.

### Q1 — Visual verification on/off

Use `AskUserQuestion`:

- **Question:** "Do you want visual verification for this project? SoloFlow can drive a running app via Maestro (mobile) or Playwright (web) to check UI against acceptance criteria."
- **Header:** "Visual verify"
- **Options:**
  - "Yes — set it up now"
  - "No, skip" *(label this one `(current)` if both `visual_mobile` and `visual_web` are currently `false` or unset)*

If **No**: set `config.verification.visual_mobile = false` and `config.verification.visual_web = false`, then jump to Q3.

If **Yes**: proceed to Q2.

### Q2 — Project type (only if Q1 = Yes)

Use `AskUserQuestion`:

- **Question:** "What kind of app is this?"
- **Header:** "App type"
- **Options:**
  - "Mobile (Maestro)"
  - "Web (Playwright)"
  - "Both mobile + web"

Label the option matching the current config (if any) with `(current)`.

Set config accordingly:
- Mobile → `visual_mobile: true`, `visual_web: false`
- Web → `visual_mobile: false`, `visual_web: true`
- Both → both true

### Dependency check (runs after Q2, per selected type)

**Mobile / Maestro** — only if `visual_mobile` is now true:

1. Run `which maestro` via Bash.
2. **If found:** print `✓ maestro CLI detected at <path>`. Proceed.
3. **If missing:** use `AskUserQuestion`:
   - **Question:** "Maestro CLI is required for mobile visual verification but isn't on your PATH. Install it now? (Runs `curl -Ls https://get.maestro.mobile.dev | bash`.)"
   - **Header:** "Install Maestro"
   - **Options:**
     - "Install now"
     - "Skip for now"
   - **On Install now:** run `curl -Ls "https://get.maestro.mobile.dev" | bash` via Bash. After it exits, re-run `which maestro`.
     - If now found → print `✓ maestro installed at <path>`.
     - If still missing → warn: `⚠ Maestro installed but not on PATH. Add this line to your shell profile (~/.zshrc or ~/.bashrc):\n    export PATH="$PATH:$HOME/.maestro/bin"\nThen restart your shell.` Do NOT retry the installer.
   - **On Skip for now:** print: `Visual verification will still be enabled in config — the verifier will gracefully skip Maestro until \`maestro\` is on PATH. Install later with:\n    curl -Ls https://get.maestro.mobile.dev | bash`

**Web / Playwright** — only if `visual_web` is now true:

1. Run `which npx` via Bash.
2. **If found:** print `✓ npx detected; Playwright MCP runs via "npx @playwright/mcp@latest" on demand — no separate install needed.`
3. **If missing:** print `⚠ Node.js / npx is required for Playwright visual verification. Install Node.js from https://nodejs.org before running visual verification. Your config will still be written.` Do NOT attempt to install Node.

### MCP server registration (runs after dependency check, per selected type)

The plugin does NOT ship its own `.mcp.json` — that would collide for any user who already has `maestro` or `playwright` registered. Instead, detect and offer to register.

For each required MCP server (`maestro` if `visual_mobile`, `playwright` if `visual_web`):

1. Run `claude mcp list` via Bash and grep the output for the server name.
2. **If already registered:** print `✓ MCP server "<name>" already registered`. Continue.
3. **If missing:** use `AskUserQuestion`:
   - **Question:** `'MCP server "<name>" is not registered with Claude Code. Register it now?'`
   - **Header:** `Register <name>`
   - **Options:**
     - `"Yes — user scope (all projects)"`
     - `"Yes — project scope (this project only, writes .mcp.json)"`
     - `"Skip"`
   - **On user scope:** run the appropriate command:
     - maestro: `claude mcp add --scope user maestro maestro mcp`
     - playwright: `claude mcp add --scope user playwright npx @playwright/mcp@latest`
   - **On project scope:** same command with `--scope project`.
   - **On Skip:** print `Visual verification will be enabled in config — the verifier will gracefully skip <name> until the MCP server is registered. Register later with: claude mcp add --scope user <args>`.
4. After a successful `claude mcp add`, re-run `claude mcp list` and confirm the entry appears. If not, warn but do not retry.

Never run `claude mcp add` without the explicit user choice above — registering servers silently is exactly the collision problem we're avoiding.

### Shadow-install visual verification agents (only if `visual_mobile` or `visual_web` is true)

**Why this step exists — surface it clearly to the user.** Visual verification requires `verifier` and `sprint-verifier` to call `mcp__maestro__*` / `mcp__playwright__*` tools. Plugin-scoped subagents **cannot receive MCP tool bindings** in Claude Code, even when the agent frontmatter declares `mcpServers:` — the declaration is silently ignored for plugin agents. Without this shadow-install, every visual check would degrade to `skipped_unable`. This step is **mandatory** when visual verification is enabled; skip it only when the plugin root can't be resolved.

1. Resolve the plugin root: `echo "$CLAUDE_PLUGIN_ROOT"` via Bash.
   - If empty, set `visual_agents_status = "skipped_no_root"` and print: `⚠ CLAUDE_PLUGIN_ROOT not set — can't shadow-install visual verification agents. Every visual check will degrade to \`skipped_unable\` until you re-run /soloflow:init in a context where the plugin root resolves.` Continue to the next wizard section.

2. Ensure target dir: `mkdir -p .claude/agents` via Bash.

3. Shadow-copy both agents (overwrite on re-run — this is how plugin updates propagate):
   - `cp "$CLAUDE_PLUGIN_ROOT/agents/verifier.md" .claude/agents/verifier.md`
   - `cp "$CLAUDE_PLUGIN_ROOT/agents/sprint-verifier.md" .claude/agents/sprint-verifier.md`

4. Print an explicit callout — visual verification users need to understand what happened and why:
   ```
   ✓ Shadow-installed visual verification agents to .claude/agents/:
       verifier.md         — per-task Level 2 visual check (mcpServers: [maestro, playwright])
       sprint-verifier.md  — end-of-sprint visual check    (mcpServers: [maestro, playwright])

   Why: plugin-scoped subagents cannot receive MCP tool bindings in Claude Code. Project-local ones do.
   The shadows override the plugin versions whenever /soloflow:sprint spawns `verifier` or `sprint-verifier`,
   which is how Maestro / Playwright tools actually reach the verification subagent session.

   ⚠ Restart Claude Code (or run /agents to reload) for the shadows to take effect — subagents are loaded
     at session start, so freshly-written shadow agents aren't picked up until reload.
   ```

5. Set `visual_agents_status = "shadowed 2 agents"`.

### Optional plugin probes

Two Anthropic-published plugins can improve SoloFlow agent output when installed. **Neither is required** — SoloFlow's runtime agents fall back silently when they're missing. Probe each; if present, surface a `✓` detected line. If absent, offer to install via `AskUserQuestion` (mirrors the MCP-server registration pattern in the previous section). Never install silently.

**context7** (MCP plugin) — gives the researcher and roadmap-researcher version-accurate library docs via `resolve-library-id` + `query-docs`, reducing hallucinated APIs.

1. Probe: `claude mcp list 2>/dev/null | grep -qi context7`
2. **If present:** print `✓ context7 MCP detected — researcher will prefer it for library docs.` Continue.
3. **If absent:** use `AskUserQuestion`:
   - **Question:** `'The "context7" MCP plugin gives the researcher version-accurate library docs (falls back to WebFetch when missing). Install it now?'`
   - **Header:** `Install context7`
   - **Options:**
     - `"Yes — user scope (all projects)"`
     - `"Yes — project scope (this project only)"`
     - `"Skip"`
   - **On user scope:** run `claude plugin install context7 --scope user` via Bash.
   - **On project scope:** run `claude plugin install context7 --scope project` via Bash.
   - **On Skip:** print:
     ```
     ℹ context7 MCP not installed. Optional — the researcher will fall back to WebFetch.
       Install later with: /plugin install context7@anthropics
     ```
4. After a successful install, re-run the probe at step 1. If it still fails, print `ℹ context7 installed — restart Claude Code to load it in this session.` Do NOT retry.

5. **Shadow-install research agents** — regardless of whether context7 is currently installed. Same plugin-binding limitation as the visual verification shadow: `researcher` and `roadmap-researcher` declare `mcpServers: [context7]`, which is ignored while they live in the plugin scope. Shadowing them now means if the user installs context7 later, the bindings will reach the subagent sessions without another init.
   - Resolve plugin root (same pattern as step 1 of the visual verification shadow). If empty, set `research_agents_status = "skipped_no_root"` and continue.
   - `mkdir -p .claude/agents`
   - `cp "$CLAUDE_PLUGIN_ROOT/agents/researcher.md" .claude/agents/researcher.md`
   - `cp "$CLAUDE_PLUGIN_ROOT/agents/roadmap-researcher.md" .claude/agents/roadmap-researcher.md`
   - Print: `✓ Shadow-installed 2 research agents to .claude/agents/ (researcher, roadmap-researcher) — required for context7 tool bindings to reach these subagents.`
   - Set `research_agents_status = "shadowed 2 agents"`.

**frontend-design** (plugin with skill) — gives the task-refiner and executor a distinctive UI design direction (aesthetic, typography, motion, spatial composition) for UI tasks.

1. Probe: `claude plugin list 2>/dev/null | grep -qi frontend-design` first; if that command fails or returns empty, fall back to `ls ~/.claude/plugins 2>/dev/null | grep -qi frontend-design`.
2. **If either probe passes:** print `✓ frontend-design plugin detected — task-refiner will establish Design Direction for UI slices.` Continue.
3. **If both probes fail:** use `AskUserQuestion`:
   - **Question:** `'The "frontend-design" plugin gives the task-refiner a distinctive UI design direction for UI tasks (UI tasks ship with conventional defaults when missing). Install it now?'`
   - **Header:** `Install frontend-design`
   - **Options:**
     - `"Yes — user scope (all projects)"`
     - `"Yes — project scope (this project only)"`
     - `"Skip"`
   - **On user scope:** run `claude plugin install frontend-design --scope user` via Bash.
   - **On project scope:** run `claude plugin install frontend-design --scope project` via Bash.
   - **On Skip:** print:
     ```
     ℹ frontend-design plugin not installed. Optional — UI tasks will ship with conventional defaults.
       Install later with: /plugin install frontend-design@anthropics
     ```
4. After a successful install, re-run the probe at step 1. If it still fails, print `ℹ frontend-design installed — restart Claude Code to load it in this session.` Do NOT retry.

A backend-only project has no need for frontend-design; a project that doesn't rely on third-party libraries has no need for context7 — both are safe to skip. Never run `claude plugin install` without the explicit user choice above.

### Q3 — Branch strategy for `/soloflow:sprint`

Use `AskUserQuestion`:

- **Question:** "Should `/soloflow:sprint` run each invocation on a dedicated branch that gets merged into your base branch after human review?"
- **Header:** "Run branches"
- **Options:**
  - "Ask me each run (prompt)"
  - "Always create a run branch"
  - "Never — run on current branch"

Label the option matching the current `config.git.branch_per_run` (if any)
with `(current)`.

Set `config.git.branch_per_run` to `"prompt"`, `"always"`, or `"never"`.

### Merge and write

Shallow-merge the wizard answers into the `config` object:
- Ensure `config.verification` exists; set `visual_mobile` and `visual_web`.
- Ensure `config.git` exists; set `branch_per_run`.
- Leave every other key in `config` untouched.

Write the result to `.soloflow/config.json` with 2-space indentation and a
trailing newline. Use `Write` — overwriting is expected here because we just
merged with the previous content.

**Tip for the user:** after init, re-run `/soloflow:config` anytime to adjust
any setting (models, limits, phases, verification, git, roadmap, tester) — it
walks through every value in `config/defaults.yaml` interactively and preserves
unknown keys.

## Step 4.5: Status line setup

The SoloFlow status line shows sprint/task state and a context usage bar. It requires a `statusLine` entry in the user's `~/.claude/settings.json` — hooks.json cannot register status lines.

1. Read `~/.claude/settings.json` via Bash (`cat ~/.claude/settings.json`).
2. Check if a `statusLine` key already exists.
   - If present AND its `command` already points to the soloflow statusline script → print `✓ Status line already configured`. Skip to next step.
   - If present with a **different** command → use `AskUserQuestion`:
     - **Question:** "A custom status line is already configured. Replace it with the SoloFlow status line? (Your current command: `{existing_command}`)"
     - **Header:** "Status line"
     - **Options:**
       - "Replace with SoloFlow status line"
       - "Keep current status line"
     - On **Keep**: skip. On **Replace**: proceed to step 3.
   - If absent → proceed to step 3.
3. Resolve the plugin root: run `echo $CLAUDE_PLUGIN_ROOT` via Bash. If empty, fall back to the directory containing this plugin's `hooks/` folder.
4. Merge a `statusLine` object into the parsed settings JSON:
   ```json
   {
     "statusLine": {
       "type": "command",
       "command": "node \"{CLAUDE_PLUGIN_ROOT}/hooks/statusline.js\""
     }
   }
   ```
   Preserve all other keys in settings.json.
5. Write the updated settings back to `~/.claude/settings.json` with 2-space indentation.
6. Print: `✓ Status line configured — restart Claude Code to activate.`

## Step 4.6: Safe-command allow list

SoloFlow agents (executor, verifier, code-reviewer) run many safe read-only commands. Pre-allowlisting them in `~/.claude/settings.json` reduces permission prompts without adding real risk.

The default allow list (25 entries):

```
Bash(grep:*)              Bash(git status:*)
Bash(find:*)              Bash(git log:*)
Bash(ls:*)                Bash(git diff:*)
Bash(cat:*)               Bash(git show:*)
Bash(head:*)              Bash(git branch:*)
Bash(tail:*)              Bash(git check-ignore:*)
Bash(wc:*)                Bash(git add:*)
Bash(sort:*)              Bash(git commit:*)
Bash(uniq:*)
Bash(which:*)
Bash(file:*)
Bash(date:*)
Bash(echo:*)
Bash(pwd:*)
Bash(tree:*)
Bash(mkdir:*)
Bash(test:*)
```

Deliberately excluded (stay prompted each time): `rm`, `mv`, `cp`, `chmod`, `chown`, `sudo`, `git push`, `git reset`, `git rebase`, `npm install`, `pnpm install`, `curl`, `wget`. These are destructive, privileged, or fetch arbitrary code.

### Procedure

1. Use `AskUserQuestion`:
   - **Question:** `"Add SoloFlow's default safe-command allow list to ~/.claude/settings.json? This preallows read-only commands (grep, find, cat, git status/log/diff, etc.) plus git add/commit. Destructive commands (rm, git push, npm install) stay prompted."`
   - **Header:** `"Allow list"`
   - **Options:**
     - `"Yes — add safe defaults"`
     - `"Skip"`
   - On **Skip**: set `allow_list_status = "skipped"` and continue to Step 5.
2. Read `~/.claude/settings.json` via Bash (`cat ~/.claude/settings.json`). If the file does not exist, treat the parsed object as `{}`.
3. Normalize shape:
   - Ensure `settings.permissions` is an object.
   - Ensure `settings.permissions.allow` is an array (default `[]`).
4. Compute the diff: iterate the default list **in the documented order** and collect entries not already present in `permissions.allow`. Use **exact string comparison** — preserve any existing entries verbatim, even near-duplicates like `Bash(grep *)` vs `Bash(grep:*)`.
5. Append the missing entries to the end of `permissions.allow`. Preserve all other keys in `settings` (including `statusLine` written by Step 4.5, `permissions.defaultMode`, `permissions.deny`, `permissions.ask`, etc.). Do **not** set `permissions.defaultMode` if it is absent.
6. Write the updated JSON back to `~/.claude/settings.json` with 2-space indentation and a trailing newline.
7. Report to the user and set `allow_list_status` for the Step 7 summary:
   - If N > 0: print `✓ Allow list updated — added N safe commands` and set `allow_list_status = "added N safe commands"`.
   - If N == 0: print `✓ Allow list already up to date — all 25 safe commands present` and set `allow_list_status = "already up to date"`.

## Step 5: Commit to git (if applicable)

Run `git rev-parse --is-inside-work-tree` via Bash. If the project is inside
a git repo AND `.soloflow/` is not gitignored (`git check-ignore -q .soloflow`
returns non-zero):

1. `git add .soloflow`
2. If `git diff --cached --quiet` reports no staged changes, skip the commit
   (idempotent re-run).
3. Otherwise `git commit -m "chore: initialize .soloflow state"`.

If the project isn't a git repo, skip this step silently.

## Step 6: Orphaned file check

Check for known-orphaned files from previous versions:

- `.soloflow/counters.json` — removed in 0.5.0 (IDs now derived from the filesystem).

If any exist, add them to the "Orphaned files" section of the final report.
**Do NOT delete them automatically** — stay additive. The user can remove
them manually.

## Step 7: Report

Tell the user:

```
SoloFlow {initialized|repaired} in this project.

Directories: {dirs_created} created, {total_dirs - dirs_created} already present
Files:       {files_created} created, {total_files - files_created} already present

Config: .soloflow/config.json {created|updated}
  verification.visual_mobile: {value}
  verification.visual_web:    {value}
  git.branch_per_run:         {value}

Status line: {configured|already configured|skipped (user kept existing)|not configured}
Allow list:  {added N safe commands|already up to date|skipped}
Visual verification agents: {shadowed 2 agents (verifier, sprint-verifier)|not shadowed — visual verification disabled|skipped_no_root}
Research agents:            {shadowed 2 agents (researcher, roadmap-researcher)|skipped_no_root}

{if any orphaned files:}
Orphaned files (safe to remove manually):
  .soloflow/counters.json   (removed in 0.5.0)

Next steps:
  /soloflow:idea-extractor "<description>"   — start the full pipeline
  /soloflow:quick "<bug description>"        — fast path for bugfixes
  /soloflow:status                           — check current state
```

Use "initialized" / "created" for fresh mode, "repaired" / "updated" for
repair mode.
