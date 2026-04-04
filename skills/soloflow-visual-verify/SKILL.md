---
name: soloflow-visual-verify
description: This skill should be used when verifying UI changes visually using Maestro MCP (mobile) or Playwright MCP (web). Provides patterns for availability checks, screenshot comparison, view hierarchy inspection, and automated visual testing flows.
version: 0.2.0
---

# Visual Verification

This skill provides patterns for visually verifying UI changes using Maestro MCP (mobile apps) and Playwright MCP (web apps).

## Availability Checks

Always verify tools are installed before attempting MCP interactions.

**Maestro:**
1. Run `which maestro` via Bash. If not found, Maestro is not installed — skip mobile verification.
2. Attempt `inspect_view_hierarchy` as a probe call. If the MCP server is not running or returns an error, skip mobile verification.

**Playwright:**
1. Run `which npx` via Bash. If not found, Playwright cannot run — skip web verification.
2. Attempt a simple navigation as a probe. If the MCP server is not running, skip web verification.

If a tool is not available, report clearly: "Visual verification skipped — [tool] not installed / MCP server not available." Do not treat this as a failure.

## Maestro Patterns (Mobile)

### Element Presence Check
Use `inspect_view_hierarchy` to check whether elements exist on screen. This returns structured data at ~50 tokens — far cheaper than a screenshot (~1600 tokens).

Use this for: confirming buttons exist, checking text content, verifying layout structure, reading accessibility labels.

### Screen Capture
Use `take_screenshot` only when acceptance criteria require checking visual appearance that hierarchy data cannot answer: colors, images, animations, visual styling.

Limit screenshots to 3 per verification run to manage token budget.

### Flow Execution
Use `run_flow` to execute pre-written Maestro YAML flows. Search the project for flows in these conventional directories:
- `maestro/`
- `.maestro/`
- `test/maestro/`

List available flows with Glob, then match flow names to the feature being verified. If a relevant flow exists, prefer it over ad-hoc verification — flows are repeatable and maintained by the project.

### Navigation
1. `launch_app` — start the app in the simulator
2. `tap_on` — navigate by tapping elements (use testID when available)
3. `input_text` — enter text into fields
4. Combine navigation steps to reach the screen under test

### Port Conflict
Maestro MCP and `maestro test` (CLI) both use port 7001. Never run both simultaneously. When using MCP tools for verification, do all Maestro interactions through MCP — do not shell out to `maestro test`.

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
1. **`inspect_view_hierarchy`** (~50 tokens) — for element presence, layout, accessibility
2. **Page content reading** (variable) — for text content, data verification
3. **`take_screenshot`** (~1600 tokens) — only for visual appearance checks

A typical verification should use 1-2 hierarchy inspections and at most 3 screenshots. If you find yourself taking more screenshots, reconsider whether hierarchy data or page content would suffice.

## Mapping Results to Criteria

Every visual check must map to a specific acceptance criterion from the task plan. Structure your findings as:
- **Criterion:** "{what was being checked}"
- **Method:** hierarchy inspection / screenshot / flow execution
- **Result:** PASS or FAIL with specific evidence
