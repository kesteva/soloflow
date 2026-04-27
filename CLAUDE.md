# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

SoloFlow is a hooks-based Claude Code workflow orchestration system that automates the product development lifecycle: idea extraction → refinement → execution → verification → learning. Distributed as a Claude Code plugin (git repo + thin plugin wrapper) installable per-project or globally.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the phase workflow, hook system, agent model strategy, and verification hierarchy.

**This repo does not dogfood SoloFlow on itself.** SoloFlow is the product built here, not the workflow used to build it. Do not run `/soloflow:*` commands, create `.soloflow/` state, spawn SoloFlow agents, or otherwise invoke the SoloFlow pipeline to make changes to this codebase. Work on SoloFlow the way you'd work on any other repo: read files, make edits, run tests, commit. If a request seems to imply "use SoloFlow to improve SoloFlow," stop and ask — it's almost certainly not what the user meant.

## Constraints every agent must know

**Subagents cannot spawn subagents.** Orchestration runs in the main session (`/soloflow:sprint`, `/soloflow:compound`, etc.); executors, verifiers, reviewers, and all other agent definitions are leaf nodes only.

**Parallel task loops share a per-task worktree.** When `/soloflow:sprint` or `/soloflow:mad-max` runs multiple non-conflicting tasks concurrently (governed by `limits.max_parallel_tasks`), the orchestrator creates a short-lived git worktree per task at `.soloflow/worktrees/TASK-NNN/` and injects `WORKTREE_ROOT: <abs path>` into every subagent prompt for that task. Subagents must honor the directive (see each agent's "Working directory" section). Merge-back + `settle-task.js` run sequentially from the main worktree.

**Context-limit handoffs.** `hooks/statusline.js` writes context metrics to a bridge file; `hooks/context-monitor.js` (PostToolUse) reads it and injects WARNING (≤35% remaining) / CRITICAL (≤25%) into the agent conversation.

- **Subagents** respond to CRITICAL by committing in-progress work and reporting `CONTEXT_LIMIT` status with an inline `### Handoff` section. The orchestrator spawns a fresh agent with the handoff context (up to `context_limit_respawn_max`, default 3).
- **Orchestrators** respond to CRITICAL by checkpointing and asking the user to compact-and-continue or save-and-exit.

## Release / branch hygiene

Two long-lived branches:

- `main` — public stable channel. `/plugin install soloflow@soloflow` installs from here.
- `dev` — pre-release channel for maintainer/tester use. `/plugin install soloflow-dev@soloflow` installs from here.

Two files **deliberately differ** between the branches and will conflict on every merge in either direction. Don't collapse the divergence — both values are load-bearing for the parallel-install namespacing.

- `.claude-plugin/plugin.json` — `"name"` is `"soloflow"` on `main` and `"soloflow-dev"` on `dev`. Each branch's value is correct for that branch. On any merge conflict, **keep the destination branch's value** (i.e. the side you're merging *into*). The dev install needs its own `plugin.json.name` so its `/soloflow-dev:*` commands and hooks don't collide with the public install's `/soloflow:*`.
- `.claude-plugin/marketplace.json` — `main` lists both plugin entries (`soloflow` and `soloflow-dev`); a freshly-branched `dev` has only the `soloflow` entry. Always keep `main`'s two-entry version as canonical; on a `main → dev` resync, take main's version (harmless to have both entries on dev). Once dev has the two-entry version, this file stops conflicting.

When releasing (merging `dev` → `main`), do NOT delete the `dev` branch after merge — it persists for the next cycle. PRs are fine; the branch survives unless GitHub's "delete branch on merge" toggle is on.

## Reference

- **State layout, ID allocation, findings queue, epics** → [`docs/STATE-LAYER.md`](docs/STATE-LAYER.md)
- **Phases, hooks, model strategy, verification hierarchy** → [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- **Config, run branches, all runtime settings** → [`docs/CUSTOMIZATION.md`](docs/CUSTOMIZATION.md)
- **Visual verification (Maestro/Playwright MCP)** → [`docs/VISUAL-VERIFICATION-SETUP.md`](docs/VISUAL-VERIFICATION-SETUP.md)
