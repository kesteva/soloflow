---
description: Scaffold or repair the .soloflow/ state directory and run the setup wizard
allowed-tools: [Read, Write, Bash, AskUserQuestion]
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
- `.soloflow/archive/ideas`
- `.soloflow/archive/done`
- `.soloflow/archive/reviews`
- `.soloflow/archive/findings`
- `.soloflow/archive/compound`

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

**`.soloflow/active/findings.md`**
```markdown
---
pending_count: 0
last_updated: null
---

# Findings Queue

No findings yet.
```

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

### Q3 — Branch strategy for `/soloflow:executor`

Use `AskUserQuestion`:

- **Question:** "Should `/soloflow:executor` run each invocation on a dedicated branch that gets merged into your base branch after human review?"
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
