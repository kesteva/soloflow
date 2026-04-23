# Changelog

All notable changes to SoloFlow are documented in this file.

## [Unreleased]

### Added
- **`scripts/init/shadow-agents.js`** — reusable check/sync utility for the four MCP-dependent agent shadows (`verifier`, `sprint-verifier`, `researcher`, `roadmap-researcher`). `--mode check` emits JSON with `drifted`, `needs_update`, and per-shadow status (`current` / `stale` / `untracked` / `not_installed`). `--mode sync [--set all|visual|research] [--agent name]` copies from `$CLAUDE_PLUGIN_ROOT/agents/` and records the synced plugin version in `.claude/agents/.soloflow-shadows.json`. Sidecar is the source of truth for drift detection — no need to re-read every agent file.
- **`/soloflow:sync-agents`** slash command — manual wrapper around the utility. Prints a status table, syncs any drifted/missing shadows, and reminds the user to restart Claude Code so the new shadows are picked up at session start. Use after a plugin update, or whenever `/soloflow:sprint`'s preflight warns about drift.
- **`commands/sprint.md` Step 0.45** — non-blocking drift check at sprint start. If the plugin version is newer than the sidecar's recorded version for any installed shadow, `AskUserQuestion` offers `Update now` / `Skip` / `Abort`. "Update now" runs the sync utility inline; the user is reminded that shadow changes take effect on the NEXT session, since subagents load at session start.

### Changed
- **`/soloflow:init`'s visual verification and research agent callouts** now delegate to `scripts/init/shadow-agents.js --mode sync --set {visual|research}` instead of raw `cp` commands, so the sidecar is populated at install time. Enables the sprint preflight drift check to detect updates.

### Fixed
- **Plugin-scoped subagents don't actually honor `mcpServers:` frontmatter.** 0.8.6's fix for `skipped_unable` was incorrect — the declaration was silently ignored on plugin subagents. Every `verifier` / `sprint-verifier` spawn after 0.8.6 still lost its Maestro/Playwright tool bindings, and every visual check degraded to `skipped_unable` despite the frontmatter claim. `/soloflow:init` now shadow-installs the MCP-dependent agents from `$CLAUDE_PLUGIN_ROOT/agents/` into `.claude/agents/` as two explicit, feature-tied callouts inside Step 4:
    - **Visual verification agents** (`verifier.md`, `sprint-verifier.md`) — runs inside the visual verification wizard, after MCP server registration. Gated on `visual_mobile || visual_web`. Prints an explicit "why this step exists" callout so the user understands the mechanism.
    - **Research agents** (`researcher.md`, `roadmap-researcher.md`) — runs inside the context7 section of "Optional plugin probes". Unconditional on context7 presence so shadows are ready if the user installs context7 later.

  Project-local agents honor `mcpServers:`, and Claude Code's documented scope-precedence (project-local wins over plugin) means the shadows replace the plugin versions whenever the orchestrator spawns `verifier` etc. Idempotent — re-syncs on every init so plugin updates propagate. Users upgrading from 0.8.6–0.8.10 should re-run `/soloflow:init` and then restart Claude Code so freshly-written shadow agents are picked up (subagents load at session start).

## [0.8.10] - 2026-04-23

### Fixed
- **Sprint-initiator now surfaces unregistered Maestro/Playwright MCPs at preflight** instead of letting every verifier call silently degrade to `skipped_unable`. `scripts/sprint/probe-infra.js` previously inferred `maestro`/`playwright` requirements from plan keywords + integration-test targets only, which is narrower than the verifier's Level 2 decision gate (any UI file or UI-visible AC). When `verification.visual_mobile=true` or `visual_web=true`, the probe now adds the corresponding MCP to the required set regardless of plan content; missing entries carry a `(required by verification.visual_*=true)` reason suffix so the orchestrator can surface the registration gap before the sprint starts.

## [0.8.9] - 2026-04-22

### Changed
- **`agents/code-reviewer.md` and `agents/sprint-code-reviewer.md` perform quality/reuse and security assessment inline** instead of invoking the `/simplify` and `/security-review` Skills. In practice the skill outputs were arriving too late to feed the reviewer's synthesis step, so the reviewer was redoing the same checks before emitting its verdict. Verdict enum and findings surface are unchanged; only the internal process is different.

