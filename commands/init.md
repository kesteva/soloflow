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
user state (sprint data, checkpoint notes). Increment `files_created` for
every file you actually wrote.

(There is no `backlog.json`. Plan frontmatter `status` IS the queue —
plans live under `.soloflow/active/plans/**/TASK-*-plan.md`.)

**`.soloflow/active/sprints/`** — per-sprint layout. Each active sprint lives at `.soloflow/active/sprints/<SPRINT-NNN>/sprint.json` (created by `/soloflow:sprint` or `/soloflow:quick` on demand). Init does not scaffold any sprint.json — the directory is created when the first sprint starts.

(For backward-compat documentation: pre-PR-3 projects had a single `.soloflow/active/sprint.json`. Run `node scripts/migrations/migrate-002-per-sprint-sprint-json.js --apply` to move it.)

**Legacy `.soloflow/active/sprint.json` block (kept for reference, no longer scaffolded):**
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
  `verification.visual_web`, `verification.visual_macos`, and `git.branch_per_run`.
  Everything else the user may have added to `config.json` must be preserved
  through the final write.

When a question has a known "current value" from the parsed config, label
that option with `(current)` in the `AskUserQuestion` call so the user can
see what's already set.

### Q1 — Visual verification on/off

Use `AskUserQuestion`:

- **Question:** "Do you want visual verification for this project? SoloFlow can drive a running app via Maestro (mobile), Playwright (web), or Peekaboo (macOS) to check UI against acceptance criteria."
- **Header:** "Visual verify"
- **Options:**
  - "Yes — set it up now"
  - "No, skip" *(label this one `(current)` if `visual_mobile`, `visual_web`, and `visual_macos` are all currently `false` or unset)*

If **No**: set `config.verification.visual_mobile = false`, `config.verification.visual_web = false`, and `config.verification.visual_macos = false`, then jump to Q3.

If **Yes**: proceed to Q2.

### Q2 — Platforms (only if Q1 = Yes)

Use `AskUserQuestion` with `multiSelect: true`:

- **Question:** "Which platforms should SoloFlow verify? Pick all that apply."
- **Header:** "Platforms"
- **multiSelect:** `true`
- **Options:**
  - "Mobile (Maestro)"
  - "Web (Playwright)"
  - "macOS (Peekaboo)"

Label each option with `(current)` if its corresponding toggle is currently `true`.

Set config from the selection set:
- `visual_mobile: true` iff "Mobile (Maestro)" selected, else `false`
- `visual_web: true` iff "Web (Playwright)" selected, else `false`
- `visual_macos: true` iff "macOS (Peekaboo)" selected, else `false`

If the user selects nothing, treat it as a redirect to Q1=No: set all three to `false` and jump to Q3.

**Tip (print after the selection is recorded, before the dependency checks):**

> If your project is Electron, Tauri, Expo with a web platform, or Capacitor, you can set `verification.visual_prefer_playwright: true` in `.soloflow/config.json` after init to route UI verification through Playwright instead of the native driver. For Electron and Tauri this is essentially free — Playwright drives the actual shipped renderer. For Expo Web and Capacitor the verifier auto-falls-back to Maestro whenever a task touches `*.ios.tsx` / `*.android.tsx` / `*.native.tsx` or imports native-only modules (Platform, gesture handlers, expo-camera, etc.), so iOS/Android-only regressions are not masked. Default is off.

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

4. **Simulator / emulator sanity check.** Run:
   ```bash
   IOS=$(xcrun simctl list devices booted 2>/dev/null | grep -c Booted || true)
   AND=$(adb devices 2>/dev/null | awk '$2=="device"' | wc -l | tr -d ' ' || true)
   ```
   - **If either is ≥ 1:** print `✓ Device detected ({IOS} iOS simulator(s), {AND} Android device(s))`.
   - **If both are 0:** print `ℹ No simulator/emulator booted. Start one before running visual verification:\n    open -a Simulator      (iOS)\n    emulator -avd <name>   (Android)\nConfig will still be written — verifier will emit 'skipped_unable' until a device is running.` Do not block.

