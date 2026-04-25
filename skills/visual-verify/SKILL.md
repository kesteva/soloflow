---
name: visual-verify
description: This skill should be used when verifying UI changes visually. Prefers Maestro MCP when available, falls back to the Maestro CLI. Web verification uses Playwright MCP. Provides patterns for availability probes, path selection, ephemeral/inline flows, screenshot capture, and view hierarchy inspection.
version: 0.4.0
---

# Visual Verification

This skill provides patterns for visually verifying UI changes. For mobile, SoloFlow **prefers Maestro MCP** and automatically falls back to the **Maestro CLI** when MCP is unreachable. For web, it uses the **Playwright MCP** server (no CLI fallback).

Pick a path **once per verification run** — never mix MCP and CLI Maestro calls in the same run (both own port 7001; mixing causes contention).

## Dev-Server Preflight (mobile only)

Before any Maestro path selection or device probe, check whether the project's dev server (Metro for React Native, Vite for web app shells, etc.) is reachable. The most common reason a `visual_mobile` run produces nothing actionable is that Metro is offline — the dev-client launches into the Expo Dev Launcher screen and can't load the task's JS changes. The verifier used to discover this only after a full Maestro setup chain (MCP probe → simulator wakefulness → device pick → screenshot), then emit a generic "Metro bundler offline" finding per task. Short-circuit that here with a single config-driven probe.

