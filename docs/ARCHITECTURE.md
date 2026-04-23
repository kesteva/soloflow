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
- **Routing:** BUGFIX ideas redirect to `/soloflow:quick` for a shorter path

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

0. **Pre-execution prerequisites** — sprint-initiator probes per-task `prerequisites[]` (declared in each plan's frontmatter) + the maestro/playwright/docker infra check. Failing `blocking: true` probes gate the affected task out of the sprint at Step 2.8 with a human-review-queue entry carrying the suggested fix command. See `agents/task-refiner.md` step 5f for authoring.
1. **Ground truth** — tests, type checker, linter (non-negotiable, automated)
2. **Visual** — Maestro MCP (mobile), Playwright MCP (web), optional and gated on config. See [Visual Verification Setup](VISUAL-VERIFICATION-SETUP.md).
3. **Requirements adherence** — each acceptance criterion checked with concrete evidence
4. **Goal-backward** — "What must be TRUE for production?"
5. **Per-task code review** — inline quality/reuse + security audit by the code-reviewer agent against the task's changed files. Can send the executor back with `IMPROVEMENTS_NEEDED`. Toggle: `code_review.enabled`; retry budget: `code_review.review_retry_max`.
6. **Sprint-level code review** — inline quality/reuse + security assessment across `base_sha..HEAD` plus a cross-task redundancy sweep. **Advisory only** — findings go to human review (accept → active sprint's findings file / defer / dismiss), never back to execution. Toggle: `sprint_code_review.enabled` (resolves independently from `code_review.enabled`).

**Visual verification runtime.** The verifier checks tool availability (`which maestro`, `which npx`) before attempting MCP interactions; if tools aren't installed or MCP servers aren't running, Level 2 is skipped gracefully.

**Token budget.** Use `inspect_view_hierarchy` (~50 tokens) over `take_screenshot` (~1600 tokens) when layout-only checks suffice. Limit to 3 screenshots per verification. Never run `maestro test` via Bash while Maestro MCP is active (port 7001 conflict).

## Key Constraint

Subagents cannot spawn subagents in Claude Code. The phase commands (`/soloflow:idea-extractor`, `/soloflow:planner`, `/soloflow:sprint`, `/soloflow:compound`) run in the main session and act as the orchestrator for their phase. All agents (executor, verifier, idea-extractor, task-refiner, compounder) are leaf-node subagents.