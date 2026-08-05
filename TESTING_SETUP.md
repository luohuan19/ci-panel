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

## `common/vitest.config.ts`

The 2s `testTimeout` is what turns a reverted pagination guard into a readable failure instead of a
burned job.

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.spec.ts"],
    passWithNoTests: true, // 写下第一个 spec 的那次提交里删掉，见 TESTING.md §8
    testTimeout: 2000,
    teardownTimeout: 1000,
    coverage: { provider: "v8", reporter: ["text", "lcov"], include: ["src/**"] }
  }
});
```

## `daemon/vitest.config.mts` (`panel/vitest.config.ts` is identical minus the `mcsmanager-common` alias)

`alias` mirrors `webpack.config.js:39-42` (vitest does not read tsconfig `paths`); pointing
`mcsmanager-common` at `common/src` rather than `dist/` takes `preview-build` out of the test loop
and stops a stale `dist` from silently testing an older protocol. `threads: false` is required by
the module-level singletons and import-time side effects, and makes `process.chdir` work in the
setup file — **do not write `pool` / `poolOptions`, those are vitest 1.0+ fields**.

```ts
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@languages": path.resolve(__dirname, "../languages"),
      "mcsmanager-common": path.resolve(__dirname, "../common/src/index.ts")
    }
  },
  test: {
    environment: "node",
    include: ["test/**/*.spec.ts"],
    setupFiles: ["./test/setup.ts"],
    passWithNoTests: true, // 写下第一个 spec 的那次提交里删掉，见 TESTING.md §8
    threads: false,
    testTimeout: 5000,
    teardownTimeout: 2000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/types/**", "../common/**"]
    }
  }
});
```

## `daemon/test/setup.ts`

`service/log.ts` renames `logs/current.log` and configures a cwd-relative log4js appender at import
time, and `system_instance.ts` does `fs.mkdirsSync('data/InstanceData')` — without this, one test
run pollutes the developer's working tree.

```ts
import fs from "fs-extra";
import os from "os";
import path from "path";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "ci-panel-daemon-test-"));
fs.mkdirsSync(path.join(sandbox, "logs"));
fs.mkdirsSync(path.join(sandbox, "data"));
process.chdir(sandbox);

// runner_scan.ts reads CIP_SCAN_ROOTS once at module load — set it before importing any daemon module.
process.env.CIP_SCAN_ROOTS = path.join(sandbox, "runners");
fs.mkdirsSync(process.env.CIP_SCAN_ROOTS);
```

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