### Removed
- **Four config keys** — `code_review.run_simplify`, `code_review.run_security_review`, `sprint_code_review.run_simplify`, `sprint_code_review.run_security_review`. Stripped from `config/defaults.yaml`, `docs/CUSTOMIZATION.md`, `docs/ARCHITECTURE.md`, and the `/soloflow:config` walk (`commands/config.md`). If a project's `.soloflow/config.json` still lists these keys they are silently ignored — `scripts/config/resolve.js` does no schema validation.

## [0.8.8] - 2026-04-22

### Added
- **New script library under `scripts/`** — 13 extracted helpers that replace deterministic prose previously executed by the LLM inside agents and orchestrator commands:
  - `scripts/config/resolve.js` — 3-tier config/limits resolver (`.soloflow/config.json` → `defaults.yaml` → fallback).
  - `scripts/state/next-ids.js` — sprint / task / finding ID allocation.
  - `scripts/state/findings.js` + `lib/findings.js` — per-sprint findings file library (ensure-exists / append / set-status / reconcile / recompute).
  - `scripts/state/review-queue.js` + `lib/review-queue.js` — human-review-queue library (gather / append / remove / override / recompute).
  - `scripts/state/commit-atomic.js` — generalized "stage explicit paths, never `-A`, skip-if-not-repo" wrapper.
  - `scripts/state/cruft-detect.js` — read-only detection for `/soloflow:review-queue` step 1a (6 scenarios).
  - `scripts/sprint/parse-flags.js` — `--quick` / `--no-code-review` / `--no-verification` parser with config fold-in.
  - `scripts/sprint/ready-tasks.js` — topological sort of sprint.json `depends_on` graph.
  - `scripts/sprint/close-gather.js` — replaces `sprint-closer` Phase 1 entirely (stats, reconciliation, compound-proposal span math).
  - `scripts/sprint/probe-infra.js` — keyword-scan + shell probes for maestro/playwright/docker + per-task prerequisites.
  - `scripts/compound/batch-select.js` — pending-sprint discovery + batch input assembly for `/soloflow:compound`.
  - `scripts/refiner/grep-preflight.js` — recursive grep helper for task-refiner step 5g.
  - `scripts/refiner/ac-parity.js` — AC ↔ files_owned / test_strategy parity check for task-refiner steps 5c/5e.
- **`scripts/__tests__/`** — 22 unit tests covering the new libraries and scripts (`node --test scripts/__tests__/*.test.js`).
- **`scripts/install.sh`** now bundles `scripts/` under `.claude/soloflow-install/scripts/` so script-install users get the new helpers.

### Changed
- **Agents rewired to call scripts instead of executing deterministic prose in-context.** `sprint-initiator`, `sprint-closer`, `executor`, `verifier`, and `task-refiner` each drop ~15-60 lines of JSON/YAML/git manipulation prose in favor of script invocations.
- **Orchestrator commands rewired to call scripts.** `commands/sprint.md`, `compound.md`, `review-queue.md`, `mad-max.md`, `quick.md`, `planner.md`, and `prune.md` replace their inline 3-tier config recipe, ID allocation, dependency-graph, findings-file, and queue-mutation prose with script calls.
- **`commands/sprint.md` step 3.7 retires the `sprint-closer` gather-phase agent spawn** entirely — it now calls `close-gather.js` directly and consumes the same JSON payload shape.

## [0.8.7] - 2026-04-22

### Added
- **`/soloflow:sprint` gains `--quick`, `--no-code-review`, `--no-verification` flags.** Lets users opt out of review/verification layers per-run without editing config. `--quick` is shorthand for `--no-code-review --no-verification`. Flags override resolved `code_review.enabled` / `sprint_code_review.enabled` config in-memory, and a new Step 0.4 parses them ahead of config resolution. When verification is skipped, done reports record `visual_mobile: skipped_user_preference` / `visual_web: skipped_user_preference`; the sprint-closer already tolerates a missing `sprint-verification.md`.
- **Task-refiner pre-flight grep for global-grep ACs.** `task-refiner` now runs a pre-flight grep pass before authoring plans, so acceptance criteria that reference repo-wide string matches surface before the plan lands.

