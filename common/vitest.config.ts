import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // 用例放在 test/ 下,不和 src/ 混。tsconfig.json 的 include 只有 src/**/*,
    // 所以 `npm run build` 看不到 spec,不会把它们编进 dist/。
    include: ["test/**/*.spec.ts"],
    // tinypool 按 CPU 核数起 worker,而本包只有两个纯逻辑文件 —— 开销全花在启动上。
    // 实测 320 核的机器:默认 106 秒,threads: false 只要 1.1 秒。
    // 这不只是快慢问题:CI 步骤套了 `timeout -k 10 120`,一旦 test job 跑到高核数的
    // 自托管 runner 上,一个本该通过的套件会被 124 杀掉 —— 而那个退出码跟本包要防的
    // 死循环回归一模一样,排查时极易误判。
    // 注意 0.3x 只有 `threads`,写 `pool` / `poolOptions` 是 vitest 1.0+ 的字段。
    threads: false,
    // 本包全是纯逻辑,毫秒级就该跑完;超过 2 秒说明是挂住了而不是慢。
    // 注意这拦不住同步死循环 —— 那种情况 vitest 的定时器根本没机会被调度,
    // 得靠 CI 步骤上的进程级 timeout(见 TESTING.md §2.2)。
    testTimeout: 2000,
    teardownTimeout: 1000,
    coverage: { provider: "v8", reporter: ["text", "lcov"], include: ["src/**"] }
  }
});
