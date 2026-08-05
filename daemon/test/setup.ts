// 把整个套件关进一个临时沙箱。没有这一段,跑一次测试就会脏掉开发者的工作区:
// service/log.ts 在模块加载时就重命名 logs/current.log 并挂一个 cwd 相对的 log4js appender,
// system_instance.ts 则直接 fs.mkdirsSync('data/InstanceData')。
//
// 顺序很重要:CIP_SCAN_ROOTS 必须在任何 daemon 模块被 import 之前设好 ——
// runner_scan.ts 在模块作用域就读它来定扫描根,晚一步就来不及了。
import fs from "fs-extra";
import os from "os";
import path from "path";

// 仓库位置由 vitest.config.mts 经 env 注入,不能用 process.cwd() 推:本文件对每个测试文件
// 都会重跑一遍,而下面的 chdir 会把 cwd 换成沙箱 —— 第二个文件起就推不回来了。
// 也不用 import.meta.url:tsconfig 的 module 是 commonjs,type-check 会直接拒绝它。
export const DAEMON_ROOT = process.env.CIP_TEST_DAEMON_ROOT || process.cwd();
export const REPO_ROOT = path.resolve(DAEMON_ROOT, "..");

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "ci-panel-daemon-test-"));
fs.mkdirsSync(path.join(sandbox, "logs"));
fs.mkdirsSync(path.join(sandbox, "data"));
process.chdir(sandbox);

// 扫描根固定成沙箱下的一个目录。本文件对每个测试文件跑一遍,每遍都是全新的沙箱和全新的
// 模块注册表 —— 所以每个 spec 文件拿到的是自己的 runnerRoots,文件之间不共享,也不会互相干扰。
// (threads: false 只保证同一个进程,不等于同一份模块状态。)
const scanRoot = path.join(sandbox, "runners");
process.env.CIP_SCAN_ROOTS = scanRoot;
fs.mkdirsSync(scanRoot);

// 给用例用:拿扫描根,以及在根外造一个"根本够不着"的目录。
export const SCAN_ROOT = scanRoot;
export const OUTSIDE_ROOT = path.join(sandbox, "outside");
fs.mkdirsSync(OUTSIDE_ROOT);

// 收尾:把沙箱删掉。一次跑五个测试文件就是五个 mkdtemp,不清理的话开发机上的
// /tmp/ci-panel-daemon-test-* 会一直累积。必须先 chdir 出去 —— 当前工作目录正是要删的那个。
process.on("exit", () => {
  try {
    process.chdir(os.tmpdir());
    fs.removeSync(sandbox);
  } catch {
    /* 收尾失败不该影响测试结果,沙箱在 /tmp 下,系统迟早会清 */
  }
});
