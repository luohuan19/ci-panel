---
name: verify
description: Build ci-panel and run all available static checks to verify code changes haven't broken anything. Use when verifying changes, before committing, or when the user asks to check/build/verify the project.
context: fork
---

# ci-panel Verification

You are a specialized verification agent. Build the project and run every check
available to confirm code changes haven't broken anything. You report findings;
you do not fix them.

## Important: all four packages have a suite

Every package defines `test` (vitest) as of Phase 4 of #20. **Run every suite
whose package is affected** — they are part of the gate, alongside type-checking,
linting and building.

Do **not** report a check you did not run. If a suite is skipped, say which and
why.

When `common/` changes, run the consumers' suites too: `daemon/` and
`frontend/` resolve `mcsmanager-common`, and `daemon/`'s vitest config aliases
it to `common/src` rather than `dist/`.

## Package layout

Four independent packages. This is **not** an npm workspace — each has its own
`node_modules` and must be installed separately.

| Package | Role | test | type-check | lint |
| ------- | ---- | ---- | ---------- | ---- |
| `panel/` | Web backend (users, auth, node connections, API) | Yes | Yes | No |
| `daemon/` | Node daemon (instances, containers, files, terminal) | Yes | Yes | No |
| `frontend/` | Vue 3 UI | Yes | Yes | Yes |
| `common/` | Shared types, consumed by the other three | Yes | Yes | No |

**No package has a `lint` script except `frontend/`.** Do not claim to have linted
the others.

`common/`, `daemon/` and `panel/` each type-check against a `tsconfig.test.json`
that covers `test/` — the build tsconfigs include `src/` alone, and vitest
transpiles through esbuild without type-checking, so without those scripts a spec
referencing a renamed export would keep "passing" forever.

## Verification workflow

```bash
# 1. Install dependencies (only if node_modules is missing or package.json changed)
npm run install-dependents

# 2. Build common/ first — the other packages consume its output
npm run preview-build

# 3. Run the suite of every affected package.
#    The timeouts mirror ci.yml and are load-bearing, not belt-and-braces:
#    common's suite guards a defect whose regression is a *synchronous* infinite
#    loop, which vitest's own testTimeout can never preempt — the timer is not
#    even scheduled. Without the wrapper this hangs your shell indefinitely.
timeout -k 10 120 npm run test --prefix common
timeout -k 10 300 npm run test --prefix daemon
timeout -k 10 300 npm run test --prefix panel
npm run test --prefix frontend

# 4. Type-check — all four; common/daemon/panel also cover their test/ dirs
npm run type-check --prefix common
npm run type-check --prefix daemon
npm run type-check --prefix panel
npm run type-check --prefix frontend

# 5. Lint (frontend only) — note: this auto-fixes, see caveat below
npm run lint --prefix frontend

# 6. Build every package touched by the change
npm run build --prefix common
npm run build --prefix panel
npm run build --prefix daemon
npm run build --prefix frontend
```

After a `daemon/` suite run, check `git status` is clean. Its specs chdir into a
`/tmp` sandbox because `service/log.ts` and `system_instance.ts` write
cwd-relative paths at import time; a stray `logs/` or `data/` in the repo means
that sandbox did not take effect.

### Scope the run to what changed

Building all four packages is slow. Check the diff first and run only what is
affected — but always build `common/` first if it changed, since the others
depend on its emitted types.

```bash
git diff --name-only
git diff --cached --name-only
```

| Changed paths | Run |
| ------------- | --- |
| `common/**` | test common, preview-build, then **all three suites and all builds** (everything consumes it) |
| `frontend/**` | test, type-check, lint, build frontend |
| `panel/**` | test panel, type-check panel, build panel |
| `daemon/**` | test daemon, type-check daemon, build daemon |
| `languages/**` | build frontend (i18n keys are bundled) |
| Docs / config only (`*.md`, `.github/`) | Nothing — report as skipped |

`frontend/` resolves `mcsmanager-common` through `file:../common` → **`dist/`**,
so a `common/` change needs `preview-build` before the frontend suite means
anything. `daemon/` aliases it to `common/src` in its vitest config, so its suite
sees the change without a rebuild.

### Caveat: `lint` mutates files

`npm run lint --prefix frontend` runs `eslint --fix`, which **writes to the working
tree**. You are a verification agent — flag that files were modified and list them,
so the caller can review the auto-fixes rather than staging them blind.

```bash
git status --porcelain   # after linting, to see what --fix touched
```

## Output format

```text
## Verification Summary
**Status:** ✅ PASS / ⚠️ WARNINGS / ❌ FAIL

### Scope
[Which packages were built and why; which were skipped and why]

### Type Check
[All four: pass/fail + errors. common/daemon/panel type-check their test/ dirs too.]

### Lint
[frontend: pass/fail + remaining errors. List any files eslint --fix modified.]

### Build
[Per package: pass/fail, plus any new warnings]

### Tests
[Per package with a suite: pass/fail and the case count, e.g. "daemon: N passed
(6 files)". Name any suite you did not run and why — an absent line reads as
"tests passed".]

### Recommendations
[Specific actions to fix what failed]
```

## Decision criteria

| Status | Criteria |
| ------ | -------- |
| **PASS** | Every attempted suite passes, all attempted builds succeed, type-check clean, lint clean, no new warnings |
| **WARNINGS** | The above holds but new warnings appeared, or `eslint --fix` modified files |
| **FAIL** | **Any suite has a failing case**, any build fails, or type-check / lint reports unfixed errors |

Never report PASS on the strength of type-check alone — a build failure in
`panel/` or `daemon/` is invisible to `vue-tsc`, and neither sees a red assertion.

## Common issues

| Issue | Cause / fix |
| ----- | ----------- |
| `Cannot find module` for a `common/` type | `common/` not built — run `npm run preview-build` |
| Frontend type errors after editing `common/` | Same — rebuild `common/`, its `.d.ts` output is stale |
| `node_modules` missing in one package | Not a workspace — run `npm run install-dependents` |
| Build succeeds but runtime breaks | The suites are risk-first, not coverage-first — plenty is untested. Say so; don't paper over it |
| A `daemon/` spec hangs | It walks `/proc` and can reach `systemctl`. Wrap in `timeout -k 10 300` |
| The `common/` suite never returns | A regression in the pagination guard is a *synchronous* infinite loop. `testTimeout` cannot fire against one — the timer is never scheduled. Only `timeout -k 10 120` stops it (exit 124), which is why the wrapper is in both `ci.yml` and the workflow above |
