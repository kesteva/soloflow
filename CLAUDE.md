# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

SoloFlow is a hooks-based Claude Code workflow orchestration system that automates the product development lifecycle: idea extraction → refinement → execution → verification → learning. Distributed as a Claude Code plugin (git repo + thin plugin wrapper) installable per-project or globally.

**First test case:** ImagiFable app (React Native/Expo).

## Architecture

Seven-phase workflow orchestrated via Claude Code hooks and agent definitions:

0. **Roadmap Generation** (Sonnet researchers + Opus generator, optional) — project vision → deep questioning → parallel research → phased epics → `.soloflow/active/roadmaps/ROADMAP-NNN.md`. Materializes as ideas (for normal pipeline) or plans (for immediate execution). Pre-pipeline accelerator; does not replace any phase.
1. **Idea Extraction** (Sonnet) — raw input → structured `.soloflow/active/ideas/IDEA-NNN.md`
2. **Research** (Sonnet, optional) — external ecosystem research → `.soloflow/active/research/IDEA-NNN-research.md`
3. **Task Refinement** (Opus) — idea + research → execution-ready `.soloflow/active/plans/TASK-NNN-plan.md`
4. **Execution Sprint** — Orchestrator (Opus) coordinates parallel Executor (Sonnet) + Verifier (Opus) + Code Reviewer (Opus) subagents via worktrees
5. **Human Review** — batched taste-level review (functional verification already done)
6. **Compound Learning** (Sonnet, interactive) — analyzes done reports + stuck reports + `.soloflow/active/findings.md` and produces a three-bucket proposal (`COMPOUND-PROPOSAL.md`): (A) clean-ups to apply immediately, (B) backlog ideas → `active/ideas/IDEA-NNN.md`, (C) CLAUDE.md improvements to apply directly. The user approves per-item; the main agent applies approved items (clean-ups as direct edits, not new tasks) with atomic commits, then archives the proposal and findings file.

**Key constraint:** Subagents cannot spawn subagents. Orchestrator is main agent; executors/verifiers/reviewers are leaf nodes only.

**Context limit handoffs.** A statusline hook (`hooks/statusline.js`) writes context metrics to a bridge file; a PostToolUse hook (`hooks/context-monitor.js`) reads it and injects WARNING (≤35% remaining) / CRITICAL (≤25%) into the agent conversation. Subagents respond to CRITICAL by committing work and reporting `CONTEXT_LIMIT` status with an inline `### Handoff` section; the orchestrator spawns a fresh agent with the handoff context (up to `context_limit_respawn_max`, default 3). The orchestrator itself responds to CRITICAL by checkpointing and asking the user to compact-and-continue or save-and-exit.

### Components

- **`agents/`** — Agent definitions as markdown with YAML frontmatter
- **`hooks/`** — JavaScript Claude Code hooks, declared in `hooks/hooks.json` with `${CLAUDE_PLUGIN_ROOT}` paths
- **`commands/`** — Slash command definitions, namespaced as `/soloflow:<name>`: `/soloflow:roadmap`, `/soloflow:idea-extractor`, `/soloflow:planner`, `/soloflow:executor`, `/soloflow:mad-max`, `/soloflow:compound`, `/soloflow:quick`, `/soloflow:status`, `/soloflow:verify`, `/soloflow:review-queue`, `/soloflow:config`
- **`skills/`** — Skill definitions (e.g., `visual-verify/`)
- MCP servers (Maestro, Playwright) are **not** shipped in a plugin `.mcp.json` — `/soloflow:init` detects them via `claude mcp list` and offers per-user or per-project registration to avoid collisions with existing installs.
- **`scripts/`** — Shell scripts for the script-install fallback (`install.sh`, `update.sh`, `uninstall.sh`, `init.sh`). Primary install path is `/plugin install soloflow`.
- **`config/`** — `defaults.yaml` configuration

### State Layer

All workflow state lives in `.soloflow/` (created per-project by `scripts/init.sh`), split into active and archive:

**`.soloflow/active/`** — read during execution:
- `roadmaps/` — roadmap files (ROADMAP-NNN.md)
- `ideas/`, `research/`, `plans/`, `stuck/` — in-flight task files
- `backlog.json` — tasks awaiting execution (written by refinement, read by execution)
- `sprint.json` — active sprint + in-flight tasks (written/read by execution)
- `findings.md` — append-only queue of out-of-scope observations logged by executor / verifier / code-reviewer during a sprint. Consumed and archived by the compounder.
- `COMPOUND-PROPOSAL.md` — transient file written by the compounder during `/soloflow:compound`, archived after the user approves/rejects items.

**`.soloflow/archive/`** — never read during execution:
- `ideas/` — ideas that have been refined into plans (moved from `active/ideas/` by the planner)
- `done/`, `reviews/` — completed task reports and learnings
- `findings/` — archived findings files, one per compounded sprint
- `compound/` — archived compound proposals (including rejected items) for later reference
- `roadmaps/` — archived roadmap files

**`.soloflow/`** root:
- `checkpoint.md` — context restoration after compaction
- `human-review-queue.md` — batched items for human review
- `config.json` — project-level overrides for every key in `config/defaults.yaml`. Read at runtime via the three-tier recipe in `docs/CUSTOMIZATION.md#config-resolution`. Edit interactively via `/soloflow:config`. Unknown keys are preserved; nothing reads them until they're documented in `defaults.yaml`.

