import path from "node:path";
import { defineConfig } from "vitest/config";

// `__dirname` 在 .mts 里可用:配置文件不是当纯 ESM 执行的,vite 的 bundleConfigFile 会先把它
// 打包,并由 inject-file-scope-variables 插件在 load 钩子里前置成一个编译期字符串字面量。
export default defineConfig({
  resolve: {
    // 照抄 webpack.config.js 的别名 —— vitest 不读 tsconfig 的 paths。
    // mcsmanager-common 指向 common/src 而不是 dist/:既把 preview-build 拿出测试回路,
    // 也避免一个过期的 dist 让测试悄悄跑在旧协议上。
    alias: {
      "@languages": path.resolve(__dirname, "../languages"),
      "mcsmanager-common": path.resolve(__dirname, "../common/src/index.ts")
    }
  },
  test: {
    environment: "node",
    include: ["test/**/*.spec.ts"],
    setupFiles: ["./test/setup.ts"],
    // setup.ts 会 process.chdir 进沙箱,而它对每个测试文件都跑一遍 —— 第二个文件起
    // process.cwd() 已经是上一轮的沙箱,推不回仓库位置了。契约用例要读 prod-scripts/
    // 下的助手脚本,所以从这里注入:配置文件里的 __dirname 才是稳定的那个。
    env: { CIP_TEST_DAEMON_ROOT: __dirname },
    // 本包必须单线程,原因比 common 那边更硬:
    // 1. setup.ts 要 process.chdir 把工作目录钉进沙箱,而 worker 线程里 chdir 直接抛;
    // 2. runner_scan 在模块加载时就从 CIP_SCAN_ROOTS 定下扫描根,多进程各读一份没意义;
    // 3. tinypool 按 CPU 核数起 worker,而这里的断言是毫秒级的(见 TESTING.md §9)。
    // 注意 0.3x 只有 `threads`,`pool` / `poolOptions` 是 vitest 1.0+ 的字段。
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
