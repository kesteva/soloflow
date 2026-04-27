# Changelog

All notable changes to SoloFlow are documented in this file.

## [Unreleased]

## [0.9.8] - 2026-04-24

### Added
- **`/soloflow:map-codebase`** — new one-shot command that surveys the project and creates missing `CLAUDE.md`, `ARCHITECTURE.md`, and `CODE-PATTERNS.md` (at root or under `docs/`). Idempotent and additive — never overwrites existing artifacts. Templates are deliberately lean so the user fills in what the survey can't infer.
- **`/soloflow:init`** now detects which of those three context docs are missing and offers to defer to `/soloflow:map-codebase`. The recommendation surfaces in the final report's Next steps block when the user opts in.

### Changed
- **`/soloflow:roadmap` Path B (Approve as plans) refines epics in parallel.** Per-epic `task-refiner` spawns previously ran sequentially with the task counter threaded through each iteration; now the orchestrator pre-allocates non-overlapping TASK ID ranges per epic (`STRIDE = 50`), snapshots the existing-epics list once, and dispatches all refiners in a single parallel batch. Outputs are processed sequentially after the batch returns; existing noclobber/`wx` writes handle rare cross-refiner ID collisions and same-slug new-epic creation (first-write-wins on `EPIC-{slug}.md`). Final TASK IDs may have gaps between epics — expected and harmless.

## [0.9.7] - 2026-04-24

### Changed
- **Mobile visual verification prefers Maestro MCP again; CLI is the fallback.** The 0.9.3 MCP→CLI swap is effectively reversed now that 0.9.6 fixed the `tools:` allowlist gap that had caused `mcp__maestro__*` bindings to silently drop. The verifier's new **Path Selection** step probes `mcp__maestro__list_devices` once per run; on success, it uses MCP (`run_flow_files`, `run_flow`, `inspect_view_hierarchy` — ~50-token CSV hierarchy, ~4–10× cheaper than CLI `maestro hierarchy`). On failure, it falls back to the CLI path (`maestro test`, `maestro hierarchy`, ephemeral-flow pattern) for the whole run. Paths are never mixed within a single run — both bind port 7001. The full CLI implementation built for 0.9.3 is retained as the fallback.
- **`shadow-verifier` / `shadow-sprint-verifier` frontmatter restored** to `mcpServers: [maestro, playwright]` and `tools:` now allowlists `mcp__maestro__*` alongside `mcp__playwright__*`. Run `/soloflow:sync-agents` after upgrade, then restart Claude Code so the new bindings take effect.
- **`/soloflow:init`** now offers Maestro MCP registration during visual setup (mirrors the existing Playwright prompt but with a "Skip (CLI fallback will be used)" option).
- **`scripts/sprint/probe-infra.js`** `probeCategory('maestro')` is a dual check again: either MCP registered OR CLI installed is sufficient at preflight. Shadow-agents cross-check now covers Maestro too, but only demotes when shadows are broken AND the CLI is unavailable — otherwise broken shadows silently degrade MCP mode to CLI mode with no warning.
- **Port-7001 guardrail restored** in agent prompts and the skill doc: never mix Maestro MCP and CLI calls within a single verification run — both bind port 7001. Path Selection picks one; stay on it.

### Migration
After upgrading the plugin: optionally register Maestro MCP with `claude mcp add --scope user maestro maestro mcp` (or let `/soloflow:init` walk you through it), then run `/soloflow:sync-agents` to sync the updated shadows into `.claude/agents/`. **Restart Claude Code** — subagents load their tool allowlists at session start, so freshly-synced shadows aren't picked up until the next session. Users who skip Maestro MCP registration keep working via the CLI fallback with zero config changes.

## [0.9.6] - 2026-04-24

### Added
- **`/soloflow:bugfix` mode** — new slash command for bug triage that routes through a read-only `bug-investigator` agent for root-cause analysis before handing off to the executor. `idea-extractor` now routes BUGFIX-typed ideas to `/bugfix` as the primary path. New `models.bug_investigator` config key (default: `opus`).
- **Serial vs parallel execution prompt at sprint start.** `/soloflow:sprint` asks the user up front whether to run the batch serially or in parallel; the choice is persisted as `execution_mode` on `sprint.json` and honored throughout the run. `/soloflow:mad-max` derives its `execution_mode` from `limits.max_parallel_tasks` (1 → serial, >1 → parallel) so mad-max runs reflect the user's configured concurrency without an extra prompt.
- **`VISUAL_VERIFY: skip` directive** in task plans is now honored by `shadow-verifier`, letting tasks opt out of visual verification when it doesn't apply (e.g., non-UI refactors, infra-only changes).

