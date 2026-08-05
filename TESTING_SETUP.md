# Testing Setup — config file contents

Companion to [TESTING.md](TESTING.md), which is the strategy. This file holds the full contents of
every configuration file the rollout adds, so they can be copied verbatim.

**As each package's configs land, replace its section with a pointer to the real files, and delete
this file once all four are done** — a checked-in config and a copy of it here will drift, and the
copy is the one nobody updates. frontend is already reduced this way.

## frontend — done, the files are the source of truth

`frontend/vitest.config.ts` and `frontend/vitest.setup.ts` exist in the tree as of Phase 0; read
them there rather than a copy here. Five points worth carrying to the other three packages:

- **Do not add a `test` key to `vite.config.ts`.** Its `defineConfig` comes from `"vite"`, whose
  type has no `test` property, and `tsconfig.node.json` includes `vite.config.*` — so
  `npm run type-check` would break. A separate `vitest.config.ts` with `mergeConfig` keeps the
  aliases single-sourced, and `tsconfig.node.json` already includes `vitest.config.*`.
- **Pin the jsdom URL** (`environmentOptions.jsdom.url`). Anything reading `window.location` can
  then be asserted against a literal instead of against jsdom's default, which moves with the
  version.
- **`tsconfig.vitest.json` needs `"files": ["vitest.setup.ts"]`.** `files` merges with the inherited
  `include`; a second `include` would replace it. The specs themselves are already covered — that
  config clears `tsconfig.app.json`'s `"exclude": ["src/**/__tests__/*"]`.
- **Keep the setup file to what is genuinely global.** frontend's holds only the `ResizeObserver`
  stub jsdom lacks. i18n init lives in the one spec that needs it: put it in the setup file and
  every spec — including ones importing a single dependency-free module — is dragged through
  `@/lang/i18n` → stores → services, where any import-time throw reddens all of them at once.
- **Drop `passWithNoTests` in the same commit as the package's first spec** (see TESTING.md §8),
  and do not declare a `coverage` block before `@vitest/coverage-v8` is actually installed —
  `vitest run --coverage` then prompts for an install, which hangs a CI step.

## common — done, the file is the source of truth

`common/vitest.config.ts` exists in the tree as of Phase 1. Two things it settles for daemon/panel:

- **`include: ["test/**/*.spec.ts"]` needs no tsconfig change here.** `common/tsconfig.json`'s
  `include` is `["src/**/*"]`, so `npm run build` never sees a spec and nothing lands in `dist/`.
  The trade-off is that specs are *not* type-checked by any existing script — daemon and panel get
  the `tsconfig.test.json` below precisely because they can afford to fix that; common cannot
  without a second tsconfig it does not otherwise need.
- **The 2s `testTimeout` does not guard the pagination loop.** It suits a pure-logic package —
  anything slower is a hang, not a slow test — but a synchronous loop never yields the event loop,
  so the `setTimeout` behind `testTimeout` is never even scheduled. Confirmed by restoring the
  pre-1.0.4 implementation: the run sails past 2s and only the CI step's process-level
  `timeout -k 10 120` stops it, with exit 124 and no orphaned workers (TESTING.md §2.2).

## daemon — done; panel's config mirrors it minus the `mcsmanager-common` alias

`daemon/vitest.config.mts`, `daemon/test/setup.ts` and `daemon/tsconfig.test.json` are in the tree
as of Phase 2. What panel should copy:

- **`alias` mirrors `webpack.config.js`** — vitest does not read tsconfig `paths`. Pointing
  `mcsmanager-common` at `common/src` rather than `dist/` takes `preview-build` out of the test loop
  and stops a stale `dist` from silently testing an older protocol.
- **`__dirname` is fine in a `.mts` config** despite the file being ESM, so no `fileURLToPath` dance
  is needed. vite's `bundleConfigFile` hands esbuild
  `define: { __dirname: "__vite_injected_original_dirname" }`, and its `inject-file-scope-variables`
  plugin prepends that as a bundle-time string literal from `path.dirname(args.path)`. The plugin's
  filter is `/\.[cm]?[jt]s$/`, which covers `.mts`. Verified by loading a real `.mts` config.
- **`threads: false` is mandatory here**, for three separate reasons: `process.chdir` throws inside a
  worker thread, `runner_scan` fixes its scan roots from `CIP_SCAN_ROOTS` at module load, and the
  pool-startup cost dwarfs the assertions (TESTING.md §9). Remember 0.3x spells it `threads`.
- **Inject the package root through `test.env`, do not derive it from `process.cwd()`.** The setup
  file runs once *per test file* and chdirs into a fresh sandbox each time, so from the second file
  onwards `cwd` is the previous sandbox. `import.meta.url` is not an option either — the tsconfig's
  `module` is `commonjs` and `type-check` rejects it. The config file's own `__dirname` is the one
  stable reference:

```ts
    env: { CIP_TEST_DAEMON_ROOT: __dirname },
```

- **The sandbox is containment, not a fix.** `service/log.ts` renames `logs/current.log` and attaches
  a cwd-relative log4js appender at import time; `system_instance.ts` does
  `fs.mkdirsSync('data/InstanceData')`. The chdir keeps that out of the working tree — after a run,
  `git status` must still be clean. Narrowing those import-time side effects is Phase 5.

## `daemon/tsconfig.test.json` / `panel/tsconfig.test.json`

Both packages' `include` is `["src/**/*", "../common/global.d.ts"]`, so `test/` is invisible to the
webpack build — without this, a spec referencing a renamed export keeps "passing". `skipLibCheck:
true` belongs **only** here: `daemon/tsconfig.json` sets it to `false` and the build depends on that.

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": true, "skipLibCheck": true, "types": ["node"] },
  "include": ["src/**/*", "test/**/*", "../common/global.d.ts"]
}
```

## `package.json` script additions

All four packages use `"test": "vitest run"` — **never a bare `"vitest"`**, which enters watch mode
and hangs CI. Add `"test:watch": "vitest"` separately; panel and daemon also get
`"type-check": "tsc --noEmit -p tsconfig.test.json"`. No other script changes.
