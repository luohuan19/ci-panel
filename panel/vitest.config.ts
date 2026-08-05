import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // 照抄 webpack.config.js 的别名 —— vitest 不读 tsconfig 的 paths。
    alias: {
      "@languages": path.resolve(__dirname, "../languages"),
      "mcsmanager-common": path.resolve(__dirname, "../common/src/index.ts")
    }
  },
  test: {
    environment: "node",
    include: ["test/**/*.spec.ts"],
    setupFiles: ["./test/setup.ts"],
    // 本包必须单线程,理由比 common/daemon 更硬:
    // common/src/system_storage.ts 的 DATA_PATH 是 static readonly,在**类定义期**就用
    // process.cwd() 算好了。要把数据目录挪进沙箱,只能在 setup 里 process.chdir —— 而
    // chdir 在 worker 线程里直接抛 ERR_WORKER_UNSUPPORTED_OPERATION。
    // 另见 TESTING.md §9:tinypool 按核数起 worker,这点用例根本不值那个启动开销。
    // 注意 0.3x 只有 `threads`,`pool` / `poolOptions` 是 vitest 1.0+ 的字段。
    threads: false,
    // repo_service.ts 在模块作用域就调 migrateFromEnv(),会把开发者 shell 里的
    // CIP_GITHUB_REPOS / CIP_GITHUB_TOKEN 读进注册表 —— 测试结果不能取决于谁在跑。
    // 空串而非 undefined:vitest 的 env 只接受字符串,而代码里用的是 `|| ""` 兜底。
    env: {
      CIP_GITHUB_REPOS: "",
      CIP_GITHUB_TOKEN: "",
      CIP_TEST_PANEL_ROOT: __dirname
    },
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
