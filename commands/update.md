---
description: Check for SoloFlow updates, run pending state migrations, and show the right install command
allowed-tools: [Read, Bash, AskUserQuestion]
model: sonnet
---

# /soloflow:update

Check whether a newer version of SoloFlow is available, surface any pending
state migrations and (with explicit confirmation) apply them, and tell the
user how to install a newer SoloFlow if one exists. **This command never
runs the soloflow code update itself** — `/plugin update` (plugin install)
or `bash update.sh` (script install) is user-driven. Migrations to
project-local `.soloflow/` state are the one mutation the command will
perform, gated on an explicit `AskUserQuestion` confirmation.

---

## Step 1: Refresh the version cache

Run via Bash:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/update/check-version.js" --force
```

Parse the JSON line on stdout. Fields you care about:
- `current_version`
- `latest_version`
- `update_available`

If stdout is empty (`{}`) or missing fields, treat it as "could not check"
and remember a single warning line:

```
Could not check for updates (network error or version unresolvable).
Try again later, or visit https://github.com/kesteva/soloflow for the
current version.
```

Print the warning and continue to Step 2 — migration status is independent
of the version check.

## Step 2: Check for pending state migrations

State migrations live under `${CLAUDE_PLUGIN_ROOT}/scripts/migrations/`.
They are project-local: each one reads/writes the current project's
`.soloflow/` and is idempotent. The `run-all.js` orchestrator walks every
migrator in number order and reports what is pending.

1. Run via Bash, from the project root (the slash command's default cwd):

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/migrations/run-all.js"
   ```

2. Parse the JSON output. Field shape:
   - `total_pending` — integer count of migrators whose dry run produced changes.
   - `migrators[]` — per-migrator `{ id, pending, summary }`.

3. **If `total_pending === 0`**: print `No pending state migrations.` and proceed to Step 3.

4. **If `total_pending > 0`**: print a one-paragraph summary. For each pending
   migrator, print one line of the form `- <id>: <one-line excerpt of summary>`
   where the excerpt is the first non-empty line of the migrator's `summary`
   (the JSON dry-run block, or the sentinel line, whichever is present).

5. Use **AskUserQuestion** with one question:
   - **Question:** `"Apply these state migrations now? (Migrators are idempotent and write a state-version stamp; .soloflow/ is the only thing that gets touched.)"`
   - **Header:** `"Apply migrations"`
   - **Options:**
     1. `"Yes — apply"` *(label `(Recommended)` when `total_pending` matches a
        known schema bump from a recent release)*
     2. `"Skip"`

   The tool blocks until the user responds.

6. **On Yes — apply:**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/migrations/run-all.js" --apply
   ```

   Parse the JSON. For each entry in `applied[]` print one line:
   - `applied` → `✓ <id>: applied`
   - `skipped_no_op` → (omit; we already filtered these)
   - `failed` → `✗ <id>: failed (exit code <N>)` plus the captured stderr below.

   If any migrator failed, the orchestrator exits non-zero and surfaces
   `bailed: true` in its JSON. Stop here in that case — print the failure
   detail and ask the user to fix the underlying issue before retrying.

7. **On Skip:**

   ```
   Skipped state migrations. Re-run /soloflow:update or invoke
   `node scripts/migrations/run-all.js --apply` directly when you're ready.
   ```

   Continue to Step 3.

## Step 3: If already up to date

If the Step 1 fetch succeeded and `update_available` is `false`:

```
SoloFlow is up to date (v<current_version>).
```

Stop here — no code update needed.

## Step 4: If an update is available

Detect install type via Bash:

```bash
test -f .claude/soloflow-install/VERSION && echo "script" || echo "plugin"
```

Print a header:

```
SoloFlow v<current_version> → v<latest_version> is available.
```

Then, **best-effort**, fetch a CHANGELOG snippet for the new version:

```bash
curl -fsS --max-time 3 https://raw.githubusercontent.com/kesteva/soloflow/main/CHANGELOG.md \
  | awk -v v="<latest_version>" '
      $0 ~ "^## \\[" v "\\]" { p=1; print; next }
      p && /^## \[/ { exit }
      p { print }
    '
```

If the snippet is non-empty, display it under a `### What's new` heading. If
the curl fails or the snippet is empty, skip this section silently.

## Step 5: Show the right install command

**Plugin install** (no `.claude/soloflow-install/VERSION` present):

```
To update, run inside Claude Code:

    /plugin update soloflow@soloflow

(Claude can't invoke `/plugin` commands for you — please type the command
yourself.)
```

**Script install** (`.claude/soloflow-install/VERSION` exists):

```
To update, run from your shell:

    git -C /tmp/soloflow pull || git clone https://github.com/kesteva/soloflow /tmp/soloflow
    bash /tmp/soloflow/scripts/update.sh "$(pwd)"

This re-runs the vendored installer against this project. `.soloflow/` state
is not touched.
```

## Step 6: Do not execute the soloflow code update

Do not run `/plugin update`, `bash update.sh`, or any other soloflow code
update command on behalf of the user. Display the command from Step 5 and
stop. Even if the user follows up with "go ahead" in this turn, ask them to
run it themselves — Claude can't restart its own plugin runtime, and the
script-install path needs the user to choose where to clone the source.

(The migration step in Step 2 is the ONE authorized mutation this command
performs, and only after the user explicitly answered "Yes — apply".)
