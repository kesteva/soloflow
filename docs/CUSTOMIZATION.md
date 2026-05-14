# Customization

## TL;DR

Run `/soloflow:config` to walk through every SoloFlow setting and adjust it interactively. The command reads `config/defaults.yaml`, shows your current overrides, and writes changes to `.soloflow/config.json` — no source edits required.

For reference, `config/defaults.yaml` is the authoritative list of every configurable value and its default. Every setting in that file is runtime-overridable via `.soloflow/config.json`.

## Config resolution

Every agent, command, hook, and skill that consults a configuration value follows the same three-tier resolution order. Anywhere this doc (or an agent) says "read config key `<path>`", it means this recipe:

<a id="config-resolution"></a>

1. **Project override** — if `.soloflow/config.json` exists and has the key at `<path>`, use that value.
2. **Plugin default** — else if `$CLAUDE_PLUGIN_ROOT/config/defaults.yaml` has the key, use that value.
3. **Inline fallback** — else use the fallback stated at the callsite (usually matches `defaults.yaml`, but acts as a safety net if that file is missing).

`.soloflow/config.json` is shallow-JSON with the same shape as `defaults.yaml`. Missing keys are fine — the next tier fills them in. Unknown keys are preserved through all writes, so it's safe to hand-add values; just know that nothing reads them until they're documented in `defaults.yaml`.

### Example `.soloflow/config.json`

```json
{
  "verification": {
    "visual_mobile": true,
    "visual_web": false,
    "visual_screenshot_budget": 5
  },
  "git": {
    "branch_per_run": "always"
  },
  "models": {
    "executor": "opus"
  },
  "limits": {
    "executor_retry_max": 5
  }
}
```

## Setting reference

All settings below live in `config/defaults.yaml` and are runtime-overridable. `/soloflow:config` walks each category interactively.

### Models

| Setting | Default | Consumer |
|---|---|---|
| `models.verifier` | `opus` | `agents/shadow-verifier.md` |
| `models.executor` | `sonnet` | `agents/executor.md` |
| `models.idea_extractor` | `sonnet` | `agents/idea-extractor.md` |
| `models.task_decomposer` | `sonnet` | `agents/task-decomposer.md` |
| `models.task_refiner` | `opus` | `agents/task-refiner.md` |
| `models.bug_investigator` | `opus` | `agents/bug-investigator.md` |
| `models.compounder` | `sonnet` | `agents/compounder.md` |
| `models.researcher` | `sonnet` | `agents/shadow-researcher.md` |
| `models.code_reviewer` | `opus` | `agents/code-reviewer.md` |
| `models.sprint_code_reviewer` | `opus` | `agents/sprint-code-reviewer.md` |
| `models.roadmap_researcher` | `sonnet` | `agents/shadow-roadmap-researcher.md` |
| `models.roadmap_generator` | `opus` | `agents/roadmap-generator.md` |
| `models.sprint_initiator` | `sonnet` | `agents/sprint-initiator.md` |
| `models.sprint_closer` | `sonnet` | `agents/sprint-closer.md` |
| `models.sprint_verifier` | `opus` | `agents/shadow-sprint-verifier.md` |
| `models.test_writer` | `sonnet` | `agents/test-writer.md` |
| `models.integration_tester` | `sonnet` | `agents/integration-tester.md` |
| `models.codebase_pruner` | `opus` | `agents/codebase-pruner.md` |
| `models.claudemd_pruner` | `opus` | `agents/claudemd-pruner.md` |
| `models.claude_md_reviewer` | `opus` | `agents/claude-md-reviewer.md` |
| `models.compound_skeptic` | `opus` | `agents/compound-skeptic.md` |

Valid values: `opus`, `sonnet`, `haiku`. Callsites that spawn these agents via the `Agent` tool resolve `models.<name>` and pass it as the `model` param, overriding the agent's frontmatter.

### Phases

| Setting | Default | Description |
|---|---|---|
| `phases.clarify` | `true` | Conversational clarification before idea extraction |
| `phases.research` | `true` | External research after idea approval |
| `phases.roadmap_clarify` | `true` | Deep clarification before roadmap generation |

### Limits

| Setting | Default | Description |
|---|---|---|
| `limits.executor_retry_max` | 3 | Max executor→verifier loops before marking a task stuck |
| `limits.analysis_paralysis_threshold` | 5 | Consecutive read-only tool calls before the executor is forced to write |
| `limits.checkpoint_interval` | 3 | Tasks between progress checkpoints |
| `limits.max_sprint_tasks` | 10 | Maximum tasks in a single execution sprint |
| `limits.context_limit_respawn_max` | 3 | Max context-limit respawns per agent per task |
| `limits.max_parallel_tasks` | 3 | Max task pipelines executed concurrently per batch when `files_owned` doesn't overlap. `1` disables parallel mode (strict serial). See "Parallel task execution" below. |