### Changed
- **`sprint-code-reviewer` writes findings directly to the sprint findings file.** The separate sprint-code-review accept/defer/dismiss triage step is gone — reviewer output lands in `SPRINT-NNN-findings.md` alongside executor/verifier findings and flows through the normal `/soloflow:review-queue` triage with everything else. Removes the `sprint_code_review` field from `close-gather` output and the dedicated triage prompts from `commands/sprint.md` and `commands/review-queue.md`.
- **`compound-skeptic` verdict criteria** now include an **impact bar** alongside confidence, making it explicit whether a proposal is worth implementing even if it's correct (e.g., high-confidence but low-impact items get downgraded).
- **Shadow agent templates moved out of `agents/`** into their own location so Claude Code doesn't surface them as first-class agents in the registry. Source-of-truth for `shadow-*.md` shadows is now separate from the regular agent definitions.

### Fixed
- **MCP tool access in shadow agent `tools:` allowlists.** `shadow-verifier` / `shadow-sprint-verifier` / `shadow-researcher` / `shadow-roadmap-researcher` now explicitly allowlist their MCP tool names in the `tools:` frontmatter field. Without the allowlist, Claude Code silently dropped the MCP bindings even when `mcpServers:` was declared, so shadow agents spawned without access to Playwright/Maestro MCP tools. `docs/ARCHITECTURE.md` now documents the `tools:` + `mcpServers:` dual requirement.

## [0.9.5] - 2026-04-24

### Added
- **Parallel task execution in `/soloflow:sprint` and `/soloflow:mad-max`.** Step 3 now picks a batch of up to `limits.max_parallel_tasks` (default 3) ready tasks whose `files_owned` sets don't overlap and runs each phase of the per-task loop (executor → verifier → code-reviewer → test-writer) as one parallel Agent call across every task in the batch. Each task runs in a dedicated short-lived git worktree at `.soloflow/worktrees/TASK-NNN/` on branch `{run-branch}-TASK-NNN`; after its pipeline completes, the orchestrator fast-forward-merges the task branch back into the run branch (with a non-ff fallback if a sibling merged first) and removes the worktree. Subagents honor a `WORKTREE_ROOT:` prompt prefix documented in each agent's new "Working directory" section.
- **`limits.max_parallel_tasks`** config key (default `3`, fallback `3`). Set to `1` to disable parallel mode and reproduce the prior strictly-serial behavior.
- **`scripts/sprint/build-batch.js`** — greedy-packs ready tasks into a conflict-free batch by `files_owned`, capped at the configured max.
- **`scripts/state/worktree-setup.js` / `worktree-merge.js`** — per-task worktree lifecycle helpers with ff/non-ff merge handling and conflict preservation (merge conflicts, which imply a `files_owned` mis-declaration, leave the worktree on disk and flag the task as `human_needed`).

### Changed
- `commands/mad-max.md` Step 3 now delegates to `commands/sprint.md` Step 3 instead of duplicating the per-task loop. Mad-max retains its no-prompt deltas and continue-on-terminal-status behavior.

## [0.9.4] - 2026-04-24

### Changed
- **Removed `frontend-design` skill references from SoloFlow agents and commands.** The skill is an external plugin and not part of the SoloFlow surface area. `task-refiner`, `executor`, `sprint-initiator`, and `/soloflow:init` no longer probe for or hint at it; consumers who want frontend-design should install and invoke it independently.

## [0.9.3] - 2026-04-23

### Changed
- **Mobile visual verification switched from Maestro MCP to Maestro CLI.** The verifier now drives mobile verification via `maestro test` (flow execution), `maestro hierarchy` (view hierarchy as plain text, ~200–600 tokens), and native screenshot capture (`xcrun simctl io booted screenshot` / `adb exec-out screencap -p` + `sips -Z 1400`). Ad-hoc navigation uses an **ephemeral-flow pattern** — write a minimal YAML flow to `/tmp/sf-maestro-*.yaml`, run `maestro test`, discard. The `skills/visual-verify/SKILL.md` is the canonical CLI reference; `shadow-verifier.md` and `shadow-sprint-verifier.md` delegate to it. Playwright (web) still uses the Playwright MCP server — this migration covers Maestro only; Playwright is the next likely candidate.
- **`shadow-verifier` / `shadow-sprint-verifier` frontmatter narrowed** from `mcpServers: [maestro, playwright]` to `mcpServers: [playwright]`. Mobile no longer needs MCP tool bindings to reach subagent sessions. Run `/soloflow:sync-agents` after upgrade to sync the narrowed frontmatter into `.claude/agents/`.
- **`/soloflow:init` dropped Maestro MCP registration** from its wizard. New steps in the Maestro branch: a simulator/emulator sanity check (`xcrun simctl list devices booted`, `adb devices`), and an optional prompt for `verification.visual_mobile_app_id` used for ad-hoc flows. If the wizard detects `maestro` already registered in `claude mcp list`, it prints a zero-click informational note explaining the registration is inert in 0.9.3+ and can be removed with `claude mcp remove maestro`.
- **`scripts/sprint/probe-infra.js`** — Maestro probe narrowed to `which maestro` only (no more `claude mcp list` step). Shadow-install cross-check limited to Playwright, since mobile no longer depends on binding propagation.
- **Port-7001 guardrail removed.** The "never run `maestro test` via Bash while Maestro MCP is active" note is gone from every prompt — without an MCP, there's no conflict. `maestro test`, `maestro hierarchy`, and `maestro record` all own port 7001 uncontested.