### Changed
- **Compounder cross-checks done reports before triaging open findings.** `agents/compounder.md` pulls the sprint's done reports and reconciles them against the open-findings queue, preventing already-addressed findings from being re-surfaced for triage.
- **Sprint-closer reconciles stale-open findings from done reports.** On sprint close, findings whose referenced tasks have since landed as done are flipped from open to resolved automatically.
- **`/soloflow:config` switched to haiku + `Read` tool.** Previously shelled out via `cat`; now uses the `Read` tool on haiku for lower latency and cleaner transcripts.

### Fixed
- **Checkpoint reset at sprint close.** `sprint-closer` clears `.soloflow/checkpoint.md` on close so the next sprint's resume check doesn't flag the stale checkpoint and prompt an unnecessary resume/fresh decision.

## [0.8.6] - 2026-04-21

### Fixed
- **Visual-verification subagents can now reach Maestro / Playwright MCPs.** Added `mcpServers: [maestro, playwright]` frontmatter to `verifier` and `sprint-verifier`. Subagents don't inherit MCP tools from the parent session when `tools:` is set — the `mcpServers:` field is the official mechanism. Without this, Level 2 visual verification silently degraded to `skipped_unable` even when the user had both MCP servers registered and `verification.visual_{mobile,web}` enabled. Mirrors the `context7` wiring landed for researchers in 0.8.5.

## [0.8.5] - 2026-04-20

### Changed
- **SoloFlow is now framed as a personal workflow tool.** README and `docs/CONTRIBUTING.md` clarify that this is built for the maintainer's own shipping workflow. Issues and PRs are welcome, but changes only land if they help the maintainer's workflow. Forking is encouraged for divergent use cases.

### Added (since 0.8.3)
- **`/soloflow:compound` supports batched multi-sprint runs.** The command accepts a pending-sprint picker or `--all` drain, and the compounder reads/writes per-sprint paths. Compound-skeptic is span-aware and preserves Source-Sprint when reviewing bucket C items. Sprint-closer archives span-named compound drafts. Compound emits a scannable summary before bucket-by-bucket review.
- **`compound-skeptic` agent.** Second-pass skeptical reviewer for compound proposals — wired into `/soloflow:compound` to gate bucket acceptance. Learns about span proposals and Source-Sprint tracking.
- **`claude-md-reviewer` runs pre-user-presentation (Step 2.5)** and reviews all C-bucket items before the user decision, instead of after approval.
- **Per-sprint findings + compound drafts layout.** `init` and `session-start` support the new per-sprint paths; writer agents point at the per-sprint findings file; `sprint-initiator` creates it; `sprint-closer` handles per-sprint compound drafts while keeping findings active.
- **Sprint-level code review.** New `sprint-code-reviewer` agent runs at the end of a sprint; `/soloflow:review-queue` adds sprint-code-review triage; `sprint-closer` handles sprint-level code review; `sprint_code_review` config defaults and sub-flow in `/soloflow:config`.
- **Plan-authoring parity gates.** `acceptance_criteria` / `files_owned` and `test_strategy` / `files_owned` parity is enforced at plan-authoring time; per-task prerequisites gate at sprint initiation.
- **String-literal rename guardrail.** Repo-wide grep is required for string-literal rename sweeps.

### Changed (since 0.8.3)
- **MCP-unavailable escalates to human-review** and findings instead of silent skip.
- **`HUMAN_NEEDED` queue entries require `plan_ref`** for traceability.
- **Findings status sync** happens in-commit and verifier-side, so status stays consistent across agents.
- **Prose-only findings are blocked inside CLEAN code-review verdicts** to prevent hidden carve-outs.

## [0.8.3] - 2026-04-18

### Changed
- **`/soloflow:executor` renamed to `/soloflow:sprint`.** The command that runs Phase 3's sprint loop now matches what it actually does; the leaf executor agent keeps its existing name. No behavior change. All internal references, docs, and the setup-wizard question text are updated. Muscle-memory users will need to update their invocation; there is no alias.

