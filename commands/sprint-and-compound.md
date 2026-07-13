---
description: Run /soloflow:sprint with /soloflow:compound interleaved before the merge choice — one end-to-end flow with a single final merge prompt
argument-hint: "[TASK-NNN... | IDEA-NNN] [--quick | --no-code-review | --no-verification]"
allowed-tools: [Read, Write, Edit, Glob, Grep, Bash, Agent, AskUserQuestion]
---

# /soloflow:sprint-and-compound

Phases 3 + 6 of the SoloFlow pipeline in a single command. Runs `/soloflow:sprint` to the end of sprint verification, then runs `/soloflow:compound` on the just-finished sprint **before** the merge-choice prompt fires, then resumes sprint to the merge prompt + close. Compound's per-item commits land on the same run branch, so the merge-choice prompt at the end decides the fate of both the executed task work AND the applied learnings together — one decision, one branch.

Arguments: **$ARGUMENTS** (same as `/soloflow:sprint` — optional task IDs / `IDEA-NNN` filter, plus `--quick` / `--no-code-review` / `--no-verification` flags). Compound takes no arguments here — the just-finished sprint ID is captured from sprint's payload.

---

## Interleaved flow

```
Sprint  Steps 0.4 → 1.5   →  setup prompts (branching, scope, exec mode, dev-server)
        Steps 2 → 3.7      →  autonomous: execution + verify + sprint verifier
                              + sprint-code-reviewer (writes findings file)
        ↓
Compound Steps 0 → 5       →  reads findings, applies approved A/B/C items on the SAME
                              run branch. With compound.skeptic.auto_accept_verdicts: true,
                              A/B/C are fully autonomous; Bucket D (tester mode) always
                              prompts the user with its inline write-up. Compound's Step 6
                              report is suppressed — folded into the combined report below.
        ↓
Sprint   Step 4            →  human review for stuck / human-needed / deferred items
                              (only interactive if such tasks exist)
         Steps 4.4 → 4.6   →  merge-choice prompt → sprint-closer finalize → stop dev server
        ↓
Combined report            →  sprint stats + compound stats
```

**For maximum autonomy,** set `compound.skeptic.auto_accept_verdicts: true` in `.soloflow/config.json` (or via `/soloflow:config` → Operations → Compound). Compound's buckets A/B/C then apply without prompting. **Bucket D (tester-mode SoloFlow self-improvement feedback) always prompts the user** with its inline write-up — that channel is for a maintainer to read and must not be auto-archived. Without `auto_accept_verdicts`, compound's Step 3 still prompts per-bucket between sprint verification and the merge choice; the flow is correct but not autonomous.

---

## Step 1: Run sprint Phase A (Steps 0.4 → 3.7)

Mirror `commands/sprint.md` Steps 0.4 through 3.7 exactly — flag parsing, model + limits resolution, checkpoint/resume detection (Step 0.5), sprint initiation (Steps 1 → 2.8), the execute → verify → code-review loop (Step 3), end-of-sprint verification (Step 3.5), end-of-sprint code review (Step 3.6), and gather sprint-close context (Step 3.7). All interactive prompts in Step 1.5 still fire — those configure the sprint and are unrelated to the compound interleave.

Forward `$ARGUMENTS` verbatim to sprint's Step 0.4 flag parser. The same `--quick` / `--no-code-review` / `--no-verification` flags work identically here.

At the end of Step 3.7, the sprint-closer's `GATHERED` payload contains the sprint metadata. Capture from it:
- **`sprint.id`** → store as `SPRINT_ID` (e.g., `SPRINT-007`). Used as compound's `$ARGUMENTS` in Step 2 below.
- The full payload — Step 3 (resume sprint Phase B) replays it without re-spawning sprint-closer's gather phase.

**Exit signals (stop without running compound):**

- Sprint hit `CONTEXT_LIMIT` and the user picked **Save and exit** at the context-critical prompt → stop. Print: *"Sprint paused at context limit. Resume with `/soloflow:sprint`, then run `/soloflow:compound` separately once the sprint closes."*
- Sprint Step 3.7's gather phase returned `ERROR` → surface the error and stop. Do not retry.
- Any other unrecoverable error during sprint Steps 0.4 → 3.7 → stop with the error message. The sprint can be resumed via the existing checkpoint mechanism on re-invocation of `/soloflow:sprint`.