**ID allocation.** `IDEA-NNN`, `TASK-NNN`, and `SPRINT-NNN` are derived from the filesystem — there is no `counters.json`. To allocate the next ID, glob every location an ID of that kind could live, extract the numeric suffix, take `max + 1`, zero-pad to 3 digits. Reference globs:

- **IDEA:** `.soloflow/active/ideas/IDEA-*.md` ∪ `.soloflow/archive/ideas/IDEA-*.md`
- **TASK:** `.soloflow/active/plans/**/TASK-*-plan.md` ∪ `.soloflow/active/stuck/**/TASK-*-stuck.md` ∪ `.soloflow/archive/done/**/TASK-*-done.md`
- **SPRINT:** `.soloflow/archive/compound/SPRINT-*-proposal.md` ∪ `.soloflow/archive/findings/SPRINT-*-findings.md` ∪ the active `sprint.json`'s `sprint.id`
- **ROADMAP:** `.soloflow/active/roadmaps/ROADMAP-*.md` ∪ `.soloflow/archive/roadmaps/ROADMAP-*.md`

Recipe (bash):
```bash
next_id() {
  local prefix=$1; shift
  local max=0
  for p in "$@"; do
    for f in $(compgen -G "$p" 2>/dev/null); do
      n=$(basename "$f" | sed -n "s/^${prefix}-0*\([0-9]\+\).*/\1/p")
      [ -n "$n" ] && [ "$n" -gt "$max" ] && max=$n
    done
  done
  printf "%03d" $((max + 1))
}
```

**Collision handling.** When two parallel workers compute the same "next ID," the second writer must fail-fast on write and retry. In bash, use `set -o noclobber` + `> file` (or `: > file`) which errors if the file exists; in Node, `fs.writeFileSync(path, data, { flag: 'wx' })`; via a slash command, check `test -e` and retry with `max+1` if it exists. Never overwrite an existing ID file.

**Findings queue.** Executor / verifier / code-reviewer agents append an entry to `active/findings.md` whenever they notice something out of scope for their current task (a bug elsewhere, stale docs, a CLAUDE.md gap). They never expand scope to fix it. The compounder consumes the queue at learning time and uses it as the primary seed for clean-up, backlog, and CLAUDE.md proposals.

State is split into 2 JSON files (backlog, sprint) to enable parallel worktree execution without merge conflicts. Completed tasks are removed from `sprint.json` and their reports move to `archive/done/`. There is no counters file — IDs are derived from the filesystem (see "ID allocation" above).

**Run branches.** When `git.branch_per_run` is enabled (see `docs/CUSTOMIZATION.md`), `/soloflow:executor` creates a dedicated branch per invocation (default: `soloflow/run-{timestamp}-{sprint_id}`), executor commits accumulate on it, and the branch is merged back (`--no-ff` by default) after human review. `sprint.json` carries a `run` object (`branch`, `base_branch`, `base_sha`, `created_at`) so resume detects the branch across sessions. The default preference (`prompt`) asks at the start of each run; set to `always` / `never` via `.soloflow/config.json` to skip the prompt.

**Epics.** Tasks may optionally be grouped into epics via nested folders: `plans/<epic>/TASK-NNN-plan.md`, `stuck/<epic>/TASK-NNN-stuck.md`, `done/<epic>/TASK-NNN-done.md`. Each epic folder contains an `EPIC-<epic>.md` manifest (objective, scope, success signal) authored by the task-refiner when the epic is first created. Epics are **optional** — orphan tasks live flat at the state-root level (e.g. `plans/TASK-NNN-plan.md`), and a single idea may produce tasks across multiple epics + orphans. Task IDs remain **globally unique**; `backlog.json` / `sprint.json` / `counters.json` are epic-unaware. The source of truth for a task's epic is its plan frontmatter `epic: <slug>` field (absent/null for orphans); the folder is a convenience mirror. When all tasks in an epic complete, the executor prompts the user to archive the epic (moves `EPIC-<epic>.md` to `archive/done/<epic>/` and flips its status to `complete`); archival is never automatic.

State format: Markdown with YAML frontmatter (optimized for LLM parsing + git diffs).

## Agent Model Strategy

- **Opus:** Orchestrator, Verifier, Task Refiner, Code Reviewer, Roadmap Generator (quality-critical roles)
- **Sonnet:** Executor, Idea Extractor, Researcher, Roadmap Researcher, Compounder (cost optimization, ~60% reduction)

## Verification Layer

Multi-layered verification hierarchy (in order of authority):
1. Ground truth: test suite, type checker, linter
2. Visual: Maestro MCP (mobile), Playwright MCP (web)
3. Requirements adherence with concrete evidence
4. Goal-backward: "What must be TRUE for production?"
5. Code review: `/simplify` (quality/reuse) + `/security-review` (security audit)

**Visual verification:** The verifier checks tool availability at runtime (`which maestro`, `which npx`) before attempting MCP interactions. If tools aren't installed or MCP servers aren't running, Level 2 is skipped gracefully. See `docs/VISUAL-VERIFICATION-SETUP.md` for configuration.

**Token budget:** Use `inspect_view_hierarchy` (~50 tokens) over `take_screenshot` (~1600 tokens) when layout-only checks suffice. Limit to 3 screenshots per verification. Never run `maestro test` via Bash while Maestro MCP is active (port 7001 conflict).