## [0.8.2] - 2026-04-18

### Added
- **`/soloflow:config`** — interactive walkthrough for every SoloFlow setting. Shows defaults and current overrides, walks through models, phases, tester mode, limits, code review, verification, git, and roadmap categories, and writes changes to `.soloflow/config.json` with a confirm-at-exit diff. Preserves unknown keys, offers "Reset to defaults" for the managed key set, and optionally commits the file if it's tracked.
- **All settings in `config/defaults.yaml` are now runtime-overridable.** Previously only 5 keys (visual verify + git branching) were read from `.soloflow/config.json` at runtime; the rest were embedded in agent sources. Every agent/command now consults the config at runtime using the shared three-tier recipe (config.json → defaults.yaml → inline fallback) documented in `docs/CUSTOMIZATION.md#config-resolution`. Model choices override per-agent at `Agent` spawn time via the tool's `model` param.
- **Seven more agents added to the `models.*` schema** — `sprint_closer`, `sprint_verifier`, `test_writer`, `integration_tester`, `codebase_pruner`, `claudemd_pruner`, `claude_md_reviewer`. Any of them can now be retargeted (e.g., "run `test-writer` on `haiku`") via `/soloflow:config` without editing agent frontmatter.

### Changed
- **`docs/CUSTOMIZATION.md` rewrite.** Reframed as a complete reference for the 35+ runtime-overridable settings. Adds a canonical `## Config resolution` section with a stable anchor (`#config-resolution`) that every agent references, instead of duplicating the three-tier recipe prose.
- **`agents/code-reviewer.md`** gates `/simplify` on `code_review.run_simplify` and `/security-review` on `code_review.run_security_review`; the orchestrator honors `code_review.enabled` and `code_review.review_retry_max`.
- **`agents/verifier.md` and `skills/visual-verify/SKILL.md`** honor `verification.run_tests`, `verification.run_typecheck`, `verification.run_linter`, `verification.visual_screenshot_budget`, `verification.visual_prefer_hierarchy`, and `verification.visual_maestro_flow_dirs` instead of hardcoded values.
- **Limits (`executor_retry_max`, `checkpoint_interval`, `max_sprint_tasks`, `context_limit_respawn_max`, `analysis_paralysis_threshold`) resolve at runtime** in the orchestrator commands (`executor`, `mad-max`, `quick`) and in `agents/executor.md`. The per-command "Cap at 3 respawns" prose in `planner`, `roadmap`, and `compound` now references `limits.context_limit_respawn_max`.
- **`phases.research`** now gates whether `/soloflow:idea-extractor` even offers the "Approve + Research" option. When disabled project-wide, the research path is omitted from the picker.
- **`roadmap.default_output`** is surfaced in the materialization picker so the default option is labeled `(default)`; users can set the project default to `plans` and get one-keystroke approval for plan materialization.

## [0.8.1] - 2026-04-17

### Changed
- **Verifier auto-resolves AC-prescribed scope deviations.** `agents/verifier.md` Plan-Prescribed Scope Deviations section now resolves a `scope_deviation` finding on either (a) the plan text naming the file, or (b) the change being required by a broad AC such as "all suites must pass." Previously only (a) triggered auto-resolve, producing recurring open findings whenever enabling a feature broke an outside-of-`files_owned` test.
- **Sprint-verifier now emits per-platform outcomes.** `agents/sprint-verifier.md` splits its single Visual Verification status into `visual_mobile` and `visual_web` (same 5-value enum as the per-task verifier) and persists them to `.soloflow/active/sprint-verification.md`, archived at sprint close to `.soloflow/archive/sprint-verifications/SPRINT-NNN-verification.md`.

