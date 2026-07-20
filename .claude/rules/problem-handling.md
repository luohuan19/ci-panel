# Problem Handling and Known Issues Tracking

## Core Principle

**When encountering technical problems, classify them as blocking or non-blocking and act accordingly.** Never silently work around, ignore, or make assumptions about technical problems.

```text
Technical problem encountered
├─ Does it block the current task?
│  ├─ YES → Stop. Inform the user. Wait for their decision before continuing.
│  └─ NO  → Log to KNOWN_ISSUES.md. Continue with the current task.
```

## Blocking Problems

**A problem is blocking when you cannot make meaningful progress on the current task without resolving it.**

Examples: a build or type-check failure that prevents verification, ambiguous requirements, an API behaving differently than documented, a daemon/panel protocol mismatch that may mean your change is wrong, missing information needed to complete the task.

**What to do:**

1. **Stop** — do not attempt workarounds or make assumptions
2. **Describe the problem clearly** — what happened, what you expected, and why it blocks progress
3. **Present options** — lay out possible paths forward with trade-offs
4. **Wait for the user's decision** — do not pick an option and continue on your own

**When unsure if blocking:** err on the side of asking — a brief question costs less than a wrong assumption. If the problem might affect correctness, treat it as blocking.

## Non-Blocking Problems (Known Issues)

**A problem is non-blocking when you can complete the current task correctly despite the issue.** Log it to `KNOWN_ISSUES.md` at the repository root and continue.

### When to Log

- Unexpected behavior, crashes, or errors in the panel, daemon, or frontend
- Code defects discovered while reading or modifying code
- Build or dependency quirks (remember: each package installs separately, there are no npm workspaces)
- API inconsistencies between panel and daemon, or missing input validation
- Missing i18n keys or hardcoded user-facing strings found incidentally
- Documentation inaccuracies found incidentally

**Do NOT log:** issues you are actively fixing, limitations already documented in `README.md` / `DEVELOPMENT.md`, or user misconfigurations.

### File Format

`KNOWN_ISSUES.md` only contains **unresolved** issues. Resolved issues are removed entirely.

```markdown
# Known Issues

## [Short Title]

- **Date**: YYYY-MM-DD
- **Found during**: [brief context of what task you were working on]
- **Description**: [actual behaviour, expected behaviour, why it matters]
- **Example / Repro**: [smallest artefact that surfaces the issue — see "Entry Quality" below; use `N/A` only for purely descriptive issues]
- **Location**: [file path(s) and line number(s) if applicable]
- **Severity**: low | medium | high

---
```

### Entry Quality

Each entry must be **self-contained** — a future reader (you in two months, or the user filing it as a GitHub issue) should understand the problem without re-deriving it from memory.

- **Description**: name the actual vs. expected behaviour and the consequence. ✅ "The file-upload route does not validate the target path, so a `../` segment escapes the instance directory" beats ❌ "Upload route has a bug".
- **Example / Repro**: include the smallest concrete artefact that surfaces the issue. Pick whichever fits:
  - The exact HTTP request (method, path, body) plus the wrong response for API bugs
  - A short code snippet showing the wrong behaviour, with its file path
  - The exact CLI command + error output for build or tooling issues
  - The UI steps (page → action → observed result) for frontend bugs
  - A grep query + counts for inventory-style observations (e.g. `grep -rn 'console\.' daemon/src | wc -l`)

**Note on `N/A`:** Mark as `N/A` only when the issue is purely descriptive (doc gap, naming concern) — that signals "considered, not forgotten" rather than "skipped".

If you cannot produce a concrete example, treat that as a signal the issue may not yet be well-understood — flag it to the user before logging.

### How to Log

1. Read `KNOWN_ISSUES.md` at the repo root (create if it doesn't exist)
2. Check the issue is not already logged (avoid duplicates)
3. Append the new issue using the format above — verify it meets the "Entry Quality" bar before saving
4. Continue with the current task (do not fix the logged issue now)

## On Task Completion

**Before finishing any task, revisit `KNOWN_ISSUES.md`:**

1. Read all entries
2. Remove any entries resolved by the current task's changes
3. Present remaining issues to the user as a summary

**Do NOT ask the user to fix these issues now** — just inform them.

## Important

- `KNOWN_ISSUES.md` is git-ignored — a local-only tracking file, never committed
- Each developer's file is independent; it does not get shared via git
- **Never reference `KNOWN_ISSUES.md` or its entries in shared artifacts** — this is a public repository, and commit messages, PR descriptions, and GitHub issues must not name the file or quote its entries. External readers cannot see it. Describe the actual change, not the local tracking entry it resolves.