5. **App bundle ID for ad-hoc flows (optional).** Ad-hoc Maestro flows need an `appId`. Use `AskUserQuestion`:
   - **Question:** `"Set the app bundle ID for ad-hoc Maestro flows? (Leave auto-detect if the project already has Maestro flows in maestro/, .maestro/, or test/maestro/ — the verifier will read appId from them.)"`
   - **Header:** `"App bundle ID"`
   - **Options:**
     - `"Auto-detect from existing flows"`
     - `"Set explicitly"` — follow-up free-form text asks for the bundle ID (e.g., `com.example.myapp`) and writes it to `config.verification.visual_mobile_app_id`.
     - `"Skip (set later)"`

   On **Auto-detect** or **Skip**: leave `visual_mobile_app_id` unset (null). The verifier will grep existing flows for `appId:` at run time; if none exist, it emits `skipped_unable` with an actionable message.

**Web / Playwright** — only if `visual_web` is now true:

1. Run `which npx` via Bash.
2. **If found:** print `✓ npx detected; Playwright MCP runs via "npx @playwright/mcp@latest" on demand — no separate install needed.`
3. **If missing:** print `⚠ Node.js / npx is required for Playwright visual verification. Install Node.js from https://nodejs.org before running visual verification. Your config will still be written.` Do NOT attempt to install Node.

**macOS / Peekaboo** — only if `visual_macos` is now true:

1. Run `which peekaboo` via Bash.
2. **If found:** print `✓ peekaboo CLI detected at <path>`. Then run `peekaboo permissions 2>&1` and parse the output:
   - If both Accessibility and Screen Recording are granted → print `✓ Accessibility and Screen Recording permissions granted`.
   - If either is missing → print `⚠ Peekaboo requires Accessibility and Screen Recording permissions. Grant them in System Settings → Privacy & Security → Accessibility (and Screen Recording), then restart Claude Code. Config will still be written; the verifier will emit 'skipped_unable' until grants are present.` Do NOT block.
3. **If missing:** use `AskUserQuestion`:
   - **Question:** "Peekaboo CLI is required for macOS visual verification but isn't on your PATH. Install it now? (Runs `brew install steipete/tap/peekaboo`.)"
   - **Header:** "Install Peekaboo"
   - **Options:**
     - "Install now"
     - "Skip for now"
   - **On Install now:** first verify Homebrew is available (`which brew`). If missing, print `⚠ Homebrew is not installed. Install it from https://brew.sh then re-run /soloflow:init.` and skip. If present, run `brew install steipete/tap/peekaboo` via Bash. After it exits, re-run `which peekaboo`.
     - If now found → print `✓ peekaboo installed at <path>`. Then run `peekaboo permissions` and print the grants summary as above.
     - If still missing → warn: `⚠ Peekaboo install reported success but `peekaboo` is not on PATH. Restart your shell and try again.` Do NOT retry the installer.
   - **On Skip for now:** print: `Visual verification will still be enabled in config — the verifier will gracefully skip Peekaboo until \`peekaboo\` is on PATH. Install later with:\n    brew install steipete/tap/peekaboo`

4. **npx check (for MCP path).** Peekaboo's MCP server runs via `npx @steipete/peekaboo`. Run `which npx` via Bash if not already done for Playwright. If missing, print `ℹ Node.js / npx not found — Peekaboo MCP will be unavailable, but the verifier can still use the peekaboo CLI fallback. Install Node.js from https://nodejs.org to enable the MCP path.` Do NOT block or attempt to install Node.

### MCP server registration (Playwright + Maestro + Peekaboo)

Both Playwright and Maestro support MCP servers. Playwright is MCP-only; Maestro prefers MCP with a first-class CLI fallback — users can skip Maestro MCP registration and still get mobile visual verification via the CLI.