### Added
- **Done-report schema gains `executor_loops` and `code_review_rounds`.** `commands/executor.md` step f3 defines the canonical done-report frontmatter; orchestrators (`executor`, `mad-max`, `quick`) track both counters per task and write them into the report. Sprint-closer sums them into `total_executor_loops` / `total_code_review_rounds`; compounder uses them as evidence for D-bucket recommendations (e.g. "shared-helper integration tasks consistently need two code-review rounds").
- **Visual verification five-bucket classification.** Per-task verifier and sprint-verifier emit `pass | fail | not_applicable | skipped_user_preference | skipped_unable` for each platform, surfaced at sprint end by `/soloflow:executor` Step 5 and `/soloflow:mad-max` final report. Distinguishes healthy skips (user preference, N/A) from coverage gaps (unable to run).

## [0.8.0] - 2026-04-15

### Added
- **`/soloflow:mad-max`** — unattended backlog-drain command. Runs the full per-task quality loop (executor → verifier → code-reviewer → test-writer) against every ready task, plus the end-of-sprint regression check, with zero interactive prompts during the run. Hardcodes `create_branch: true` and `merge_choice: keep_open`; stuck / human-needed tasks are logged and skipped. Hard-stops only on conditions mad-max cannot safely bypass (active sprint, dirty worktree, blocking deferred items, red smoke baseline). Use this when you want to kick off a run and walk away.

## [0.5.2] - 2026-04-09

### Fixed
- **Plugin install actually works now.** Added `.claude-plugin/marketplace.json` so the repo declares itself as a Claude Code plugin marketplace. Previously `/plugin install soloflow` and `claude plugin install https://github.com/kesteva/soloflow` both failed with "not found in any configured marketplace" because neither command accepts a bare GitHub URL.
- **README install instructions corrected.** The real flow is two steps: `/plugin marketplace add kesteva/soloflow` then `/plugin install soloflow@soloflow`. Updates use `/plugin update soloflow@soloflow`.

## [0.5.1] - 2026-04-09

### Changed
- **`/soloflow:init` is now idempotent.** Re-running on an already-initialized project no longer exits early — it creates any missing directories or state files (handy when upgrading across a release that adds new state artifacts) and leaves existing files untouched. `scripts/init.sh` mirrors the same repair behavior for the shell fallback.
- **`/soloflow:init` now includes a setup wizard.** After scaffolding, it asks about visual verification (Q1 on/off → Q2 project type → dependency check with optional Maestro installer) and the branch strategy for `/soloflow:executor` runs, then writes `.soloflow/config.json`. Re-running surfaces current values as `(current)` so you can keep or change them.
- **Verifier visual toggles are now overrideable per-project.** `agents/verifier.md` resolves `verification.visual_mobile` / `verification.visual_web` via `.soloflow/config.json` → `config/defaults.yaml` → `false` fallback. The wizard's answers take effect immediately.

### Added
- Orphaned-file detection in `/soloflow:init`: surfaces pre-0.5.0 `.soloflow/counters.json` in the post-init report without deleting it.

## [0.5.0] - 2026-04-09

### Removed (BREAKING)
- **`counters.json`** — deleted. Parallel workers racing on a shared mutable counter caused merge conflicts without adding value. ID allocation (`IDEA-NNN`, `TASK-NNN`, `SPRINT-NNN`, `SOL-NNN`) is now derived from the filesystem: glob the artifact locations, take `max(numeric_suffix) + 1`. Writes use `noclobber` / `wx` semantics and retry on collision. See the "ID allocation" section in `CLAUDE.md` for the shared recipe.

### Changed
- `scripts/init.sh` and `/soloflow:init` no longer create `counters.json`.
- All phase commands (`idea-extractor`, `planner`, `executor`, `quick`, `compound`) compute next IDs by globbing instead of reading/writing a counter file.
- `commands/executor.md` now writes `sprint.id` into `sprint.json` directly (previously derived from the sprints counter).

### Migration from 0.4.x
Delete `.soloflow/counters.json` from your project — it's no longer read or written. Everything else keeps working; existing ID sequences are preserved because the filesystem already reflects the highest allocated ID.

## [0.4.0] - 2026-04-09

