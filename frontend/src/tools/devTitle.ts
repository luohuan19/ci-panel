// 开发实例的标签页标题前缀。
//
// 开发面板和生产面板长得一模一样，浏览器里开着两个标签页很容易点错 —— 在开发实例上误点
// 停止/删除，代价可能是中断一条正在跑的 CI 任务。给标题加个显眼的前缀来区分。
//
// 判据用 import.meta.env.DEV：它只在 vite dev server（bash dev.sh 拉起的那个前端）下为
// true，`vite build` 的生产产物恒为 false，所以生产面板不会被误加前缀，也不需要任何配置。
//
// 只作用于 document.title，绝不写回面板设置里的 theme.pageTitle —— 那是持久化到
// panel/data 的用户配置，被前缀污染后会跟着配置一路带到生产。
export const DEV_TITLE_PREFIX = "[dev] ";

export function withDevTitlePrefix(title: string): string {
  if (!import.meta.env.DEV) return title;
  return title.startsWith(DEV_TITLE_PREFIX) ? title : `${DEV_TITLE_PREFIX}${title}`;
}
