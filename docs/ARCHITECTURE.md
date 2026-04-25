# Architecture

SoloFlow is a set of Claude Code hooks, agent definitions, slash commands, and skills that orchestrate a product development workflow. It has no runtime dependencies beyond Claude Code and Node.js. All state is stored as markdown files with YAML frontmatter in the `.soloflow/` directory — see [State Layer](STATE-LAYER.md) for layout, ID allocation, findings queue, and epics.

## Workflow

```
  Raw Idea
     │
     ▼
┌────────────────┐
│ Idea Extractor │  (Sonnet)
│ Phase 1        │
└───────┬────────┘
        │
   Human Checkpoint ← approve / modify / reject
        │
        ▼
┌────────────────┐
│ Task Refiner   │  (Opus)
│ Phase 2        │
└───────┬────────┘
        │
   Human Checkpoint ← approve plans / request changes
        │
        ▼
┌────────────────────────────────────┐
│ Execution Sprint — Phase 3         │
│                                    │
│   ┌──────────┐     ┌──────────┐   │
│   │ Executor │ ──▶ │ Verifier │   │
│   │ (Sonnet) │ ◀── │ (Opus)   │   │
│   └──────────┘     └──────────┘   │
│        ↻ retry loop (max 3)       │
└───────────────┬────────────────────┘
                │
   Human Review ← taste-level check (functional already verified)
                │
                ▼
┌────────────────┐
│ Compounder     │  (Sonnet)
│ Phase 5        │
└────────────────┘
        │
        ▼
   Reusable Solutions
```

## Phases

### Phase 0: Roadmap Generation (optional)
- **Agents:** `roadmap-researcher` (Sonnet, parallel) + `roadmap-generator` (Opus)
- **Input:** Project vision
- **Output:** `ROADMAP-NNN.md` in `.soloflow/active/roadmaps/`
- **Flow:** deep questioning → parallel research → phased epics
- **Materializes as:** ideas (normal pipeline) or plans (immediate execution)
- Pre-pipeline accelerator; does not replace any phase.

### Phase 1: Idea Extraction
- **Agent:** `idea-extractor` (Sonnet)
- **Input:** Raw user description
- **Output:** `IDEA-NNN.md` in `.soloflow/active/ideas/`
- **Human touchpoint:** User reviews idea, approves/modifies/rejects
- **Routing:** BUGFIX ideas redirect to `/soloflow:bugfix` (investigator → executor → verifier) for a shorter path. `/soloflow:quick` is also available when the user already knows the exact fix and wants to skip investigation.

### Phase 2: Task Refinement
- **Agent:** `task-refiner` (Opus)
- **Input:** Approved idea file
- **Output:** One or more `TASK-NNN-plan.md` files in `.soloflow/active/plans/`
- **Human touchpoint:** User reviews all plans, approves/defers/requests changes

