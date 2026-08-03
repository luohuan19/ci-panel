// catch 到的值类型是 unknown（`core-development.md`：不要用 any，改用 unknown + 收窄）。
// 取错误文案这件事到处都要做，集中一处，免得每个 catch 都手写一遍窄化。
export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return String(err);
}