### Parallelism

| Setting | Default | Description |
|---|---|---|
| `parallelism.task_refiner_parallel` | `true` | When an IDEA has ≥2 tasks, `/soloflow:planner` first runs `task-decomposer` to fix the task DAG, then fans out N `task-refiner` detailers in parallel (one per slot). Set `false` to keep the legacy single-call whole-IDEA flow. Affects `/soloflow:planner`, `/soloflow:braindump` multi-IDEA refinement, and `/soloflow:review-queue` Step 7c. |

### Code review

| Setting | Default | Description |
|---|---|---|
| `code_review.enabled` | `true` | Spawn a code-reviewer subagent after executor+verifier pass |
| `code_review.review_retry_max` | 1 | Separate retry budget for code-review fixes |

These settings control the **per-task** reviewer that runs inside the executor loop and can send the executor back with `IMPROVEMENTS_NEEDED`. The reviewer performs quality/reuse and security assessment inline against the changed files — there are no separate sub-toggles for the two axes.

### Sprint code review

| Setting | Default | Description |
|---|---|---|
| `sprint_code_review.enabled` | `true` | Spawn the end-of-sprint aggregate reviewer after sprint-verifier, before close |

The sprint-level reviewer runs **once per sprint** against `base_sha..HEAD`, specifically hunting cross-task patterns (duplicated utilities, inconsistent patterns, redundant helpers). Findings **never trigger re-execution** — they are appended directly to the active sprint's findings file (`.soloflow/active/findings/{sprint.id}-findings.md`) and consumed by the next `/soloflow:compound` run (which buckets them into clean-ups, backlog tasks, or CLAUDE.md improvements with compound-skeptic as a second pass). Sprint close prints a single status line ("Code review: N findings queued for next /soloflow:compound") rather than prompting the user to triage each finding inline.

`sprint_code_review.enabled` resolves independently from `code_review.enabled` — you can disable the per-task loop and keep the sprint-level safety net, or vice versa.

### Compound

Compound is Phase 6 — the end-of-sprint learning pass. Findings files are per-sprint (always), and multiple sprints can wait for compound simultaneously (compound backlog). Drain in bulk with `/soloflow:compound --all`, pick a specific `SPRINT-NNN`, or use the multi-select picker (no argument) to batch any subset of pending sprints.

**Batching.** When `--all` or the multi-select picker resolves to two or more sprints, compound runs ONCE over the merged batch: one compounder invocation triages inputs across every sprint (enabling cross-sprint dedup — e.g., the same CLAUDE.md gap surfaced by three sprints becomes one item with `Source-Sprint: SPRINT-001, SPRINT-002, SPRINT-003`), one merged proposal is written to `active/compound/SPRINT-{MIN}-{MAX}-proposal.md`, one reviewer / skeptic / bucket review flow runs, and approved items are applied with per-item commits whose scope comes from each item's Source-Sprint (multi-source dedup items scope to the earliest contributing sprint with an `Also surfaced by:` body line). Each sprint's findings file still archives individually to `archive/findings/SPRINT-NNN-findings.md`. Single-sprint runs (explicit `SPRINT-NNN`, `--oldest`, `--all` with one pending, or the picker picking one) keep today's format (`SPRINT-NNN-proposal.md`, no span prefix on bucket rows). Non-contiguous subsets are supported — the frontmatter `sprints:` array is the canonical membership truth, the span filename is a label.

| Setting | Default | Description |
|---|---|---|
| `compound.skeptic.enabled` | `true` | Spawn `compound-skeptic` in Step 2.6 after the proposal is written. Emits per-item IMPLEMENT / DONT_IMPLEMENT verdicts and enables the "Accept skeptic's recommendations" option in Step 3. |
| `compound.skeptic.auto_accept_verdicts` | `false` | When `true` AND `skeptic.enabled: true`, Step 3 skips the per-bucket `AskUserQuestion` **for buckets A, B, and C only**. Each affected bucket is auto-resolved using the same semantics as "Accept skeptic's recommendations" — every `IMPLEMENT` verdict applies, every `DONT_IMPLEMENT` is rejected. **Bucket D (SoloFlow self-improvement feedback, tester mode) is always reviewed by the user** regardless of this flag — auto-archiving feedback meant for a maintainer would defeat its purpose. Note: when this flag is on, `compound.claude_md_reviewer.pre_review_feedback_rounds` has no effect (the Bucket C "Give feedback" loop is unreachable). |
| `compound.claude_md_reviewer.enabled` | `true` | Spawn `claude-md-reviewer` in Step 2.5 against **all** C-items before the user sees options. Tightens or drops items, splits mixed rule+pattern proposals into a CLAUDE.md pointer + CODE-PATTERNS.md entry. |
| `compound.claude_md_reviewer.pre_review_feedback_rounds` | `2` | Cap on how many times "Give feedback" on Bucket C can re-run compounder + claude-md-reviewer before the last reviewer output is used as final. |
| `compound.pending_sprints.picker_threshold` | `2` | When `/soloflow:compound` is invoked with no argument, prompt the sprint picker if ≥ this many sprints are pending; fewer → use the oldest silently. |

