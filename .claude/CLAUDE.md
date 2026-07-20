# AI Assistant Rules for ci-panel

ci-panel is a fork of MCSManager, repurposed to manage GitHub Actions
self-hosted runners.

## Project shape

Four packages, **not** an npm workspace — each has its own `node_modules` and
must be installed and built separately.

| Package | Role |
| ------- | ---- |
| `panel/` | Web backend — users, auth, node connections, HTTP API |
| `daemon/` | Node daemon — runner scan/provision/logs, NPU monitoring |
| `frontend/` | Vue 3 UI (`<script setup lang="ts">`) |
| `common/` | Shared types, consumed by the other three |

`common/` must be rebuilt (`npm run preview-build`) before consumers see type
changes.

## Coding conventions live in `.cursor/rules/`

Read these before changing code — they are the authority, and the `.claude/`
rules deliberately do not duplicate them:

- `core-project-conventions.mdc` — package layout, minimal-change principle,
  English-only code and comments, i18n conventions (`TXT_CODE_` keys, `t()`
  single braces on the frontend, `$t()` double braces on the backend)
- `backend-daemon-panel-standards.mdc` — project logger over `console.*`,
  boundary validation, validating frontend-supplied arguments, resource cleanup
- `frontend-vue-component-standards.mdc` — Vue 3 component conventions

## Rules (`.claude/rules/`)

- **`core-development.md`** — TypeScript quality, DRY, security, no AI co-authors
- **`plans-and-proposals.md`** — plans must include concrete code, paths, before/after
- **`problem-handling.md`** — blocking vs. non-blocking; `KNOWN_ISSUES.md` (git-ignored)
- **`documentation-length.md`** — docs ≤500 lines, rules/skills ≤200 lines
- **`no-test-tampering.md`** — never weaken a test to make it pass (forward-looking)

## Skills (`.claude/skills/`)

- **`git-commit`** — commit workflow: review, verify, stage, message, post-check
- **`code-review`** — reviews the diff against project standards (`context: fork`)
- **`verify`** — type-check, lint, and build (`context: fork`)
- **`github-pr`** — branch, rebase, push, open a PR
- **`fix-pr`** — resolve review threads and CI failures on a PR
- **`auto-pr`** — create a PR then loop on fixes until green
- **`clean-branches`** — remove merged local and `origin` branches
- **`create-issue`** — file an issue following `.github/ISSUE_TEMPLATE/`
- **`fix-issue`** — fetch an issue, branch, plan, implement, verify, commit
- **`weekly-changelog`** — generate an external-API changelog for a date range

`code-review` and `verify` use `context: fork`, so they run in isolated
subagent contexts and can run in parallel during a commit without consuming the
main context window.

## Two things to know before using these

**There is no test suite.** `vitest` is a frontend devDependency but zero test
files exist and no package defines a `test` script. The real gate is
`npm run type-check --prefix frontend`, `npm run lint --prefix frontend`, and
`npm run build --prefix <pkg>`. Note that `panel/` and `daemon/` have neither a
`lint` nor a `type-check` script — their type errors surface only via `build`.
Never invent a test command or report "tests passed".

**Remotes are asymmetric.** `origin` is `luohuan19/ci-panel` (public, default
branch `master`) — all PRs and issues go here. `upstream` is
`MCSManager/MCSManager`, a third-party project — never open a PR or issue
against it. Because the repo is public, treat internal IPs, hostnames, and
private repo names as secrets.
