# Customization

## Configuration Overview

`config/defaults.yaml` documents all configurable values. Most of these values are embedded directly in agent definitions (`.md` files) and hook scripts (`.js` files) — the config file is not read at runtime for those. To customize behavior, edit the relevant source file directly.

A small number of values **are** runtime-read (noted explicitly below). For those, you can override the plugin default per-project by creating `.soloflow/config.json`:

```json
{
  "verification": {
    "visual_mobile": true,
    "visual_web": false
  },
  "git": {
    "branch_per_run": "always"
  }
}
```

Runtime-read resolution order: project `.soloflow/config.json` → plugin `config/defaults.yaml` → built-in fallback.

The easiest way to populate `.soloflow/config.json` is to run `/soloflow:init` — it's idempotent and includes a short setup wizard that asks about visual verification and branching preferences, then writes the config for you.

## Model Assignments

```yaml
models:
  verifier: opus           # agents/verifier.md
  executor: sonnet         # agents/soloflow:executor.md
  idea_extractor: sonnet   # agents/soloflow:idea-extractor.md
  task_refiner: opus       # agents/task-refiner.md
  compounder: sonnet       # agents/compounder.md
```

To change an agent's model, edit the `model:` field in its YAML frontmatter. For example, use Opus for the executor on architecturally complex tasks where implementation quality matters more than cost.

## Limits

| Setting | Default | Where Used | Description |
|---------|---------|------------|-------------|
| `executor_retry_max` | 3 | `commands/soloflow:executor.md`, `commands/soloflow:quick.md` | Max executor→verifier loops before marking a task as stuck |
| `analysis_paralysis_threshold` | 5 | `agents/soloflow:executor.md` | Consecutive read-only tool calls before the executor is forced to write code |
| `checkpoint_interval` | 3 | `commands/soloflow:executor.md` | Tasks completed between progress checkpoints |
| `max_sprint_tasks` | 10 | `commands/soloflow:executor.md` | Maximum tasks in a single execution sprint |

## Verification Toggles

| Setting | Default | Where Used | Description |
|---------|---------|------------|-------------|
| `run_tests` | true | `hooks/task-completed.js` | Run test suite as quality gate |
| `run_typecheck` | true | `hooks/task-completed.js` | Run type checker as quality gate |
| `run_linter` | true | `hooks/post-tool-use.js` | Auto-lint after Write/Edit |
| `verification.visual_mobile` | false | `agents/verifier.md` | Enable Maestro MCP visual verification for mobile. **Runtime-read** — overrideable via `.soloflow/config.json` or set by `/soloflow:init` wizard. |
| `verification.visual_web` | false | `agents/verifier.md` | Enable Playwright MCP visual verification for web. **Runtime-read** — overrideable via `.soloflow/config.json` or set by `/soloflow:init` wizard. |

To enable visual verification:

1. Set `visual_mobile: true` or `visual_web: true` in the verifier agent's instructions
2. Configure MCP servers (see [Visual Verification Setup](VISUAL-VERIFICATION-SETUP.md))
3. Ensure Maestro CLI or Playwright is installed in your project

## Visual Verification Settings

```yaml
visual_maestro_flow_dirs:       # Directories the verifier searches for Maestro flows
  - maestro/
  - .maestro/
  - test/maestro/
visual_screenshot_budget: 3     # Max screenshots per verification run
visual_prefer_hierarchy: true   # Use inspect_view_hierarchy (~50 tokens) before screenshots (~1600 tokens)
```

These are referenced in `agents/verifier.md` and `skills/visual-verify/SKILL.md`.

## Git Branching (runtime-read)

| Setting | Default | Where Used | Description |
|---------|---------|------------|-------------|
| `git.branch_per_run` | `prompt` | `commands/executor.md` | Whether `/soloflow:executor` runs each invocation on a dedicated branch that gets merged after human review. Values: `always`, `never`, `prompt` |
| `git.branch_name_format` | `soloflow/run-{timestamp}-{sprint_id}` | `commands/executor.md` | Format string for the run branch name |
| `git.merge_strategy` | `--no-ff` | `commands/executor.md` | Flag passed to `git merge` when merging the run branch back |

These ARE runtime-read. Override per-project by creating `.soloflow/config.json`:

```json
{ "git": { "branch_per_run": "always" } }
```

When set to `prompt` (the default), `/soloflow:executor` asks at the start of each run. Choosing "remember this choice" in the prompt writes `always` to `.soloflow/config.json` for you.

## Adding Maestro Flows

The verifier discovers and runs Maestro YAML flows from the directories listed in `visual_maestro_flow_dirs`. To add flows for your project:

1. Create a `maestro/` directory in your project root
2. Write YAML flows following the [Maestro documentation](https://maestro.mobile.dev)
3. The verifier will discover and use them during visual verification