The plugin does NOT ship its own `.mcp.json` — that would collide for any user who already has one of these servers registered. Instead, detect and offer to register each.

**Playwright MCP** — only if `visual_web` is `true`:

1. Run `claude mcp list` via Bash and grep the output for `playwright`.
2. **If already registered:** print `✓ MCP server "playwright" already registered`. Continue.
3. **If missing:** use `AskUserQuestion`:
   - **Question:** `'MCP server "playwright" is not registered with Claude Code. Register it now?'`
   - **Header:** `Register playwright`
   - **Options:**
     - `"Yes — user scope (all projects)"`
     - `"Yes — project scope (this project only, writes .mcp.json)"`
     - `"Skip"`
   - **On user scope:** `claude mcp add --scope user playwright npx @playwright/mcp@latest`
   - **On project scope:** same command with `--scope project`.
   - **On Skip:** print `Visual verification will be enabled in config — the verifier will gracefully skip Playwright until the MCP server is registered. Register later with: claude mcp add --scope user playwright npx @playwright/mcp@latest`.
4. After a successful `claude mcp add`, re-run `claude mcp list` and confirm the entry appears. If not, warn but do not retry.

**Maestro MCP (optional, recommended)** — only if `visual_mobile` is `true`:

1. Run `claude mcp list` via Bash and grep the output for `maestro`.
2. **If already registered:** print `✓ MCP server "maestro" already registered`. Continue.
3. **If missing:** use `AskUserQuestion`:
   - **Question:** `'MCP server "maestro" is not registered. SoloFlow prefers Maestro MCP (cheaper hierarchy, inline run_flow) but falls back to the Maestro CLI. Register now?'`
   - **Header:** `Register maestro`
   - **Options:**
     - `"Yes — user scope (all projects, recommended)"`
     - `"Yes — project scope (this project only, writes .mcp.json)"`
     - `"Skip (CLI fallback will be used)"`
   - **On user scope:** `claude mcp add --scope user maestro maestro mcp`
   - **On project scope:** same command with `--scope project`.
   - **On Skip:** print `Mobile visual verification will run via the Maestro CLI only. Register later with: claude mcp add --scope user maestro maestro mcp`.
4. After a successful `claude mcp add`, re-run `claude mcp list` and confirm the entry appears. If not, warn but do not retry.

**Peekaboo MCP (optional, recommended)** — only if `visual_macos` is `true`:

1. Run `claude mcp list` via Bash and grep the output for `peekaboo`.
2. **If already registered:** print `✓ MCP server "peekaboo" already registered`. Continue.
3. **If missing:** use `AskUserQuestion`:
   - **Question:** `'MCP server "peekaboo" is not registered. SoloFlow prefers Peekaboo MCP (cheaper structured a11y inspection) but falls back to the peekaboo CLI. Register now?'`
   - **Header:** `Register peekaboo`
   - **Options:**
     - `"Yes — user scope (all projects, recommended)"`
     - `"Yes — project scope (this project only, writes .mcp.json)"`
     - `"Skip (CLI fallback will be used)"`
   - **On user scope:** `claude mcp add --scope user peekaboo npx -y @steipete/peekaboo`
   - **On project scope:** same command with `--scope project`.
   - **On Skip:** print `macOS visual verification will run via the peekaboo CLI only. Register later with: claude mcp add --scope user peekaboo npx -y @steipete/peekaboo`.
4. After a successful `claude mcp add`, re-run `claude mcp list` and confirm the entry appears. If not, warn but do not retry.

Never run `claude mcp add` without the explicit user choice above — registering servers silently is exactly the collision problem we're avoiding.

### Shadow-install visual verification agents (only if `visual_mobile`, `visual_web`, or `visual_macos` is true)

