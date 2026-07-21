# AGENTS.md — ci-panel

Guidance for AI agents and automated code review (ChatGPT Codex and others).
The authoritative conventions live in `.cursor/rules/` and `.claude/rules/`;
read those before changing or reviewing code. This file is a short pointer.

## What this is

ci-panel is a fork of MCSManager repurposed to manage GitHub Actions
self-hosted runners. Four packages, **not** an npm workspace — `panel/` (web
backend), `daemon/` (node daemon), `frontend/` (Vue 3), `common/` (shared
types). Each installs and builds separately; `common/` must be rebuilt before
consumers see type changes. Shared types belong in `common/`, never duplicated.

## Non-negotiables for review

- **Modern TypeScript**, no stray `any`; don't suppress type/lint errors to hide
  a real defect. Apply DRY.
- **Backend boundary**: validate all frontend-supplied arguments; use the
  project logger not `console.*`; no shell interpolation of user input (argument
  arrays, `shell: false`); guard paths against directory traversal.
- **i18n**: user-facing text through `t()` / `$t()` with `TXT_CODE_` keys; code
  and comments in English.
- **Public repo**: never commit secrets, tokens, absolute paths, internal IPs,
  hostnames, or private repo names.
- **Minimal-change principle**: smallest focused diff; no unrelated refactors.
- **No AI co-author lines** or "Generated with …" footers on commits/PRs.

## Verification

There is **no test suite**. The gate is `npm run type-check --prefix frontend`,
`npm run lint --prefix frontend`, and `npm run build --prefix <pkg>` for each
touched package. Never claim "tests pass".