### Phase 3: Execution Sprint
- **Agents:** `executor` (Sonnet) + `verifier` (Opus) + `code-reviewer` (Opus), coordinated by the main session via the `/soloflow:sprint` command
- **Input:** Approved plan files
- **Output:** Code changes (committed), done reports in `.soloflow/archive/done/`
- **Loop:** Executor implements → verifier checks → retry up to 3 times if NEEDS_CHANGES → stuck report if still failing
- **Parallel batches:** Step 3 picks up to `limits.max_parallel_tasks` (default 3) ready tasks whose `files_owned` are disjoint and runs each phase in parallel across them. Each parallel task gets its own git worktree under `.soloflow/worktrees/TASK-NNN/`; the orchestrator fast-forward-merges the task branch back to the run branch after its pipeline completes. Set `limits.max_parallel_tasks: 1` to disable (strict serial). See [`CUSTOMIZATION.md`](./CUSTOMIZATION.md#parallel-task-execution).
- **Human touchpoint:** Items marked HUMAN_NEEDED are queued for review

### Phase 4: Human Review
- **No agent** — the `/soloflow:sprint` command presents a consolidated review at the end of the sprint
- **Input:** Done reports, stuck reports, human-needed items
- **Human touchpoint:** User does taste-level review (all functional verification already done by the verifier)

### Phase 5: Compound Learning
- **Agent:** `compounder` (Sonnet, interactive)
- **Input:** Done reports, stuck reports, and the sprint's per-sprint findings file (`active/findings/SPRINT-NNN-findings.md`)
- **Output:** `active/compound/SPRINT-NNN-proposal.md` with three buckets: (A) clean-ups to apply immediately, (B) backlog ideas → `active/ideas/IDEA-NNN.md`, (C) CLAUDE.md improvements
- **Optional pre-review:** `claude-md-reviewer` (Opus) tightens/drops Bucket C; `compound-skeptic` (Opus) adds per-item IMPLEMENT / DONT_IMPLEMENT verdicts. Both toggleable via `compound.*` config.
- **Flow:** user approves per-item (including "Accept skeptic's recommendations"); main agent applies approved items with atomic commits, then archives the proposal and findings file(s). Compound does not block the next sprint.
- **Batching:** when multiple sprints are pending, `/soloflow:compound --all` (or a multi-select picker) batches them into ONE merged proposal (`active/compound/SPRINT-{MIN}-{MAX}-proposal.md`) with globally numbered items carrying a `Source-Sprint:` field, one review flow, and one apply pass. Each sprint's findings file still archives individually to `archive/findings/SPRINT-NNN-findings.md`. A single-sprint run keeps today's format (`SPRINT-NNN-proposal.md`).

### Lightweight single-task paths

Two commands skip Phase 1 + Phase 2 and run a single task inline (no run branch, no worktree, no per-task code review). They share the same plan format, sprint scaffold (`SPRINT-{prefix}-<timestamp>`), `settle-task.js` pipeline, and HUMAN_NEEDED escalation as `/soloflow:sprint`:

| Command | Pre-execution agent | When to use |
|---|---|---|
| `/soloflow:bugfix` | `bug-investigator` (Opus, read-only) → user confirmation gate → executor → verifier → test-writer | Bug reports where the user describes a symptom but does not yet know the fix. The investigator does root-cause analysis before any code changes. |
| `/soloflow:quick` | none | Bugs / small fixes where the user already knows what to change. Goes straight to executor + verifier. |

Both paths emit a `TASK-NNN-plan.md`, run the standard executor → verifier loop with `limits.executor_retry_max` retries, and produce a done report consumable by `/soloflow:compound`.

## Hook System

| Event | File | Purpose | Timeout |
|-------|------|---------|---------|
| SessionStart | `session-start.js` | Inject task state summary at session open | 10s |
| PostToolUse | `post-tool-use.js` | Auto-lint after Write/Edit operations | 15s |
| TaskCompleted | `task-completed.js` | Quality gate — block completion if tests/types fail | 120s |
| PreCompact | `pre-compact.js` | Save progress to checkpoint before context compression | 10s |
| SubagentStop | `subagent-stop.js` | Update progress state and inject context when a subagent completes | 10s |

Hooks are plain Node.js with no external dependencies. They read stdin for event data and output JSON to stdout for context injection. The `detect-tools.js` utility is shared by `post-tool-use` and `task-completed` to detect project test runners, type checkers, and linters.

## Agent Model Strategy

| Role | Model | Rationale |
|------|-------|-----------|
| Orchestrator | Opus | Complex coordination, dependency management |
| Verifier | Opus | Thorough analysis, skeptical evaluation |
| Task Refiner | Opus | Architectural decisions, approach selection |
| Bug Investigator | Opus | Root-cause diagnosis from a symptom |
| Executor | Sonnet | Code implementation, high throughput |
| Idea Extractor | Sonnet | Structured parsing, codebase search |
| Compounder | Sonnet | Pattern extraction from completed work |

Using Sonnet for throughput-oriented roles reduces cost by ~60% while maintaining quality for judgment-critical roles via Opus.

## State Layer

All workflow state lives in `.soloflow/`, created by `scripts/init.sh`:

```
.soloflow/
├── active/                     # Read during execution
│   ├── ideas/                  # IDEA-NNN.md (Phase 1 output)
│   ├── plans/                  # TASK-NNN-plan.md (Phase 2 output)
│   ├── stuck/                  # TASK-NNN-stuck.md (failed tasks)
│   ├── findings/               # SPRINT-NNN-findings.md (per-sprint queue; one per pending sprint)
│   └── compound/               # SPRINT-NNN-proposal.md (pre-archive compound draft)
├── archive/                    # Never read during execution
│   ├── done/                   # TASK-NNN-done.md (completed tasks)
│   ├── reviews/                # Human review reports
│   ├── findings/               # Archived per-sprint findings files (post-compound)
│   └── compound/               # SPRINT-NNN-proposal.md (archived Phase 5 output)
├── active/backlog.json         # Ready tasks awaiting execution
├── active/sprint.json          # Active sprint + in-flight tasks
├── checkpoint.md               # Context restoration after compaction
└── human-review-queue.md       # Batched items for human review
```

**Design principles:**
- Active/archive split ensures execution only reads in-flight state, not full history
- Completed tasks are removed from `sprint.json` and moved to `archive/done/`
- ID allocation (IDEA/TASK/SPRINT/SOL) is derived from the filesystem — no counters file — so parallel workers don't merge-conflict on a shared counter
- All files use markdown + YAML frontmatter — optimized for LLM parsing and git diffs

## Verification Hierarchy

Multi-layered verification, in order of authority:

0. **Pre-execution prerequisites** — sprint-initiator probes per-task `prerequisites[]` (declared in each plan's frontmatter) + the maestro/playwright/docker infra check + the optional `verification.dev_server` probe (start/restart-under-sprint UX at Step 1.5f, lifecycle managed in Step 2.5 via `Bash run_in_background` and Step 4.6 `TaskStop`). Failing `blocking: true` probes gate the affected task out of the sprint at Step 2.8 with a human-review-queue entry carrying the suggested fix command. See `agents/task-refiner.md` step 5f for authoring.
1. **Ground truth** — tests, type checker, linter (non-negotiable, automated)
2. **Visual** — Maestro (mobile; MCP preferred, CLI fallback), Playwright MCP (web), optional and gated on config. See [Visual Verification Setup](VISUAL-VERIFICATION-SETUP.md).
3. **Requirements adherence** — each acceptance criterion checked with concrete evidence
4. **Goal-backward** — "What must be TRUE for production?"
5. **Per-task code review** — inline quality/reuse + security audit by the code-reviewer agent against the task's changed files. Can send the executor back with `IMPROVEMENTS_NEEDED`. Toggle: `code_review.enabled`; retry budget: `code_review.review_retry_max`.
6. **Sprint-level code review** — inline quality/reuse + security assessment across `base_sha..HEAD` plus a cross-task redundancy sweep. **Advisory only** — findings are appended directly to the active sprint's findings file and consumed by the next `/soloflow:compound` run (the user is not prompted to triage them at sprint close). Never feeds back into execution. Toggle: `sprint_code_review.enabled` (resolves independently from `code_review.enabled`).

**Visual verification runtime.** Before path selection, the visual_mobile path runs a **dev-server preflight** (when `verification.dev_server.enabled`): probe the configured URL and emit `visual_mobile: skipped_metro_offline` on miss to short-circuit the full Maestro chain (compound finding D1, SPRINT-026). The verifier then picks a mobile path once per run via **Path Selection** (see `skills/visual-verify/SKILL.md`): probe `mcp__maestro__list_devices` first; on success use Maestro MCP for every mobile call this run; else fall back to `which maestro` + booted-device probe and use the CLI. For web: `which npx` + Playwright MCP probe. If nothing is available (Maestro MCP unbound AND CLI not installed / no device booted, or Playwright MCP unreachable), Level 2 is skipped gracefully.

**Token budget.** MCP `inspect_view_hierarchy` (CSV, ~50 tokens) is ~4–10× cheaper than CLI `maestro hierarchy` (plain text, ~200–600 tokens); both are far cheaper than screenshot capture (~1600 tokens after `sips -Z 1400` downsize). Limit to 3 screenshots per verification. Never mix Maestro MCP and CLI within a single run — both bind port 7001. Within the chosen path, serialize against the same device.

## Key Constraint

Subagents cannot spawn subagents in Claude Code. The phase commands (`/soloflow:idea-extractor`, `/soloflow:planner`, `/soloflow:sprint`, `/soloflow:compound`) run in the main session and act as the orchestrator for their phase. All agents (executor, verifier, idea-extractor, task-refiner, compounder) are leaf-node subagents.