Bucket C pre-review, the skeptic pass, and the picker are all independent — disabling one does not affect the others. The "Accept skeptic's recommendations" option only appears in Step 3 when the skeptic ran AND the bucket has at least one `DONT_IMPLEMENT` verdict (otherwise it's redundant with Approve all).

Findings are stored at `.soloflow/active/findings/SPRINT-NNN-findings.md` — one file per sprint, created by `sprint-initiator` at sprint start. After a sprint is compounded, its findings file is archived to `.soloflow/archive/findings/` individually (even when a merged batch compounded it alongside other sprints). Sprint close does NOT archive findings — they stay in `active/findings/` until `/soloflow:compound` runs against the sprint. Compound proposals are drafted at `.soloflow/active/compound/{span_label}-proposal.md` (single-sprint → `SPRINT-NNN-proposal.md`; merged batch → `SPRINT-{MIN}-{MAX}-proposal.md`) and archived after the user reviews them.

### Verification

| Setting | Default | Description |
|---|---|---|
| `verification.run_tests` | `true` | Test suite as Level-1 quality gate |
| `verification.run_typecheck` | `true` | Type checker as Level-1 quality gate |
| `verification.run_linter` | `true` | Auto-lint after Write/Edit |
| `verification.visual_mobile` | `false` | Enable Maestro CLI visual verification (mobile) |
| `verification.visual_web` | `false` | Enable Playwright MCP visual verification (web) |
| `verification.visual_macos` | `false` | Enable Peekaboo visual verification (native macOS) |
| `verification.visual_prefer_playwright` | `false` | When `true` and the project is Chromium-driveable (Electron, Tauri, Expo Web, Capacitor), prefer Playwright over Maestro/Peekaboo for UI verification. Expo and Capacitor still fall back to Maestro when a task touches `*.ios.*` / `*.android.*` / `*.native.*` or native-only modules. See [VISUAL-VERIFICATION-SETUP.md → Playwright preference](VISUAL-VERIFICATION-SETUP.md#playwright-preference) |
| `verification.visual_electron_main` | `null` | Explicit Electron main entry path for the Playwright `_electron.launch` runner. When `null`, the probe autodetects from `package.json#main`, then `out/main.js`, `dist/main.js`, `electron/main.js` |
| `verification.visual_mobile_app_id` | `null` | Bundle ID for ad-hoc Maestro flows (auto-detected from existing flows when null) |
| `verification.visual_maestro_flow_dirs` | `["maestro/", ".maestro/", "test/maestro/"]` | Dirs searched for Maestro flows |
| `verification.visual_screenshot_budget` | 3 | Max screenshots per verification run |
| `verification.visual_prefer_hierarchy` | `true` | Prefer `maestro hierarchy` (~200–600 tokens plain text) over screenshot capture (~1600 tokens) |
| `verification.visual_auth_fixture` | `null` | Path to a Maestro flow run once per verifier session to authenticate the simulator/emulator. See [VISUAL-VERIFICATION-SETUP.md → Authenticating the simulator](VISUAL-VERIFICATION-SETUP.md#authenticating-the-simulator) |
| `verification.dev_server.enabled` | `false` | Opt in to sprint-managed dev server (Metro / Vite / etc.) |
| `verification.dev_server.name` | `dev-server` | Display name in prompts |
| `verification.dev_server.probe_url` | `http://localhost:8081/status` | URL probed at sprint start + before visual_mobile |
| `verification.dev_server.probe_match` | `packager-status:running` | Substring required in probe response body (empty = any 200 OK) |
| `verification.dev_server.probe_port` | `8081` | Port killed by `lsof -ti :{port}` on `restart` |
| `verification.dev_server.start_command` | `npx react-native start` | Command run in a background shell on `start` / `restart` |
| `verification.dev_server.startup_timeout_seconds` | `30` | Max wait for `probe_url` to respond after start |

See [VISUAL-VERIFICATION-SETUP.md](VISUAL-VERIFICATION-SETUP.md) for dependency + MCP setup.

#### `verification.dev_server` — sprint-managed dev server

When enabled, `/soloflow:sprint` probes `probe_url` at sprint start (sprint-initiator Phase 1) and offers to start it (offline) or kill+restart it (running externally) under sprint ownership. The dev server runs in a Claude Code background shell; subagents read its output via the harness-assigned path recorded in `sprint.json` under `dev_server.output_path`.

The `visual-verify` skill also probes the same URL before any Maestro setup. On offline, it emits `visual_mobile: skipped_metro_offline` and stops — saving the full Maestro path-selection / simulator boot / screenshot chain when the bundler isn't running.

Lifecycle: started by `/soloflow:sprint` Step 2.5; stopped by `TaskStop` after `sprint-closer` finalize (Step 4.6). The transient `dev_server` block in `sprint.json` is not committed — it's session-state.

Defaults target Metro. For Vite or other dev servers, override via `.soloflow/config.json`:

```json
{
  "verification": {
    "dev_server": {
      "enabled": true,
      "name": "Vite",
      "probe_url": "http://localhost:5173/",
      "probe_match": "",
      "probe_port": 5173,
      "start_command": "npm run dev"
    }
  }
}
```

### Git

| Setting | Default | Description |
|---|---|---|
| `git.branch_per_run` | `prompt` | `/soloflow:sprint` runs on a dedicated branch. Values: `always`, `never`, `prompt` |
| `git.branch_name_format` | `soloflow/run-{timestamp}-{sprint_id}` | Run branch name format string |
| `git.merge_strategy` | `--no-ff` | Flag passed to `git merge` when merging the run branch back |

When `git.branch_per_run` is `prompt`, `/soloflow:sprint` asks at the start of each run; picking "remember this choice" writes `always` or `never` to `.soloflow/config.json` for you.

**How run branches work.** When enabled, `/soloflow:sprint` creates a dedicated branch per invocation (default name pattern `soloflow/run-{timestamp}-{sprint_id}`), executor commits accumulate on it, and the branch is merged back (`--no-ff` by default) after human review. `sprint.json` carries a `run` object (`branch`, `base_branch`, `base_sha`, `created_at`) so resume detects the branch across sessions.

### Roadmap

| Setting | Default | Description |
|---|---|---|
| `roadmap.research_dimensions` | `["ecosystem", "user-needs", "architecture", "risks"]` | Which dimensions `/soloflow:roadmap` researches in parallel |
| `roadmap.default_output` | `ideas` | Default materialization for approved roadmaps. Values: `ideas`, `plans` |

### Tester mode

| Setting | Default | Description |
|---|---|---|
| `tester` | `false` | Enable SoloFlow self-improvement feedback bucket in `/soloflow:compound` |

### Paths (informational — not user-editable)

`paths.*` keys in `defaults.yaml` are referenced as hardcoded literals throughout the codebase. They exist for documentation and are **not** overridable via `.soloflow/config.json` — `/soloflow:config` does not surface them.

## Parallel task execution

When `/soloflow:sprint` and `/soloflow:mad-max` run, Step 3 picks a **batch** of up to `limits.max_parallel_tasks` ready tasks whose `files_owned` sets do not overlap and runs each phase of the per-task loop (executor → verifier → code-reviewer → test-writer) as one parallel Agent call across every task in the batch.

Each task gets a dedicated short-lived git worktree at `.soloflow/worktrees/TASK-NNN/` on branch `{run-branch}-TASK-NNN`. The executor and downstream agents operate inside that worktree (instructed via a `WORKTREE_ROOT:` prompt prefix), so each task commits only to its own branch — no git-index races between siblings.

When a task's full pipeline finishes, the orchestrator fast-forward-merges its branch into the run branch from the main worktree and then removes the worktree. If the run branch has advanced (because a sibling merged first), a non-ff merge is used instead — safe because the `files_owned` gate guarantees disjoint file sets. A merge conflict (which would indicate a `files_owned` mis-declaration) preserves the worktree on disk for human inspection and marks the task as `human_needed`.

**Kill switch.** Set `limits.max_parallel_tasks: 1` in `.soloflow/config.json` to disable parallel mode — every batch becomes a single-task pipeline executed directly on the run branch with no worktree overhead. This reproduces the pre-parallel serial behavior exactly.

Scope:
- Applies to `/soloflow:sprint` and `/soloflow:mad-max`.
- Does **not** apply to `/soloflow:quick` (single-task path by construction).
- Tasks with empty `files_owned` always run solo (cannot be proven safe to pair).

## Adding Maestro flows

The verifier discovers and runs Maestro YAML flows from the directories listed in `verification.visual_maestro_flow_dirs`. To add flows:

1. Create a `maestro/` directory in your project root.
2. Write YAML flows following the [Maestro documentation](https://maestro.mobile.dev).
3. The verifier discovers them automatically during visual verification.