If sprint Steps 0.4 → 3.7 complete with no completed tasks AND no findings file entries, **still proceed to Step 2 below**. Compound's Step 1 will print "No completed tasks or findings to learn from." and stop cleanly; Step 3 (sprint Phase B) will then resume and fire the merge prompt as usual.

---

## Step 2: Run compound inline (Steps 0 → 5)

Mirror `commands/compound.md` Steps 0 through 5 exactly, with `$ARGUMENTS = SPRINT_ID` (the value captured in Step 1). This triggers compound's single-sprint path (compound.md Step 1b clause 1: `$ARGUMENTS == SPRINT-NNN` → `BATCH_SPRINTS = [SPRINT_ID]`), bypassing the multi-select picker.

The same model resolution, agent spawns (compounder → claude-md-reviewer → compound-skeptic → task-refiner), per-bucket logic, and atomic-commit rules apply unchanged. Compound's per-item commits land on the current run branch — they become part of the merge candidate.

**With `compound.skeptic.auto_accept_verdicts: true`:** buckets A/B/C bypass the AskUserQuestion flow (per compound.md Step 3's auto-accept short-circuit). Only Bucket D (tester mode) prompts the user during this step.

**Suppress compound's Step 6 report.** Do not print it here — capture the report content and fold it into the combined report at Step 4. Compound's Step 5 archive (move findings → archive/findings/, move proposal → archive/compound/) still runs and commits as usual.

If compound's Step 1 prints "No completed tasks or findings to learn from." and stops, that is **not** an error — proceed to Step 3.

---

## Step 3: Resume sprint Phase B (Steps 4 → 4.6)

Mirror `commands/sprint.md` Steps 4 through 4.6 exactly — Human Review (Step 4) with deferred-item resolution, merge-choice resolution (Step 4.4), sprint-closer finalize (Step 4.5), and stop sprint-managed dev server (Step 4.6).

The merge-choice prompt at Step 4.4 now decides the fate of both the executed task work AND compound's applied learnings together. If the user picks "Delete without merging," compound's commits are discarded along with the rest — which is the right semantic (discarded sprint → discarded learnings).

If sprint-closer's `COMPLETED` payload returns successfully, capture `merge.outcome` and any other fields sprint Step 5 normally uses for its report.

---

## Step 4: Combined report

Render sprint's Step 5 report block first (using the fields from sprint-closer's finalize output), followed by a separator, followed by the compound Step 6 report content captured in Step 2.

```
<sprint Step 5 report verbatim>

---

<compound Step 6 report verbatim>
```

Both reports are unchanged from their original commands — this command is purely additive on top of them.

---

## Notes

- Compound runs on the same run branch as the executed sprint. Per-item commits (clean-ups, CLAUDE.md edits, planned tasks) land in the merge candidate. The single merge-choice prompt at Step 4.4 decides their fate together with the task work.
- For maximum autonomy, enable `compound.skeptic.auto_accept_verdicts` in `.soloflow/config.json` (or via `/soloflow:config`). Buckets A/B/C then apply without prompting. Bucket D (tester mode) always prompts — its write-up is SoloFlow self-improvement feedback that must reach a maintainer before the sprint is closed.
- This command runs a single sprint at a time. To compound a backlog of prior pending sprints alongside this one, run `/soloflow:compound --all` separately after the merge.
- Sprint flags (`--quick` / `--no-code-review` / `--no-verification`) work here exactly as they do in `/soloflow:sprint`. Compound takes no flags from this command's `$ARGUMENTS`.

---

## Context Limit Self-Monitoring

This command runs in the main session. The context-monitor hook injects warnings when context usage is high.

When you receive a **SOLOFLOW CONTEXT WARNING**: finish the current step (the in-flight subagent interaction, then a checkpoint write if mid-sprint).

When you receive a **SOLOFLOW CONTEXT CRITICAL**: finish the current subagent interaction, write a checkpoint to `.soloflow/checkpoint.md`, then use **AskUserQuestion** with options:
- **Compact and continue** — let compaction happen, then resume from checkpoint. If the warning fired during Step 1 (sprint Phase A), resume via the sprint checkpoint path (sprint.md Step 0.5). If it fired during Step 2 (compound) or Step 3 (sprint Phase B), the user should re-invoke `/soloflow:compound SPRINT_ID` and then `/soloflow:sprint` to resume close.
- **Save and exit** — stop execution. The user can resume sprint via `/soloflow:sprint` and run `/soloflow:compound SPRINT_ID` separately afterward.
