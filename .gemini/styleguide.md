# ci-panel Review Style Guide

Guidance for automated code review. The authoritative rules live in
`.cursor/rules/` and `.claude/rules/`; this file is a condensed version for the
review bot. ci-panel is a fork of MCSManager repurposed to manage GitHub Actions
self-hosted runners.

## Project shape

Four packages, **not** an npm workspace — each installs and builds separately:
`panel/` (web backend), `daemon/` (node daemon), `frontend/` (Vue 3), `common/`
(shared types). A change to `common/` must be rebuilt before consumers see it.
Shared types belong in `common/` and must never be redeclared in two packages.

## TypeScript quality

- Prefer `const`, `async`/`await`, optional chaining, and nullish coalescing.
- Avoid `any`; use `unknown` plus a narrowing check when the shape is unknown.
- Do not suppress errors (`@ts-ignore`, `@ts-expect-error`, `eslint-disable`)
  to hide a genuine defect — fix the root cause.
- Apply DRY: extract a helper when a pattern appears 2+ times.

## Backend (panel / daemon)

- **Validate all frontend-supplied arguments** at the panel↔daemon boundary.
- Use the project logger, **never** `console.*`.
- **No shell interpolation** of user input — use `spawn`/`execFile` with an
  argument array and `shell: false`.
- Guard filesystem paths against directory traversal: resolve the path and
  verify it stays under the intended base directory before use.
- Clean up resources (timers, watchers, child processes, listeners).

## Frontend (Vue 3)

- `<script setup lang="ts">` components.
- Release resources on unmount (intervals, event listeners, sockets).
- Follow existing widget patterns; keep diffs minimal and focused.

## Internationalization

- User-facing text goes through i18n: `t()` on the frontend, `$t()` on the
  backend, with `TXT_CODE_` keys — where the surrounding code already uses i18n.
- **Code and comments in English.**

## Security (this is a PUBLIC repository)

- Never commit secrets, tokens, absolute developer paths, internal IPs,
  hostnames, or private repo names — in source, config, samples, or fixtures.
- Resolve paths relative to the process/module, not hardcoded absolutes.
- Return generic errors to callers; keep sensitive detail in server logs.

## Process

- **Minimal-change principle**: prefer the smallest change that solves the
  problem; do not bundle unrelated refactors or formatting sweeps.
- **Never** add AI co-author lines or "Generated with …" footers to commits or
  PRs — commits reflect human authorship only.
- There is **no test suite**; the gate is `type-check` / `lint` (frontend) and
  `build` (all packages). Never claim "tests pass".