Run:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/sprint/probe-dev-server.js" --probe-only
```

Parse the JSON `online` field:

- **`{ "online": null, "skipped": true }`** — `verification.dev_server.enabled` is `false`. The preflight is opt-in; **continue to Path Selection** below. Existing behavior unchanged.
- **`{ "online": true }`** — dev server reachable. **Continue to Path Selection.**
- **`{ "online": false, ... }`** — dev server offline. **Stop immediately:**
  - Emit `visual_mobile: skipped_metro_offline` in the verification result (replaces the old `skipped_unable` for this specific failure mode — surfaces in done-report frontmatter and rolls up in sprint-closer's per-task mobile bucket).
  - Single-line note for the result: `{name} unreachable at {probe_url} — start it (e.g., \`npx expo start --dev-client\`) before running visual verification.` (read `name` and `probe_url` from `verification.dev_server` config or rerun the probe without `--probe-only` to get them).
  - **Do NOT proceed** to MCP availability check, simulator wakefulness, device pick, app launch, or screenshot capture. Aborting at this point saves ~3-5 tool calls per task.
  - The verifier agent's caller will route this skip to the end-of-sprint visual audit (one structured skip per task — no duplicate FIND entries spawned per Maestro setup attempt; see compound finding D1, SPRINT-026).

This preflight runs **only on the visual_mobile path**. The web (Playwright) path has its own availability section below and does not depend on the dev server (Playwright launches its own browser).

## Path Selection (once per run)

Before running any mobile verification, probe which path to use and record the decision for the rest of the run:

1. **Check `mcp__maestro__*` availability.** If the tool surface is bound to this session (your available-tools list contains `mcp__maestro__list_devices`, `mcp__maestro__run_flow`, etc.) AND a lightweight call succeeds, set `USE_MAESTRO_MCP=true`.
   - Lightweight probe: call `mcp__maestro__list_devices`. It returns quickly and surfaces any device/automation problems up-front.
   - If the tool is unbound (not in your allowlist) OR the probe errors, set `USE_MAESTRO_MCP=false` and continue to step 2.
2. **Check CLI fallback.** Run `which maestro` via Bash. If found, probe for a booted device:
   ```bash
   IOS=$(xcrun simctl list devices booted 2>/dev/null | grep -c Booted || true)
   AND=$(adb devices 2>/dev/null | awk '$2=="device"' | wc -l | tr -d ' ' || true)
   ```
   If at least one device is booted, use the **Maestro CLI Patterns (fallback)** section below.
3. **Neither available.** Report `skipped_unable` with reason "mcp__maestro__* not bound and CLI not installed / no device booted" and proceed. (The verifier agents know to escalate this via the config-gap recipe.)

Why the single-decision model: `maestro mcp` (the MCP server) and `maestro test` (the CLI) both bind port 7001. Switching paths mid-run — or running an MCP call while a CLI call is in flight — causes unpredictable failures. Choose the path up front and stay on it.

## Playwright (Web) Availability

Playwright has no CLI fallback.

1. Run `which npx` via Bash. If not found, skip web verification.
2. Attempt a lightweight `mcp__playwright__*` probe (e.g., a noop `browser_install` check). If the MCP server is unreachable, skip web verification.

## Maestro MCP Patterns (primary)

All MCP interactions go through `mcp__maestro__*` tools. Most interaction tools require a `device_id` you obtain from `list_devices` or `start_device`.

### Device setup

```
mcp__maestro__list_devices()
  → returns an array of devices (iOS simulators, Android emulators, physical devices).
```

Pick the first booted device's `device_id`. If none are booted, call `mcp__maestro__start_device` (optionally passing `platform: "ios"` or `"android"`) to boot one and capture the returned `device_id`.

Cache this `device_id` locally for the rest of the run — every subsequent call needs it.

### Element Presence — `inspect_view_hierarchy`

```
mcp__maestro__inspect_view_hierarchy(device_id)
  → returns the current screen's hierarchy as CSV (≈50 tokens — much cheaper than the CLI's plain-text dump at 200–600 tokens).
```

Use this for: confirming buttons exist, checking text content, verifying layout structure, reading accessibility labels.

### Screen Capture — `take_screenshot`

Screenshots only when acceptance criteria require checking visual appearance (colors, images, animations, styling).

```
mcp__maestro__take_screenshot(device_id)
  → returns a screenshot image.
```

Cap at resolved `verification.visual_screenshot_budget` (fallback: 3) screenshots per run to manage token cost. Resolve per the recipe in [docs/CUSTOMIZATION.md#config-resolution](../../docs/CUSTOMIZATION.md).

### Flow Execution — `run_flow_files` (preferred for existing flows)

Runs one or more pre-written Maestro YAML flow files.

```
mcp__maestro__run_flow_files(device_id, flow_files=["maestro/signin-happy-path.yaml"], env={...})
  → returns execution results (pass/fail per step with messages).
```

Resolve `verification.visual_maestro_flow_dirs` per the config recipe (fallback: `["maestro/", ".maestro/", "test/maestro/"]`) and discover flow files with Glob, then pass matching paths.

### Ad-hoc Navigation — `run_flow` (inline YAML)

The MCP replacement for the CLI's ephemeral-flow pattern. Pass the YAML body directly — no tmp file, no `rm` cleanup.

```
mcp__maestro__run_flow(
  device_id,
  flow_yaml="appId: com.example.myapp\n---\n- launchApp\n- tapOn: \"Sign In\"\n- inputText: \"test@example.com\"\n- tapOn: \"Continue\"",
  env={...}
)
```

After landing on the target screen, call `inspect_view_hierarchy` (or `take_screenshot`) to verify state.

**`appId` resolution order** (same as CLI):
1. Read `verification.visual_mobile_app_id` from `.soloflow/config.json`.
2. If null/missing, grep existing flows in `verification.visual_maestro_flow_dirs` for the first `appId:` line:
   ```bash
   grep -h '^appId:' maestro/*.yaml .maestro/*.yaml test/maestro/*.yaml 2>/dev/null | head -1
   ```
3. Else skip with `skipped_unable` and message: "cannot determine appId; set `verification.visual_mobile_app_id` or add a Maestro flow with `appId`."

### Interaction Primitives (when composing manually rather than via `run_flow`)

- `mcp__maestro__launch_app(device_id, appId)` — start the app.
- `mcp__maestro__tap_on(device_id, text=..., id=..., index=..., use_fuzzy_matching=...)` — tap. Supports fuzzy match, index disambiguation, and state filters (`enabled`, `checked`, `focused`, `selected`).
- `mcp__maestro__input_text(device_id, text)` — type into the focused field.
- `mcp__maestro__back(device_id)` — back button.
- `mcp__maestro__stop_app(device_id, appId)` — stop the app.

Prefer `run_flow` for multi-step sequences — it's serialized correctly by Maestro and captures better failure context than composing individual MCP calls.

### Diagnostics

- `mcp__maestro__check_flow_syntax(flow_yaml)` — validate a YAML flow before running it. Useful when constructing ad-hoc flows.
- `mcp__maestro__cheat_sheet()` — returns the Maestro command cheat sheet. Refresh recall when needed.
- `mcp__maestro__query_docs(question)` — ask the Maestro docs a natural-language question.

**Animations.** Include `waitForAnimationToEnd` inside flows you pass to `run_flow` / `run_flow_files`, or insert a brief wait before capturing hierarchy/screenshots — otherwise you may capture a mid-transition frame.

## Maestro CLI Patterns (fallback)

Use only when the MCP probe in **Path Selection** failed. All CLI verification is invoked via Bash. The CLI talks to an already-booted iOS simulator or Android emulator via `idb_companion` / `adb`.

### Element Presence — `maestro hierarchy`

`maestro hierarchy` dumps the current view hierarchy as plain text (~200–600 tokens depending on screen complexity — more expensive than the MCP's CSV, still cheaper than screenshots).

```bash
maestro hierarchy > /tmp/sf-maestro-hier-$$.txt
# Then Read the file (or pipe through grep for specific testIDs/labels)
```

Use this for: confirming buttons exist, checking text content, verifying layout structure, reading accessibility labels.

### Screen Capture

Screenshots only when acceptance criteria require checking visual appearance that hierarchy data cannot answer: colors, images, animations, visual styling.

**iOS simulator:**
```bash
SHOT=$(mktemp /tmp/sf-shot-XXXXXX.png)
xcrun simctl io booted screenshot "$SHOT"
sips -Z 1400 "$SHOT" > /dev/null
# Then Read $SHOT as an image
```

**Android emulator:**
```bash
SHOT=$(mktemp /tmp/sf-shot-XXXXXX.png)
adb exec-out screencap -p > "$SHOT"
sips -Z 1400 "$SHOT" > /dev/null   # or: convert "$SHOT" -resize 1400x "$SHOT" on Linux
# Then Read $SHOT as an image
```

Downsizing to 1400px longest edge keeps the image readable while managing token cost.

**Multi-booted iOS:** If `xcrun simctl list devices booted | grep -c Booted` returns ≥2, `booted` errors with "multiple booted devices." Pick the first UDID explicitly:
```bash
UDID=$(xcrun simctl list devices booted | awk -F'[()]' '/Booted/{print $2; exit}')
xcrun simctl io "$UDID" screenshot "$SHOT"
```

Cap at resolved `verification.visual_screenshot_budget` screenshots per verification run (fallback: 3).

### Flow Execution — `maestro test`

```bash
maestro test maestro/signin-happy-path.yaml
echo "exit=$?"
```

Exit code `0` = all steps passed. Non-zero = a step failed; stdout/stderr identifies which step and why.

List available flows with Glob, then match flow names to the feature being verified. If a relevant flow exists, prefer it over ad-hoc verification — flows are repeatable and maintained by the project.

### Ad-hoc Navigation — Ephemeral Flow Pattern

The CLI has no one-shot command for individual taps/inputs. Ad-hoc interactions use an ephemeral YAML written to a tmp path, executed with `maestro test`, then discarded. (The MCP's `run_flow` avoids this dance — this pattern is the fallback.)

```bash
FLOW=$(mktemp /tmp/sf-maestro-XXXXXX.yaml)
cat > "$FLOW" <<'EOF'
appId: com.example.myapp
---
- launchApp
- tapOn: "Sign In"
- inputText: "test@example.com"
- tapOn: "Continue"
EOF
maestro test "$FLOW" 2>&1 | tee /tmp/sf-maestro-last.log
EXIT=$?
rm -f "$FLOW"
```

After the ephemeral flow lands the app on the target screen, run `maestro hierarchy` (or a screenshot) to verify state.

**`appId` resolution order** — same as the MCP path (see above).

## Playwright Patterns (Web)

### Page Verification
1. Navigate to the relevant URL
2. Check element visibility and text content
3. Read page content to verify data rendering
4. Execute JavaScript if needed for dynamic checks

### Visual Capture
Take screenshots only when visual appearance must be verified. For content and structure checks, reading page content is more token-efficient.

## Token Budget Strategy

Prefer cheaper operations first:

| Operation | Path | Approx tokens |
|---|---|---|
| `mcp__maestro__inspect_view_hierarchy` | MCP | ~50 (CSV) |
| `maestro hierarchy` | CLI | ~200–600 (plain text) |
| Page content read (web) | — | variable |
| Screenshot (any path, after sizing) | MCP/CLI | ~1600 |

A typical verification should use 1–2 hierarchy inspections and at most `verification.visual_screenshot_budget` screenshots (default 3). If you find yourself taking more screenshots, reconsider whether hierarchy data or page content would suffice. MCP hierarchy is roughly 4–10× cheaper than CLI hierarchy — one concrete reason MCP is the preferred path.

## Serialization Rules

- **Never mix Maestro MCP and CLI calls in a single verification run.** Both bind port 7001; concurrent use produces unpredictable failures. Path Selection picks one path for the whole run.
- **Within a single path, serialize against the same device.** `maestro test` and `maestro hierarchy` hold a device lock via `idb_companion`; the MCP server holds the same lock. Don't run two Maestro operations in parallel against the same device — even through different tool calls.

## Mapping Results to Criteria

Every visual check must map to a specific acceptance criterion from the task plan. Structure your findings as:
- **Criterion:** "{what was being checked}"
- **Method:** MCP `inspect_view_hierarchy` / MCP `run_flow` / MCP screenshot / CLI hierarchy / CLI `maestro test` / screenshot / Playwright navigation
- **Result:** PASS or FAIL with specific evidence