### Added
- **Findings queue** — `.soloflow/active/findings.md`. Executor, verifier, and code-reviewer append out-of-scope observations here instead of expanding scope or dropping them. Consumed and archived by the compounder.
- **Interactive four-bucket compounder** — `/soloflow:compound` now produces `COMPOUND-PROPOSAL.md` with (A) clean-ups applied inline, (B) backlog ideas queued as `IDEA-NNN.md`, (C) CLAUDE.md improvements applied directly, (D) reusable patterns archived as SOL files under `archive/solutions/SPRINT-NNN/`. The user approves per-bucket; the main agent applies approved items with atomic commits. Rejected items are preserved in `archive/compound/`.
- **Run branches for `/soloflow:executor`** — new `git.branch_per_run` config (`always` / `never` / `prompt`, default `prompt`) creates a dedicated branch per execution run, merged back with `--no-ff` after human review. Overrideable per-project via `.soloflow/config.json`. `sprint.json` gains a `run` object so resume detects the branch across sessions.

### Changed
- **Executor commit discipline** — `agents/executor.md` now treats atomic commits as mandatory, not advisory. Commits must be reported in the `COMPLETED` status report.
- **`config/defaults.yaml`** — gains a `git:` block. Most values remain non-runtime-read; `git.branch_per_run` IS runtime-read (exception documented in `docs/CUSTOMIZATION.md`).

## [0.3.0] - 2026-04-08

### Added
- `/soloflow:init` — new command that explicitly scaffolds `.soloflow/` in the current project. Required once per project before any other phase command will run.
- All seven phase commands (`idea-extractor`, `planner`, `executor`, `compound`, `quick`, `status`, `verify`) gate on `.soloflow/` existence and refuse to run if missing, pointing the user at `/soloflow:init`.

### Changed
- Replaced the 0.2.0 SessionStart auto-init with a user-visible prompt. When `.soloflow/` is missing, the hook tells the user to run `/soloflow:init` instead of silently creating files. `SOLOFLOW_AUTOINIT` env var removed.

## [0.2.0] - 2026-04-08

### Changed (BREAKING)
- All agent, command, hook, and skill files renamed to drop the `soloflow-` prefix. The `soloflow` plugin namespace is applied at invocation time instead.
- Slash commands moved from `/soloflow-<name>` to `/soloflow:<name>` (e.g. `/soloflow-planner` → `/soloflow:planner`). Existing projects must reinstall.
- `scripts/install.sh` rewritten as a copy-based installer (no more symlinks). Works on Windows without Developer Mode, survives source-clone relocation, supports per-project version pinning.

### Added
- `/plugin install soloflow` is now the primary install path. The repo ships as a valid Claude Code plugin with auto-discovery of agents/commands/hooks/skills.
- `scripts/update.sh` — manifest-diff updater for the script-install fallback. Copies new files, prunes removed ones, leaves `.soloflow/` untouched.
- `.claude/soloflow-install/manifest.json` and `VERSION` stamp track the installed file set for idempotent reinstall/update/uninstall.
- `docs/PLUGIN-MIGRATION-PLAN.md` documents the migration from symlink install to plugin distribution.

### Migration from 0.1.0
1. Uninstall the old scaffolding: `bash <path-to-soloflow>/scripts/uninstall.sh --scaffolding` (preserves `.soloflow/`).
2. Install the plugin: `/plugin install soloflow` (or re-run the new `scripts/install.sh` for the vendored path).
3. Update any scripts or docs referencing `/soloflow-<name>` to `/soloflow:<name>`.

## [0.1.0] - 2026-04-04

### Added
- Five-phase workflow: idea extraction, task refinement, execution sprint, human review, compound learning
- 7 agent definitions: executor, verifier, code-reviewer, idea-extractor, researcher, task-refiner, compounder
- 5 hooks: session-start, post-tool-use, task-completed, pre-compact, subagent-stop
- 7 commands: `/soloflow-idea-extractor`, `/soloflow-planner`, `/soloflow-executor`, `/soloflow-compound`, `/soloflow-quick`, `/soloflow-status`, `/soloflow-verify`
- Visual verification skill with Maestro MCP (mobile) and Playwright MCP (web)
- State management with active/archive split in `.soloflow/`
- Install script for per-project setup
- Default configuration in `config/defaults.yaml`
- Documentation: architecture, customization, contributing, visual verification setup
