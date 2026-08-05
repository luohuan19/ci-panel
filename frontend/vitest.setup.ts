import { vi } from "vitest";

// jsdom 没有实现 ResizeObserver，ant-design-vue 的若干组件挂载时会用到。
// 这里只补 jsdom 的空缺 —— i18n 由需要它的用例各自初始化（见 tools/__tests__/fileManager.spec.ts），
// 放进这个全局 setup 会把每个用例都拽进 @/lang/i18n → stores → services 的完整导入链，
// 那条链上任何一处的导入期异常都会让无关的用例一起变红。
//
// 加 in 判断而不是无条件 stub：jsdom 哪天补上真实实现之后，不该被这个空壳顶掉。
if (!("ResizeObserver" in globalThis)) {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
}
