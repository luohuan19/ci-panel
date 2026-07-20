---
name: weekly-changelog
description: Generate a weekly changelog markdown file summarizing external API and feature changes in ci-panel from git commits in a date range. Extracts before/after TypeScript examples per commit, groups by theme (HTTP routes / frontend API client / shared types / UI), and attributes each change to its author. Use when the user asks for a weekly report, changelog, commit summary, or interface-change digest.
---

# Weekly Changelog Generator (ci-panel)

## Overview

Produces a markdown report of **externally visible** ci-panel changes over a
date range (typically one week). Each entry has a one-line summary, a
before/after TypeScript example, a classification (new / replace / deprecate),
and the implementer's name. Internal refactors / chores / CI / build tweaks are
excluded by default.

## Prerequisites

- Runs on the local git history of `luohuan19/ci-panel`; the default branch is
  `master`.
- Only the optional `gh pr view` lookups need the `gh` CLI. It lives at
  `~/.local/bin/gh` (not on the default PATH) and is authenticated as
  `luohuan19`. If `gh` is unavailable, fall back to commit messages and diffs
  alone and say so in the report.
- **Ignore the `upstream` remote** (`MCSManager/MCSManager`). Only summarize
  commits authored for ci-panel; do not report upstream merge history as
  ci-panel work.
- The repository currently has very few ci-panel commits. An empty or one-entry
  report is a valid result — say so rather than padding it.

## Step 1: Collect Parameters

Ask the user with `AskUserQuestion`:

| Question | Header | Options |
| -------- | ------ | ------- |
| Date range? | Range | This week / Last week / Custom (YYYY-MM-DD..YYYY-MM-DD) |
| Output path? | Output | `./weekly-<start>-to-<end>.md` (Recommended) / `/tmp/...` / custom |
| Language? | Lang | Chinese / English |
| Scope? | Scope | External APIs only (Recommended) / All commits |

Skip any question the user already answered in their request.

## Step 2: List Commits in Range

```bash
git log --since="<start> 00:00" --until="<end> 23:59" \
        --pretty=format:"%h | %an | %s" --date=short
```

Capture `<hash> | <author> | <subject>` for every commit.

## Step 3: Classify Commits

> **The commit prefix is a hint, NOT the gate.** User-facing surface routinely
> ships behind `fix(...)`/`refactor(...)`, so prefix-only classification
> under-reports the most important changes. The **authoritative signal is the
> diff touching a public surface** — check *every* commit, whatever its prefix.

### 3a. Public-surface pre-pass (authoritative — run on ALL commits)

Before applying any prefix heuristic, scan each commit's diff for additions or
signature changes to these surfaces. Any hit ⇒ **treat as external**:

| Surface | Why it is public |
| ------- | ---------------- |
| `panel/src/app/routers/` | Panel HTTP routes — the outward-facing API |
| `daemon/src/routers/` | Daemon HTTP routes — the panel↔daemon contract |
| `frontend/src/services/apis/` | Frontend API client (`ci.ts`, `runner.ts`, `repo.ts`, ...); a new or renamed export here is always user-visible |
| `common/src/` | Shared types/utilities; `common/src/index.ts` re-exports are the package's public surface |

Fast batch scan over the range:

```bash
for h in $(git log --since=... --until=... --pretty=%h); do
  hit=$(git show --stat $h | grep -E \
    "panel/src/app/routers/|daemon/src/routers/|frontend/src/services/apis/|common/src/")
  [ -n "$hit" ] && { echo "=== $h ==="; echo "$hit"; }
done
```

For each hit, open the diff (`git show <hash> -- <file>`) to confirm it
adds/renames a public symbol or route rather than editing internals. **Watch
for** a new route in a `*_router.ts` with no client function yet, a changed
request/response shape in `common/src/`, or a renamed export in
`frontend/src/services/apis/index.ts` — all external even under a
`fix`/`refactor` prefix.

### 3b. Prefix heuristic (only for commits with NO public-surface hit)

