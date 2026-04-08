# Customization

## Configuration Overview

`config/defaults.yaml` documents all configurable values. These values are embedded directly in agent definitions (`.md` files) and hook scripts (`.js` files) — the config file is not read at runtime. To customize behavior, edit the relevant source file directly.

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
| `visual_mobile` | false | `agents/verifier.md` | Enable Maestro MCP visual verification for mobile |
| `visual_web` | false | `agents/verifier.md` | Enable Playwright MCP visual verification for web |

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

## Adding Maestro Flows

The verifier discovers and runs Maestro YAML flows from the directories listed in `visual_maestro_flow_dirs`. To add flows for your project:

1. Create a `maestro/` directory in your project root
2. Write YAML flows following the [Maestro documentation](https://maestro.mobile.dev)
3. The verifier will discover and use them during visual verification

