---
name: clarify-roadmap
description: Deep conversational questioning to build a project roadmap brief before research and epic generation. Provides an 8-point checklist, scope-decomposition gate, one-question-at-a-time probing, and a readiness gate.
version: 0.1.0
---

# Clarify Roadmap

This skill encodes a deep conversational clarification loop to run **before** roadmap research and generation, when the user provides a high-level project vision that needs structured decomposition. It is **instructional** -- the calling command drives the loop using its own `AskUserQuestion` tool. This skill does not spawn subagents.

## When to invoke

Apply this checklist to the raw input. If **any** item is missing or unclear, invoke the loop:

- **Vision** -- what does the finished product/system look like? What problem does it solve?
- **Target users** -- who are the primary users? What are their key pain points?
- **Constraints** -- budget, timeline, team size, regulatory requirements, platform requirements, existing commitments
- **Success metrics** -- how will the user measure success? (adoption, revenue, performance, user satisfaction, etc.)
- **Technical preferences** -- preferred stack, hosting, existing infrastructure to integrate with
- **Scope boundary** -- what is explicitly out of scope for this roadmap?
- **Phasing priorities** -- what needs to ship first? Are there hard deadlines for any phase?
- **Risk tolerance** -- appetite for new/unproven tech vs. battle-tested? Tolerance for shipping incrementally vs. all-at-once?

If all eight are present, **skip this skill** and proceed directly to research. Running the loop on an already-clear input is a cost, not a benefit.

Opt-out signals the caller must honor:
- `--skip-clarify` anywhere in the arguments
- `config.phases.roadmap_clarify === false` in `.soloflow/config.json` or `config/defaults.yaml`

## Anti-pattern

> "The user already knows what they want."

A roadmap shapes months of work. The checklist is the judge, not your intuition. Cheap to run, expensive to skip.

## Scope-decomposition gate (runs first)

If the input spans **multiple independent products** (e.g., "build a marketplace AND a separate analytics dashboard AND a mobile companion app"), stop immediately. Do NOT begin clarification on the whole thing.

Use `AskUserQuestion`:
- **Question:** "This vision covers multiple independent products. Which one do you want to roadmap first?"
- **Header:** "Pick one"
- **Options:** one per detected product, plus a free-form "something else" fallback.

Roadmap only the selected product. The others can be roadmapped separately later.

Note: Unlike `clarify-idea`, which decomposes subsystems, this gate decomposes at the **product** level. A single product with multiple subsystems is fine -- the roadmap generator will phase those into epics.

## Clarification loop

Rules (hard):

1. **One `AskUserQuestion` at a time.** Never batch clarification questions. Each answer informs the next question.
2. **Prefer multiple-choice.** Offer 2-4 concrete, mutually distinct candidate answers, plus the built-in free-form fallback the tool provides. Avoid open-ended prompts unless the space is genuinely unbounded (e.g., "describe your vision").
3. **Follow threads.** An answer may reveal a new ambiguity -- follow it. Examples:
   - "We want real-time features" -> "What kind of real-time? Live collaboration, notifications, or data streaming?"
   - "We need it done fast" -> "What's the hard deadline? And what's the team size?"
   - "We're targeting enterprise" -> "What compliance requirements? SOC2, HIPAA, GDPR?"
4. **Lightweight research is allowed, not required.** One targeted `WebSearch` for unfamiliar domain terms or stack questions is fine to frame better candidate answers. Never use research as a substitute for asking the user.
5. **Do not propose epics, phases, or architecture.** This skill only captures the vision and constraints. Structuring is the roadmap-generator's job.
6. **Probe for priorities.** When the user lists multiple goals, always ask which matters most. A roadmap without priorities is a wishlist.

Keep going until the checklist at the top of this file is satisfied -- every item has a clear answer.

## Readiness gate (HARD-GATE)

Once you believe the checklist is satisfied, present an explicit confirmation via `AskUserQuestion`:

- **Question:** "I have a clear picture of your vision, constraints, and priorities. Ready to generate the roadmap?"
- **Header:** "Ready?"
- **Options:**
  - "Generate roadmap" -- proceed
  - "Keep clarifying" -- loop returns to the clarification loop
  - "Cancel" -- abort; caller stops without writing anything

**You MUST NOT proceed to research/generation until "Generate roadmap" is selected.** This is a hard gate -- the anti-pattern is declaring readiness yourself and skipping the user confirmation.

If the user picks "Keep clarifying," return to the clarification loop. There is no retry limit; loop until the user confirms.

## Output: roadmap brief

When the gate passes, produce a **roadmap brief** in this exact shape and hand it to the caller:

```markdown
## Raw Input

{Verbatim $ARGUMENTS the user passed in}

## Clarification Transcript

- Q: {question 1}
  A: {user answer 1}
- Q: {question 2}
  A: {user answer 2}
{...}

## Synthesis

### Vision
{One paragraph restating what the finished product looks like and why it matters}

### Target Users
{Who they are, their pain points, what success looks like for them}

### Constraints
{Timeline, budget, team, platform, regulatory -- everything that bounds the solution space}

### Success Metrics
{How success will be measured, in order of priority}

### Technical Preferences
{Stack, hosting, integrations, non-negotiable tech choices}

### Scope Boundary
{What is explicitly out of scope}

### Phasing Priorities
{What ships first and why, hard deadlines if any}

### Risk Tolerance
{New tech appetite, incremental vs big-bang shipping preference}
```

The Synthesis sections are canonical. The raw input and transcript are context only.

## Reuse

This skill is designed to be invoked by `/soloflow:roadmap`. It could also be reused by any future command that needs deep project-level questioning before planning.
