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
| `models.verifier` | `opus` | `agents/verifier.md` |
| `models.executor` | `sonnet` | `agents/executor.md` |
| `models.idea_extractor` | `sonnet` | `agents/idea-extractor.md` |
| `models.task_refiner` | `opus` | `agents/task-refiner.md` |
| `models.compounder` | `sonnet` | `agents/compounder.md` |
| `models.researcher` | `sonnet` | `agents/researcher.md` |
| `models.code_reviewer` | `opus` | `agents/code-reviewer.md` |
| `models.roadmap_researcher` | `sonnet` | `agents/roadmap-researcher.md` |
| `models.roadmap_generator` | `opus` | `agents/roadmap-generator.md` |
| `models.sprint_initiator` | `sonnet` | `agents/sprint-initiator.md` |

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

### Code review

| Setting | Default | Description |
|---|---|---|
| `code_review.enabled` | `true` | Spawn a code-reviewer subagent after executor+verifier pass |
| `code_review.run_simplify` | `true` | Run the `/simplify` skill inside code review |
| `code_review.run_security_review` | `true` | Run the `/security-review` skill inside code review |
| `code_review.review_retry_max` | 1 | Separate retry budget for code-review fixes |

### Verification

| Setting | Default | Description |
|---|---|---|
| `verification.run_tests` | `true` | Test suite as Level-1 quality gate |
| `verification.run_typecheck` | `true` | Type checker as Level-1 quality gate |
| `verification.run_linter` | `true` | Auto-lint after Write/Edit |
| `verification.visual_mobile` | `false` | Enable Maestro MCP visual verification (mobile) |
| `verification.visual_web` | `false` | Enable Playwright MCP visual verification (web) |
| `verification.visual_maestro_flow_dirs` | `["maestro/", ".maestro/", "test/maestro/"]` | Dirs searched for Maestro flows |
| `verification.visual_screenshot_budget` | 3 | Max screenshots per verification run |
| `verification.visual_prefer_hierarchy` | `true` | Prefer `inspect_view_hierarchy` (~50 tokens) over `take_screenshot` (~1600 tokens) |

See [VISUAL-VERIFICATION-SETUP.md](VISUAL-VERIFICATION-SETUP.md) for dependency + MCP setup.

### Git

| Setting | Default | Description |
|---|---|---|
| `git.branch_per_run` | `prompt` | `/soloflow:executor` runs on a dedicated branch. Values: `always`, `never`, `prompt` |
| `git.branch_name_format` | `soloflow/run-{timestamp}-{sprint_id}` | Run branch name format string |
| `git.merge_strategy` | `--no-ff` | Flag passed to `git merge` when merging the run branch back |

When `git.branch_per_run` is `prompt`, `/soloflow:executor` asks at the start of each run; picking "remember this choice" writes `always` or `never` to `.soloflow/config.json` for you.

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

## Adding Maestro flows

The verifier discovers and runs Maestro YAML flows from the directories listed in `verification.visual_maestro_flow_dirs`. To add flows:

1. Create a `maestro/` directory in your project root.
2. Write YAML flows following the [Maestro documentation](https://maestro.mobile.dev).
3. The verifier discovers them automatically during visual verification.