**Why this step exists — surface it clearly to the user.** `shadow-verifier` and `shadow-sprint-verifier` need to call `mcp__playwright__*` tools for web visual verification, `mcp__maestro__*` tools for mobile (when Maestro MCP is registered; the CLI fallback runs through Bash and is unaffected by shadow state), and `mcp__peekaboo__*` tools for macOS (same posture as Maestro — MCP preferred, CLI fallback). Plugin-scoped subagents **cannot receive MCP tool bindings** in Claude Code, even when the agent frontmatter declares `mcpServers:` — the declaration is silently ignored for plugin agents. The plugin therefore does not ship a plugin-resolvable `verifier` / `sprint-verifier`; these agents exist only under the `shadow-` prefix and are installed project-local at init. Without this shadow-install, no verifier is available at all (and Maestro MCP mode, if registered, silently falls back to CLI). This step is **mandatory** when visual verification is enabled; skip it only when the plugin root can't be resolved.

1. Invoke the shadow sync utility with the `visual` set:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/init/shadow-agents.js" --mode sync --set visual
   ```
   The script resolves the plugin root, copies `shadow-verifier.md` and `shadow-sprint-verifier.md` into `.claude/agents/`, and injects a version stamp into each shadow's frontmatter as a YAML comment (`# soloflow-shadow: version=X synced=Y`) at the top. The comment is invisible to Claude Code's YAML parser and to the LLM, but makes drift detectable later (by `/soloflow:sync-agents` or by `/soloflow:sprint`'s preflight).

2. Parse the JSON output. On success (empty `failed` array), set `visual_agents_status = "shadowed 2 agents"`. On failure (script exits non-zero or `CLAUDE_PLUGIN_ROOT` missing), set `visual_agents_status = "skipped_no_root"` and print: `⚠ Could not shadow-install visual verification agents. Every visual check will degrade to \`skipped_unable\` until this is resolved. Run /soloflow:sync-agents manually, or re-run /soloflow:init in a context where CLAUDE_PLUGIN_ROOT resolves.` Then continue to the next wizard section.

3. Print an explicit callout — visual verification users need to understand what happened and why:
   ```
   ✓ Shadow-installed visual verification agents to .claude/agents/ (plugin v{plugin_version}):
       shadow-verifier.md         — per-task Level 2 visual check (mcpServers: [maestro, playwright, peekaboo])
       shadow-sprint-verifier.md  — end-of-sprint visual check    (mcpServers: [maestro, playwright, peekaboo])

   Why: plugin-scoped subagents cannot receive MCP tool bindings in Claude Code. Project-local ones do.
   /soloflow:sprint spawns these by their shadow-* names, so the MCP tool bindings from .claude/agents/
   reach the verification subagent session.

   The synced version is stamped into each shadow's frontmatter as a YAML comment at the top
   (`# soloflow-shadow: version=X synced=Y`). /soloflow:sprint's preflight will detect drift
   automatically after a plugin update and offer to re-sync via /soloflow:sync-agents.

   ⚠ Restart Claude Code for the shadows to take effect — subagents are loaded at session start,
     so freshly-written shadow agents aren't picked up until the next session.
   ```

### Optional plugin probes

One Anthropic-published plugin can improve SoloFlow agent output when installed. **It is not required** — SoloFlow's runtime agents fall back silently when it is missing. Probe it; if present, surface a `✓` detected line. If absent, offer to install via `AskUserQuestion` (mirrors the MCP-server registration pattern in the previous section). Never install silently.

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

5. **Shadow-install research agents** — regardless of whether context7 is currently installed. Same plugin-binding limitation as the visual verification shadow: the research agents declare `mcpServers: [context7]`, which is ignored while they live in the plugin scope. They therefore exist only as `shadow-researcher` / `shadow-roadmap-researcher` in the plugin and must be installed project-local. Shadowing them now means if the user installs context7 later, the bindings will reach the subagent sessions without another init.
   - Run: `node "${CLAUDE_PLUGIN_ROOT}/scripts/init/shadow-agents.js" --mode sync --set research`
   - Parse the JSON output. On success: set `research_agents_status = "shadowed 2 agents"` and print `✓ Shadow-installed 2 research agents to .claude/agents/ (shadow-researcher, shadow-roadmap-researcher) — required for context7 tool bindings to reach these subagents. Version v{plugin_version} stamped into each shadow's frontmatter.`
   - On failure (script exits non-zero or `CLAUDE_PLUGIN_ROOT` missing): set `research_agents_status = "skipped_no_root"` and continue.

