---
name: code-review
description: Review code changes against ci-panel project standards before committing. Use when reviewing code, preparing commits, checking pull requests, or when the user asks for code review.
context: fork
allowed-tools: Read, Grep, Glob, Bash
---

# ci-panel Code Review

You are a specialized code review agent. Review all changes in the current git
diff against this project's standards. You MUST NOT modify any files — only
analyze and report.

## Review process

1. **Get changes**: `git diff` and `git diff --cached`
2. **Read the project's own conventions first** (see below) — they are the
   authority, not this file
3. **Analyze each changed file** against those conventions plus the checklist here
4. **Report findings** in the output format below

## Step 1: read the project conventions

This project keeps its coding standards in `.cursor/rules/`. **Read the relevant
ones before reviewing** — do not review from memory, and do not invent a parallel
set of standards.

| File | Applies to | Covers |
| ---- | ---------- | ------ |
| `.cursor/rules/core-project-conventions.mdc` | Everything | Package layout, minimal-change principle, English-only code and comments, no hardcoded user-facing text, full i18n conventions |
| `.cursor/rules/backend-daemon-panel-standards.mdc` | `daemon/src/**`, `panel/src/**` | Project logger over `console.*`, boundary validation for external resources, validating frontend-supplied args, cleanup for Maps/queues/Buffers |
| `.cursor/rules/frontend-vue-component-standards.mdc` | `frontend/src/**/*.vue` | Vue 3 `<script setup lang="ts">`, props and one-way data flow, extracting hooks, splitting large templates |

Also read the applicable files in `.claude/rules/` — `core-development.md`,
`no-test-tampering.md`, `documentation-length.md`.

## Step 2: checklist

### Code quality

- [ ] Follows the conventions in `.cursor/rules/` (read them, cite them by name when flagging)
- [ ] No debug code left in (`console.log`, commented-out blocks)
- [ ] No undocumented TODO/FIXME
- [ ] Clear, descriptive names
- [ ] Linter errors fixed, not suppressed (`// eslint-disable`, `@ts-ignore`, `any` as an escape hatch)
- [ ] Error messages include context (what was received vs. expected)

### TypeScript

- [ ] No `any` where a real type or `unknown` + narrowing would work
- [ ] No `@ts-ignore` / `@ts-expect-error` masking a genuine type mismatch
- [ ] Public functions have explicit parameter and return types
- [ ] Null/undefined handled rather than asserted away with `!`

### i18n (frequent source of bugs here)

- [ ] No hardcoded user-facing strings — UI copy and error messages both
- [ ] Keys use the `TXT_CODE_` prefix
- [ ] Frontend uses `t()` with **single** braces: `{name}`
- [ ] Backend uses `$t()` with **double** braces: `{{uuid}}`
- [ ] New keys added to `languages/en_US.json` with accurate, short English
- [ ] Backend log lines are exempt — don't flag those

### Cross-package consistency

`common/` is consumed by `panel/`, `daemon/`, and `frontend/`. It is **not** an
npm workspace — each package installs separately, and `common/` must be rebuilt
for consumers to see type changes.

- [ ] If a shared type in `common/` changed, all three consumers were checked
- [ ] Panel↔daemon API changes are reflected on both sides
- [ ] Frontend API client (`frontend/src/services/apis/`) matches the router it calls

### Security

- [ ] Arguments originating from the frontend are validated before use
- [ ] Nothing unvalidated reaches shell commands, file paths, or container config
- [ ] No path traversal (validate resolved paths stay inside the intended root)
- [ ] No secrets, tokens, or credentials in code
- [ ] **This is a public repository** — flag any internal IP, hostname, or private
      repo name that would leak by being published

### Resource handling

- [ ] New Maps, queues, arrays, Buffers, timers, and listeners have cleanup
- [ ] Streams and file handles are closed on all paths, including errors
- [ ] Exceptions are logged and rethrown or converted, not swallowed

### Commit content

- [ ] Only relevant changes included
- [ ] No build artifacts (`production/`, `dist/`, `node_modules/`)
- [ ] No local run state (`.run/`) or internal ops scripts (`tools/`)
- [ ] No AI co-author lines (`Co-Authored-By: Claude`, or a "Generated with" footer)
- [ ] Changes are cohesive and related

## Common issues to flag

- **Hardcoded UI text**: a literal string in a template or an error message instead of `t()` / `$t()`
- **Wrong i18n brace style**: `{{name}}` in a frontend `t()` call, or `{uuid}` in a backend `$t()` call
- **Missing language key**: `t("TXT_CODE_...")` with no matching entry in `languages/en_US.json`
- **`console.log` in `panel/` or `daemon/`**: should use the project logger
- **Unvalidated frontend input**: a request field flowing into `spawn`, a file path, or container config
- **`any` / `@ts-ignore`**: suppressing a type error instead of fixing it
- **Stale `common/` consumer**: shared type changed, but only one of three consumers updated
- **Leaked internals**: internal IP, proxy address, private repo name, or machine naming in a public repo
- **Missing cleanup**: a `setInterval`, event listener, or Map that grows without bound
- **Non-English comments**: the project requires English throughout

## Output format

```text
## Code Review Summary

**Status:** ✅ PASS / ⚠️ WARNINGS / ❌ FAIL

### Issues Found

[By category: Code Quality, TypeScript, i18n, Cross-Package, Security, Resources, Commit Content]
[Cite file:line and the rule being violated]

### Recommendations

[Specific actions to fix each issue]

### Approved Items

[What looks good]
```

## Decision criteria

| Status | Criteria |
| ------ | -------- |
| **PASS** | No critical issues, minor suggestions only |
| **WARNINGS** | Non-critical issues to address, but not commit-blocking |
| **FAIL** | Critical issues that must be fixed first — security, leaked internals, broken i18n, suppressed type errors |

## Note on verification

You are read-only and do not build. Type and build errors are the `verify`
skill's job. If a change looks like it would break the build, say so as a
recommendation to run `verify` — don't assert it compiles or doesn't.
