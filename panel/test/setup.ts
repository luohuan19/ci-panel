// 把整个套件关进临时沙箱。没有这一段,跑一次测试就会在开发者工作区里落下 data/ 目录:
// common/src/system_storage.ts 的 DATA_PATH 是 static readonly,在**类定义期**就用
// process.cwd() 算好,之后再也改不了 —— 所以只能在任何 panel 模块被 import 之前 chdir。
//
// 这也是 vitest.config.ts 必须 threads: false 的原因:chdir 在 worker 线程里会抛。
import fs from "fs-extra";
import os from "os";
import path from "path";

// 包根由 vitest.config.ts 经 env 注入,不能用 process.cwd() 推:本文件对每个测试文件都会
// 重跑一遍,而下面的 chdir 会把 cwd 换成沙箱,第二个文件起就推不回来了。
export const PANEL_ROOT = process.env.CIP_TEST_PANEL_ROOT || process.cwd();

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "ci-panel-panel-test-"));
fs.mkdirsSync(path.join(sandbox, "data"));
fs.mkdirsSync(path.join(sandbox, "logs"));
process.chdir(sandbox);

export const SANDBOX = sandbox;

// 收尾:删掉沙箱。一次跑 N 个测试文件就是 N 个 mkdtemp。必须先 chdir 出去 ——
// 当前工作目录正是要删的那个。
process.on("exit", () => {
  try {
    process.chdir(os.tmpdir());
    fs.removeSync(sandbox);
  } catch (err: unknown) {
    // 不重抛:测试结论此时已定,让收尾改写退出码只会盖掉真实结果。
    // 但也不咽下去 —— 悄悄失败的话累积的沙箱是唯一线索。
    console.error(`[panel-test] 沙箱清理失败,请手动删除 ${sandbox}:`, err);
  }
});