A project that doesn't rely on third-party libraries has no need for context7 — it is safe to skip. Never run `claude plugin install` without the explicit user choice above.

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
- Ensure `config.verification` exists; set `visual_mobile`, `visual_web`, and `visual_macos`.
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

## Step 5: Decide git tracking, then commit (if applicable)

Track `git_tracking_status` for the Step 7 report. Possible values:
`"not a git repo"`, `"already gitignored"`, `"tracked"`,
`"tracked (already chosen)"`, `"gitignored"`, `"gitignored (already chosen)"`.

1. Run `git rev-parse --is-inside-work-tree` via Bash. If the project is **not**
   inside a git repo, set `git_tracking_status = "not a git repo"` and skip the
   rest of this step silently.

2. Run `git check-ignore -q .soloflow` via Bash. If it exits 0 (already
   gitignored), set `git_tracking_status = "already gitignored"` and skip the
   rest of this step. Nothing to ask, nothing to commit.

3. Run `git ls-files --error-unmatch .soloflow 2>/dev/null | head -1` via Bash.
   If the output is non-empty, `.soloflow/` already has tracked files in this
   repo — the user chose tracking on a prior run. Skip the prompt:
   - Run `git add .soloflow`.
   - If `git diff --cached --quiet` reports no staged changes, skip the commit
     (idempotent re-run).
   - Otherwise `git commit -m "chore: update .soloflow state"`.
   - Set `git_tracking_status = "tracked (already chosen)"` and continue to
     Step 6.

4. Otherwise this is the first run in a git repo and the user has not yet
   chosen. Use `AskUserQuestion`:

   - **Question:** `"Track .soloflow/ in git, or add it to .gitignore? Tracking commits sprint state, plans, and findings so collaborators (and your future self via git history) can see them. Gitignoring keeps the workflow purely local — recommended for solo work or when you don't want sprint files in your repo history."`
   - **Header:** `".soloflow tracking"`
   - **Options:**
     - `"Track in git (commit state files)"`
     - `"Add to .gitignore (keep local only)"`

5. **On Track in git:**
   - `git add .soloflow`
   - If `git diff --cached --quiet` reports no staged changes, skip the commit.
   - Otherwise `git commit -m "chore: initialize .soloflow state"`.
   - Set `git_tracking_status = "tracked"`.

6. **On Add to .gitignore:**
   - Read `.gitignore` if it exists, otherwise treat the contents as empty.
   - If the file already contains a line equal to `.soloflow/` or `.soloflow`
     (after trimming whitespace), set
     `git_tracking_status = "gitignored (already chosen)"` and skip the rest
     of this step (defensive — `git check-ignore` should have caught this in
     step 2, but a stray entry under a `!negation` could land here).
   - Otherwise append `.soloflow/` on its own line. If the existing file does
     not end with a newline, prepend one to the appended entry so the new
     line is clean. Use `Write` to overwrite the file with the merged
     contents (preserving every other line verbatim).
   - `git add .gitignore`
   - If `git diff --cached --quiet` reports no staged changes, skip the
     commit. Otherwise `git commit -m "chore: gitignore .soloflow state"`.
   - Set `git_tracking_status = "gitignored"`.

## Step 6: Orphaned file check

Check for known-orphaned files from previous versions:

- `.soloflow/counters.json` — removed in 0.5.0 (IDs now derived from the filesystem).