| Prefix / pattern | External? | Action |
| ---------------- | --------- | ------ |
| `feat(panel)`, `feat(daemon)`, `feat(frontend)`, `feat(common)` adding a route/API/type | Yes | Include |
| `feat:` with user-visible additions | Yes | Include |
| `fix(...)` changing a public default, route path, or payload shape | Yes | Include |
| `feat`/`fix` confined to internal service/util code with no 3a hit | **No** | Skip |
| `refactor`, `chore`, `style`, `docs`, `ci`, `build` with no 3a hit | **No** | Skip |

UI-only changes (`frontend/src/views/`, `frontend/src/components/`) count as
external when they add or remove a user-visible feature, but not for pure
styling.

## Step 4: Extract Before/After Per External Commit

For each external commit, in parallel batches of ~5, launch **Explore
subagents** to gather:

1. One-sentence summary (Chinese or English per Step 1)
2. **Before** TypeScript snippet (5-10 lines); for pure additions write
   `None (new)` or show the prior workaround
3. **After** TypeScript snippet (5-10 lines), from the diff or the PR
   description (`gh pr view <num>`, if `gh` is authenticated)
4. Classification: new / replace / deprecate

**Agent prompt template** (one agent per 3-5 commits):

```text
Investigate the user-facing interface changes in the following ci-panel
commits. For each commit, output:
- One-sentence summary
- Before usage (minimal TypeScript example)
- After usage (minimal TypeScript example)
- Classification (new / replace / deprecate)
Working directory: /data/ci-runner/ci-panel
Commands: git show --stat <hash>; git show <hash> -- <file>
Inspect panel/src/app/routers/, daemon/src/routers/,
frontend/src/services/apis/, and common/src/.
Keep each entry concise (< 120 words).
Commits: <list>
```

## Step 5: Assemble Markdown

Structure of the output file:

```markdown
# ci-panel Weekly: <start> ~ <end> (external features and interface changes)

> Only includes user-visible changes ... internal refactor / chore / ci /
> build changes are not listed.

## Overview
| Commit | PR | Author | Topic | Type |

## Owner Index
| Owner | Commit count | Topics covered |

## 1. Panel HTTP API
### 1.1 <title> (#<pr>)
- **Author**: <author>
- **Type**: new / replace / deprecate
- **Summary**: ...
**Before**: ```ts ... ```   (or `None (new)`)
**After**: ```ts ... ```

## 2. Daemon HTTP API
## 3. Frontend API Client
## 4. Shared Types (common)
## 5. Migration Guide (deprecations aggregated)
| Old usage | Recommended | Notes |
```

Always include the per-entry **Author** line (`git log --pretty=format:"%an"`),
an **Owner index** table aggregating commits per author, and a **Migration
guide** table for any deprecation or default-value change.

Buckets map to the source path a commit touches: `panel/src/app/routers/` →
Panel HTTP API, `daemon/src/routers/` → Daemon HTTP API,
`frontend/src/services/apis/` → Frontend API Client, `common/src/` → Shared
Types. Add a "UI features" bucket for user-visible `frontend/src/views/`
additions. **Omit empty buckets.**

## Step 6: Save and Report

Write the file to the agreed output path with `Write`. Confirm in chat: line
count, commit count covered, deprecation count.

## Conventions and Constraints

- **Never invent anything** — commits, PR numbers, and code examples must come
  from what `git log`, `gh pr view`, and the diff actually return. For a pure
  addition write `None (new)`; do not fabricate a "before".
- **Never report upstream MCSManager commits** as ci-panel changes.
- **Author names** come from `git log` (`%an`), not `Co-Authored-By` lines.
- **Language**: produce the entire file in the chosen language; do not mix.
- **Mark deprecations explicitly** — the migration table is the deliverable
  that protects consumers.
- **Scope discipline**: when scope is "external only", refusing to include a
  commit is correct — record the skipped count in the final report.
- **Read-only until Step 6**; honor the user's chosen output path.

## Checklist

- [ ] Date range, output path, language, scope captured
- [ ] All commits in range listed with author; upstream (MCSManager) excluded
- [ ] Public-surface pre-pass (3a) run over EVERY commit, not just `feat` ones
- [ ] Each commit classified external vs internal (prefix never overrides a 3a hit)
- [ ] Before/after TypeScript example, author, and theme bucket per entry
- [ ] Overview table + owner index + migration table all present
- [ ] File written to the requested path; summary reported back