### Added
- **`verification.visual_mobile_app_id`** (default `null`) — optional bundle ID used for ad-hoc Maestro flows when a project has no existing flows to grep `appId:` from. If null, the verifier auto-detects from existing flows in `verification.visual_maestro_flow_dirs`; if none exist, it emits `skipped_unable` with an actionable message.
- **Troubleshooting entries** in `docs/VISUAL-VERIFICATION-SETUP.md` for "No simulator booted", "Multiple iOS simulators booted", and "Removing a stale Maestro MCP registration".

### Migration
Existing users with `maestro` registered in `claude mcp list` can leave it — SoloFlow 0.9.3+ simply doesn't call it. Remove manually with `claude mcp remove maestro` if you want a clean list. After upgrading the plugin, run `/soloflow:sync-agents` to pick up the narrowed `mcpServers: [playwright]` frontmatter, then restart Claude Code so the refreshed shadows load at session start.

## [0.9.2] - 2026-04-23

### Fixed
- **`scripts/init/shadow-agents.js` resolves the plugin root without `CLAUDE_PLUGIN_ROOT`.** Claude Code interpolates `${CLAUDE_PLUGIN_ROOT}` into slash-command text but does not export it to Bash subprocesses, so `/soloflow:sync-agents` (and any direct `node shadow-agents.js` invocation) died with `CLAUDE_PLUGIN_ROOT not set — cannot resolve source agents`. `pluginRoot()` now mirrors the fallback pattern in `scripts/lib/config.js`: walk up from `__dirname` looking for `.claude-plugin/plugin.json`. Env var still takes precedence when set.

## [0.9.1] - 2026-04-23

### Changed
- **MCP-dependent agents renamed with `shadow-` prefix.** The four agents that require MCP tool bindings (`verifier`, `sprint-verifier`, `researcher`, `roadmap-researcher`) are now `shadow-verifier`, `shadow-sprint-verifier`, `shadow-researcher`, `shadow-roadmap-researcher`. The plugin ships them under their `shadow-*` names and orchestrators spawn them by those names exclusively — no reliance on Claude Code's project/plugin precedence rule, which did not hold reliably when names collided (spawns would resolve to the plugin version even when a properly-installed shadow existed, stripping the `mcpServers:` bindings that only project-local agents honor). `scripts/init/shadow-agents.js`, `scripts/sprint/probe-infra.js`, every spawn site in `commands/` and `agents/`, `commands/sync-agents.md`, `commands/init.md`, and the model-table row in `docs/CUSTOMIZATION.md` all point at the new filenames. `models.verifier` / `models.researcher` / `models.roadmap_researcher` / `models.sprint_verifier` config keys are unchanged — only the agent file paths they map to moved, so existing `.soloflow/config.json` overrides continue to apply. **Users upgrading:** run `/soloflow:init` (or `/soloflow:sync-agents`) to install the new `shadow-*.md` shadows; the previous `verifier.md` / `sprint-verifier.md` / `researcher.md` / `roadmap-researcher.md` shadows in `.claude/agents/` can be deleted by hand (they're inert after the rename).

## [0.9.0] - 2026-04-23

