import { mergeConfig } from "vite";
import { defineConfig } from "vitest/config";
import viteConfig from "./vite.config";

// 单独一个配置文件，不往 vite.config.ts 里加 `test` 键：那边的 defineConfig 来自 "vite"，
// 其类型没有 test 属性，而 tsconfig.node.json 又 include 了 vite.config.*，加进去会让
// npm run type-check 直接报错。mergeConfig 让 @ / @languages 别名只有一份来源。
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "jsdom",
      // 固定住 jsdom 的地址。protocol.ts 里的每个函数都读 window.location，用例要断言具体
      // 字符串就不能依赖 jsdom 的默认 URL —— 那是个实现细节，升级 jsdom 会变。
      environmentOptions: { jsdom: { url: "http://panel.example.com:23333/" } },
      // tsconfig.app.json 把 src/**/__tests__/* 排除在构建之外，tsconfig.vitest.json 用
      // "exclude": [] 把它放回来，所以用例只被类型检查、不会进 vite build。
      include: ["src/**/__tests__/**/*.spec.ts"],
      // 只放 jsdom 本身缺的全局。i18n 由需要它的用例自己初始化 —— 放在这里会让每个
      // 用例都被拽进 @/lang/i18n → stores → services 这条完整的应用导入链。
      setupFiles: ["./vitest.setup.ts"],
      // 不设 passWithNoTests：本包已经有用例，一旦上面的 glob 被改坏（重命名 __tests__、
      // 移动 src/tools、把文件写成 .test.ts），CI 应该红，而不是零用例通过。
      testTimeout: 5000
    }
  })
);