If any exist, add them to the "Orphaned files" section of the final report.
**Do NOT delete them automatically** — stay additive. The user can remove
them manually.

## Step 6.5: Project context detection

SoloFlow agents work best when the project ships three "shared-context" docs
that every subagent loads on entry: `CLAUDE.md`, `ARCHITECTURE.md`, and
`CODE-PATTERNS.md`. Detect which (if any) are missing and offer to bootstrap
them via `/soloflow:map-codebase`. This step never writes those files itself —
the user runs the dedicated command after init exits, since map-codebase is
interactive (multi-select prompts, file generation).

1. Glob for each artifact in its conventional locations (same rules as
   `commands/map-codebase.md` Step 1):
   - **CLAUDE.md** → `CLAUDE.md` at project root.
   - **ARCHITECTURE.md** → first match wins among: `ARCHITECTURE.md`,
     `docs/ARCHITECTURE.md`, `docs/architecture.md`, `ARCHITECTURE/README.md`.
   - **CODE-PATTERNS.md** → first match wins among: `CODE-PATTERNS.md`,
     `docs/CODE-PATTERNS.md`, `docs/code-patterns.md`.
2. Build `missing_context` — the list of artifact names that have no match.
3. Set `context_status` for the Step 7 report:
   - If `missing_context` is empty → `"all present"` and skip to Step 7.
   - Otherwise → `"missing: <comma-joined names>"`, then continue to step 4.
4. Use `AskUserQuestion`:
   - **Question:** `"Missing project-context docs: {comma-joined missing names}. SoloFlow agents work better when these exist. Run /soloflow:map-codebase to scaffold them?"`
   - **Header:** `"Map codebase"`
   - **Options:**
     - `"Yes — I'll run /soloflow:map-codebase after init"`
     - `"Skip for now"`
5. On **Yes**: append ` — user will run /soloflow:map-codebase` to
   `context_status` and set `suggest_map_codebase = true` so Step 7 surfaces
   the command at the top of the Next steps block.
6. On **Skip for now**: append ` — skipped` to `context_status` and leave
   `suggest_map_codebase = false`.

If `.soloflow/` was already initialized before this run AND `missing_context`
is empty, omit step 4's prompt — there is nothing to ask about.

## Step 7: Report

Tell the user:

```
SoloFlow {initialized|repaired} in this project.

Directories: {dirs_created} created, {total_dirs - dirs_created} already present
Files:       {files_created} created, {total_files - files_created} already present

Config: .soloflow/config.json {created|updated}
  verification.visual_mobile: {value}
  verification.visual_web:    {value}
  verification.visual_macos:  {value}
  git.branch_per_run:         {value}

Status line: {configured|already configured|skipped (user kept existing)|not configured}
Allow list:  {added N safe commands|already up to date|skipped}
Git tracking: {tracked|gitignored|already gitignored|tracked (already chosen)|gitignored (already chosen)|not a git repo}
Visual verification agents: {shadowed 2 agents (verifier, sprint-verifier)|not shadowed — visual verification disabled|skipped_no_root}
Research agents:            {shadowed 2 agents (shadow-researcher, shadow-roadmap-researcher)|skipped_no_root}
Project context:            {context_status from Step 6.5}

{if any orphaned files:}
Orphaned files (safe to remove manually):
  .soloflow/counters.json   (removed in 0.5.0)

Next steps:
  {if suggest_map_codebase from Step 6.5:}
  /soloflow:map-codebase                     — scaffold missing CLAUDE.md / ARCHITECTURE.md / CODE-PATTERNS.md
  {end if}
  /soloflow:idea-extractor "<description>"   — start the full pipeline
  /soloflow:quick "<bug description>"        — fast path for bugfixes
  /soloflow:status                           — check current state
```

Use "initialized" / "created" for fresh mode, "repaired" / "updated" for
repair mode.
