---
description: Walk through SoloFlow configuration and adjust settings interactively
allowed-tools: [Read, Write, Bash, AskUserQuestion]
model: haiku
---

# /soloflow:config

Interactive walkthrough for every SoloFlow setting. Reads `config/defaults.yaml`,
shows current overrides from `.soloflow/config.json`, lets the user adjust
categories interactively, and writes the result back — preserving unknown keys.

See [docs/CUSTOMIZATION.md#config-resolution](../docs/CUSTOMIZATION.md) for the
three-tier resolution recipe (`.soloflow/config.json` → `defaults.yaml` →
inline fallback) that every agent uses to read these values.

---

## Step 1: Check initialization

Run `test -d .soloflow` via Bash. If it does not exist, report:

```
SoloFlow not initialized. Run `/soloflow:init` first to scaffold .soloflow/.
```

and stop.

## Step 2: Load current config

- Run `test -e .soloflow/config.json` via Bash to check existence.
- If present: use the **Read** tool (not `cat`) to load `.soloflow/config.json` and parse into memory as `config`.
- If absent: start with `config = {}`.

Keep track of the **original** config state (e.g. `original = deep-copy of config`)
so the diff in Step 7 compares against disk, not against defaults.

Preserve every top-level key the command doesn't touch. Only the keys listed
in "Managed keys" below are edited or removed by this command.

## Step 3: Load defaults

Resolve `$CLAUDE_PLUGIN_ROOT` via a single Bash call (`echo "$CLAUDE_PLUGIN_ROOT"`),
then use the **Read** tool (not `cat`) on `<plugin_root>/config/defaults.yaml`
and parse into `defaults`. Used throughout to show the default value next to the
current value, and to compute the diff on exit.

If `$CLAUDE_PLUGIN_ROOT` is empty, fall back to the directory containing this
command file (two levels up from `commands/config.md`).

## Step 4: Category picker (top level)

Loop the two-round picker until the user selects **Done — exit**.

### Round 1 — Area

Use `AskUserQuestion`:
- **Question:** "Which area would you like to configure?"
- **Header:** "Area"
- **Options:**
  - `"Behavior"` — description: "Models, phases, tester mode"
  - `"Operations"` — description: "Limits, git, code review, verification, roadmap"
  - `"Reset to defaults"` — description: "Remove all overrides managed by this command"
  - `"Done — exit"` — description: "Review diff and write or discard"

### Round 2 — Category (conditional on Round 1)

**If Round 1 = Behavior:**
- **Question:** "Which behavior setting?"
- **Header:** "Behavior"
- **Options:** `"Models"`, `"Phases"`, `"Tester mode"`, `"Back"`

**If Round 1 = Operations:**
- **Question:** "Which operation setting?"
- **Header:** "Operations"
- **Options:** `"Limits"`, `"Git & run branches"`, `"Code review"`, `"Sprint code review"`, `"Verification"`, `"Roadmap"` *(the picker cap is 4 — split as `"Limits"`, `"Git"`, `"Verification"`, `"More..."` and the "More..." path re-asks with `"Code review"`, `"Sprint code review"`, `"Roadmap"`, `"Back"`)*

**If Round 1 = Reset to defaults:** see Step 6.

**If Round 1 = Done — exit:** break the loop and go to Step 7.

After each category sub-flow, return to **Round 1**.

## Step 5: Per-category sub-flows

All sub-flows share a helper pattern for every individual setting:

- Display the setting name, default, and current value (showing `(not set — uses default)` if the key is absent from `config`).
- Ask via `AskUserQuestion` with options tailored to the value's type.
- Write the user's choice into `config[path]`, creating nested objects as needed.
- Never delete a key the user explicitly chose — only remove on "Reset" or when the user picks "Use default" (which should remove the override so `defaults.yaml` wins).

### 5a. Models

Eighteen settings — one per agent: `models.verifier`, `models.executor`,
`models.idea_extractor`, `models.task_refiner`, `models.compounder`,
`models.researcher`, `models.code_reviewer`, `models.sprint_code_reviewer`,
`models.roadmap_researcher`, `models.roadmap_generator`,
`models.sprint_initiator`, `models.sprint_closer`, `models.sprint_verifier`,
`models.test_writer`, `models.integration_tester`, `models.codebase_pruner`,
`models.claudemd_pruner`, `models.claude_md_reviewer`.

For each agent:

- **Question:** `"Which model should <agent_name> use? (default: <default>, current: <current or 'default'>)"`
- **Header:** `"<agent_name>"`
- **Options:** `"opus"`, `"sonnet"`, `"haiku"`, `"Use default"`
  - Label whichever option matches the current value with `(current)`.
  - `"Use default"` removes `config.models.<name>` if set (falls back to `defaults.yaml`).

Bundle four agents per `AskUserQuestion` call (each call carries up to 4 questions).
Between rounds, offer an `"All done with models — back"` escape.

### 5b. Phases

Three booleans: `phases.clarify`, `phases.research`, `phases.roadmap_clarify`.

Single `AskUserQuestion` call with three questions (one per toggle):

- **Question:** `"Enable <phase_name>? (default: <default>, current: <current or 'default'>)"`
- **Header:** `"<phase_name>"`
- **Options:** `"Enable"`, `"Disable"`, `"Use default"` — label the matching current value with `(current)`.

### 5c. Tester mode

Single boolean: `tester`.

- **Question:** `"Enable tester mode (surfaces SoloFlow self-improvement feedback in /soloflow:compound)? (default: false, current: <current>)"`
- **Header:** `"Tester"`
- **Options:** `"Enable"`, `"Disable"`, `"Use default"` (`(current)` labeling).

### 5d. Limits

Five integers: `limits.executor_retry_max`, `limits.analysis_paralysis_threshold`,
`limits.checkpoint_interval`, `limits.max_sprint_tasks`, `limits.context_limit_respawn_max`.

For each:

- **Question:** `"<limit_name> (default: <default>, current: <current or 'default'>)"`
- **Header:** Short form of the limit name (≤12 chars).
- **Options:** `"Keep current"`, `"Reset to default"`, `"Enter custom value"`

If the user picks `"Enter custom value"`: the AskUserQuestion `"Other"` free-form response captures the integer. Validate it is a positive integer (`>= 1` for `max_sprint_tasks`, `>= 0` for the rest). If invalid, re-ask for that single limit. If valid, store.

### 5e. Git & run branches

Three settings:

**`git.branch_per_run`:**
- **Question:** `"Should /soloflow:sprint run each invocation on a dedicated branch? (default: prompt, current: <current>)"`
- **Header:** `"Branch per run"`
- **Options:** `"Ask me each run (prompt)"`, `"Always create a run branch"`, `"Never — run on current branch"`, `"Use default"` (`(current)` labeling).

**`git.branch_name_format`:**
- **Question:** `"Run branch name format (default: soloflow/run-{timestamp}-{sprint_id}, current: <current>)"`
- **Header:** `"Branch format"`
- **Options:** `"Keep current"`, `"Reset to default"`, `"Enter custom format"`

On custom: capture free-form, warn (but still accept) if the result contains neither `{timestamp}` nor `{sprint_id}` — two identically-named branches on consecutive runs would collide.

**`git.merge_strategy`:**
- **Question:** `"Merge strategy for run branch merge-back (default: --no-ff, current: <current>)"`
- **Header:** `"Merge flag"`
- **Options:** `"--no-ff (recommended)"`, `"--ff"`, `"--squash"`, `"Enter custom flag"`

On `"Enter custom flag"`: capture free-form; pass through as-is.

### 5f. Code review

Two settings (per-task reviewer inside the executor loop):

- `code_review.enabled` — boolean (Enable / Disable / Use default)
- `code_review.review_retry_max` — integer (Keep / Reset / Custom)

Use the same question patterns as 5b and 5d.

### 5f.5. Sprint code review

One setting (end-of-sprint aggregate reviewer; independent of 5f):

- `sprint_code_review.enabled` — boolean (Enable / Disable / Use default)

Use the same boolean question pattern as 5b. Note in the question text that
this reviewer runs once per sprint against the aggregate PR diff and that its
findings go to end-of-sprint human review, never back to execution.

### 5g. Verification

Eight settings. Split across multiple `AskUserQuestion` calls.

- `verification.run_tests` — boolean
- `verification.run_typecheck` — boolean
- `verification.run_linter` — boolean
- `verification.visual_mobile` — boolean (visual flow below)
- `verification.visual_web` — boolean (visual flow below)
- `verification.visual_mobile_app_id` — string or null (bundle ID for ad-hoc Maestro flows; auto-detected when null)
- `verification.visual_screenshot_budget` — integer ≥ 1
- `verification.visual_prefer_hierarchy` — boolean
- `verification.visual_maestro_flow_dirs` — list of strings

**Visual verification flow:** when the user is toggling `visual_mobile` or
`visual_web` from `false` → `true`, reuse the dependency-check and (for web)
MCP registration procedure documented in `commands/init.md` (Step 4
"Dependency check", "Simulator sanity check", "App bundle ID", and
"MCP server registration (Playwright only)" subsections). Follow that
procedure rather than duplicating it. Maestro (mobile) does not use an MCP
server since 0.9.3 — only the CLI is required.

**`visual_maestro_flow_dirs`:** show the current list, offer:
- `"Keep current"`
- `"Reset to default"` → `["maestro/", ".maestro/", "test/maestro/"]`
- `"Edit"` — prompt for a comma-separated list; split, trim, filter empty, store as array.

### 5h. Roadmap

Two settings:

**`roadmap.research_dimensions`:**
- **Question:** `"Which research dimensions should /soloflow:roadmap run in parallel? (default: all 4; current: <current>)"`
- **Header:** `"Dimensions"`
- **multiSelect: true**
- **Options:** `"ecosystem"`, `"user-needs"`, `"architecture"`, `"risks"` — label options present in the current list with `(current)`.

Store the selected list. If the user selects zero, warn and re-ask — zero
dimensions makes roadmap generation trivially wrong.

**`roadmap.default_output`:**
- **Question:** `"Default materialization when roadmap is approved? (default: ideas, current: <current>)"`
- **Header:** `"Output"`
- **Options:** `"ideas"`, `"plans"`, `"Use default"` (`(current)` labeling).

## Step 6: Reset to defaults

Confirm with `AskUserQuestion`:
- **Question:** `"Remove every override managed by /soloflow:config from .soloflow/config.json? Unknown keys you added manually will be preserved."`
- **Header:** `"Reset"`
- **Options:** `"Yes, reset"`, `"Cancel"`

On confirm: delete every "Managed key" listed below from `config`. Preserve
every other top-level key. Then return to the top-level picker (Step 4).

## Step 7: Diff + confirm + write

At exit ("Done — exit"):

1. Compute the diff between `config` (in-memory) and `original` (loaded in Step 2).
   - For each added key: emit `+ <path>: <new_value>`.
   - For each removed key: emit `- <path>: <old_value>`.
   - For each changed key: emit both lines.
2. If the diff is empty, print:
   ```
   No changes — .soloflow/config.json left as-is.
   ```
   and stop.
3. Otherwise, print the diff block (one line per key, sorted by path) inside a fenced block, then ask:
   - **Question:** `"Write these changes to .soloflow/config.json?"`
   - **Header:** `"Write"`
   - **Options:** `"Write"`, `"Discard"`
4. On `"Discard"`: print `Discarded — no changes written.` and stop.
5. On `"Write"`:
   - `JSON.stringify(config, null, 2)` + trailing newline.
   - Use `Write` tool on `.soloflow/config.json`.
   - Print `✓ Wrote .soloflow/config.json`.

## Step 8: Optional commit

If a write occurred in Step 7:

1. Run `git rev-parse --is-inside-work-tree` via Bash.
2. If inside a git repo AND `.soloflow/config.json` is not gitignored
   (`git check-ignore -q .soloflow/config.json` returns non-zero):
   - `git add .soloflow/config.json`
   - If `git diff --cached --quiet` reports no staged changes, skip.
   - Otherwise `git commit -m "chore: update soloflow config"`.
3. Do not push. Do not amend. (See global CLAUDE.md: commits stay local until
   the user asks.)

If not in a git repo or the file is gitignored, skip silently.

## Managed keys

The command edits only these paths in `.soloflow/config.json`:

```
models.verifier
models.executor
models.idea_extractor
models.task_refiner
models.compounder
models.researcher
models.code_reviewer
models.sprint_code_reviewer
models.roadmap_researcher
models.roadmap_generator
models.sprint_initiator
models.sprint_closer
models.sprint_verifier
models.test_writer
models.integration_tester
models.codebase_pruner
models.claudemd_pruner
models.claude_md_reviewer
phases.clarify
phases.research
phases.roadmap_clarify
tester
limits.executor_retry_max
limits.analysis_paralysis_threshold
limits.checkpoint_interval
limits.max_sprint_tasks
limits.context_limit_respawn_max
code_review.enabled
code_review.review_retry_max
sprint_code_review.enabled
verification.run_tests
verification.run_typecheck
verification.run_linter
verification.visual_mobile
verification.visual_web
verification.visual_mobile_app_id
verification.visual_screenshot_budget
verification.visual_prefer_hierarchy
verification.visual_maestro_flow_dirs
git.branch_per_run
git.branch_name_format
git.merge_strategy
roadmap.research_dimensions
roadmap.default_output
```

`paths.*` keys are not surfaced — they're referenced as literals across the
codebase and aren't runtime-overridable.
