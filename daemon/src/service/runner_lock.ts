// CI Panel 扩展：单个 runner 上的互斥。删除与置备 / 启停 / 改环境变量不能同时进行。
//
// 为什么需要：deleteRunner 是「停+卸 systemd → 从 GitHub 注销 → 清面板侧 → 删目录」一串
// await，第一步等 systemd 真停下来可能要几十秒。这个窗口里若放行同一个 runner 的置备或
// start/restart，单元会被重新装上 / 拉起，随后 fs.remove 才把目录删掉——留下一个工作目录
// 已不存在的 systemd 单元：Restart=always 让它反复启动失败，而面板侧的句柄实例与 .cipanel
// 都已清掉，扫描不再列出它，只能登机器手动 systemctl disable --now 收拾。
//
// 语义是「快速失败」而不是排队：panel 转发这些请求是 90 秒超时，而一次删除可以比这更久，
// 排队只会把请求挂死在那里；明确回一句「正在删除中，请稍后重试」，前端照旧弹它的错误提示。
//
// 只在本进程内有效——这些入口都在同一个 daemon 里；下面「查表 + 占位」之间没有 await，
// Node 单线程下不会被别的请求插进来，所以那一段是原子的。锁是内存态，daemon 重启即清空，
// 不会残留死锁。
import path from "path";

export type RunnerOp = "delete" | "provision" | "service" | "env";

const OP_LABEL: Record<RunnerOp, string> = {
  delete: "删除",
  provision: "置备",
  service: "启停",
  env: "设置环境变量"
};

// 两个命名空间：runner 目录、systemd 单元名。必须分开——service_control 只拿得到单元名
// （面板转发的就只有它），而 provision 只拿得到目录（单元名要等特权助手装完才定）。
// 删除两边都占，才能同时挡住这两条路。前缀也保证目录名与单元名不会互相误撞。
//
// 用 resolve 而不是 normalize：normalize 保留结尾的分隔符（`/a/b/` 原样返回），于是同一个
// runner 传 `/a/b/` 和 `/a/b` 会算出两个 key，互斥当场失效——而 dir 是调用方随便给的字符串，
// deleteRunner 的存在性检查与 assertUnderRoots 都照收带结尾斜杠的写法。
export const dirKey = (dir: string): string => `dir:${path.resolve(dir)}`;
export const serviceKey = (service: string): string => `svc:${service}`;

const holders = new Map<string, RunnerOp>();

// 占住 keys 跑 fn；任一 key 已被占用就直接抛错，不等待。fn 无论成败都会释放。
export async function withRunnerLock<T>(
  keys: string[],
  op: RunnerOp,
  fn: () => Promise<T>
): Promise<T> {
  const wanted = [...new Set(keys.filter(Boolean))];
  for (const key of wanted) {
    const owner = holders.get(key);
    // 错误信息里带上冲突的那个目标（去掉命名空间前缀），批量操作时才看得出是哪一个被挡了
    if (owner)
      throw new Error(
        `${key.slice(key.indexOf(":") + 1)} 正在${OP_LABEL[owner]}中，请等它结束后再试`
      );
  }
  for (const key of wanted) holders.set(key, op);
  try {
    return await fn();
  } finally {
    for (const key of wanted) holders.delete(key);
  }
}