### Added
- **`scripts/init/shadow-agents.js`** — reusable check/sync utility for the four MCP-dependent agent shadows (`verifier`, `sprint-verifier`, `researcher`, `roadmap-researcher`). `--mode check` emits JSON with `drifted`, `needs_update`, and per-shadow status (`current` / `stale` / `untracked` / `not_installed`). `--mode sync [--set all|visual|research] [--agent name]` copies from `$CLAUDE_PLUGIN_ROOT/agents/` and injects a version stamp into each shadow's frontmatter as a YAML comment (`# soloflow-shadow: version=X synced=Y`). The stamp is invisible to Claude Code's YAML parser and to the LLM, self-contained in the shadow file (no sidecar), and greppable for humans.
- **`/soloflow:sync-agents`** slash command — manual wrapper around the utility. Prints a status table, syncs any drifted/missing shadows, and reminds the user to restart Claude Code so the new shadows are picked up at session start. Use after a plugin update, or whenever `/soloflow:sprint`'s preflight warns about drift.
- **`commands/sprint.md` Step 0.45** — non-blocking drift check at sprint start. If the plugin version is newer than the version stamped into any installed shadow, `AskUserQuestion` offers `Update now` / `Skip` / `Abort`. "Update now" runs the sync utility inline; the user is reminded that shadow changes take effect on the NEXT session, since subagents load at session start.
- **`scripts/refiner/files-owned-exist.js`** — validates every `files_owned` path on a plan exists on disk and returns basename-matched suggestions for misses. New step 5h in `agents/task-refiner.md` runs the script before emitting each plan; the refiner must correct typos using a suggestion OR confirm new-file creation with explicit plan-body language. Catches the repeating pattern of silent path corrections at execution time (e.g., `app/recipe/[id].tsx` → `app/(tabs)/recipes/[id].tsx`) that masked plan-quality issues.
- **Compounder Bucket C self-defect check** (`agents/compounder.md` step 6a) — every C-candidate is challenged with "is this actually a SoloFlow subagent/planner/orchestrator defect being papered over as a project convention?" Red-flag signals include references to SoloFlow agents, workarounds for missing SoloFlow capabilities, and rules that wouldn't apply if the user switched workflows. Tester-mode reclassifies matching C-items to Bucket D; non-tester drops them to a new `## Suppressed — SoloFlow Defects` audit section so project CLAUDE.md files stay free of plugin-behavior lore.

### Changed
- **`/soloflow:init`'s visual verification and research agent callouts** now delegate to `scripts/init/shadow-agents.js --mode sync --set {visual|research}` instead of raw `cp` commands, so every shadow gets its version stamped at install time. Enables the sprint preflight drift check to detect updates.

### Fixed
- **Plugin-scoped subagents don't actually honor `mcpServers:` frontmatter.** 0.8.6's fix for `skipped_unable` was incorrect — the declaration was silently ignored on plugin subagents. Every `verifier` / `sprint-verifier` spawn after 0.8.6 still lost its Maestro/Playwright tool bindings, and every visual check degraded to `skipped_unable` despite the frontmatter claim. `/soloflow:init` now shadow-installs the MCP-dependent agents from `$CLAUDE_PLUGIN_ROOT/agents/` into `.claude/agents/` as two explicit, feature-tied callouts inside Step 4:
    - **Visual verification agents** (`verifier.md`, `sprint-verifier.md`) — runs inside the visual verification wizard, after MCP server registration. Gated on `visual_mobile || visual_web`. Prints an explicit "why this step exists" callout so the user understands the mechanism.
    - **Research agents** (`researcher.md`, `roadmap-researcher.md`) — runs inside the context7 section of "Optional plugin probes". Unconditional on context7 presence so shadows are ready if the user installs context7 later.

  Project-local agents honor `mcpServers:`, and Claude Code's documented scope-precedence (project-local wins over plugin) means the shadows replace the plugin versions whenever the orchestrator spawns `verifier` etc. Idempotent — re-syncs on every init so plugin updates propagate. Users upgrading from 0.8.6–0.8.10 should re-run `/soloflow:init` and then restart Claude Code so freshly-written shadow agents are picked up (subagents load at session start).
- **Sprint-initiator cross-checks shadow-install state when `visual_mobile`/`visual_web=true`.** `claude mcp list` + `which` could both pass while the verifier subagent still lacked `mcp__maestro__*` / `mcp__playwright__*` tool bindings because the shadows at `.claude/agents/verifier.md` / `sprint-verifier.md` were `not_installed`, `stale`, or `untracked`. `scripts/sprint/probe-infra.js` now calls the shadow-agents check and demotes the config-driven visual category from `available` to `missing` with a shadow-specific reason (`shadow agents not current (verifier.md=stale, sprint-verifier.md=not_installed) — mcp__maestro__* bindings will not reach verifier subagent session. Run /soloflow:sync-agents to install/update shadows.`), so the orchestrator surfaces the gap up-front at Step 2.8 instead of letting every task silently degrade to `skipped_unable` across a whole sprint.
- **Compounder refuses range-shorthand `done_reports`.** `batch-select.js build-inputs` has always enumerated real paths, but the orchestrator LLM would occasionally collapse a 12-path list into `TASK-132..TASK-143-done.md` when serializing the compounder's prompt. The compounder recovered via defensive glob, which silently masked the abbreviation bug. Two defenses now in place: `commands/compound.md` Step 2 spells out "pass every path verbatim, one per line, no range shorthand, no globs, no paraphrasing"; `agents/compounder.md` stats every `done_reports[]` / `stuck_reports[]` path on input and aborts with `INPUT_ERROR: orchestrator passed non-existent path {path}` instead of glob-recovering, so future abbreviation bugs surface immediately.

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
