// 用无头浏览器打开面板首页，确认前端真的能挂载起来。
//
// 用法: node scripts/release/browser-check.mjs http://127.0.0.1:23333
//
// 为什么需要这一步: smoke-test 的 HTTP 检查只能证明静态资源在位，证明不了应用跑得起来。
// echarts/zrender 那次(ac9181e6)就是首页 200、挂载点也在，但 JS 一执行就死在
// "hc is not a function"，整个面板只有一个转圈 —— 而发布流程全程亮绿灯。
//
// playwright 不是本仓库的依赖（装它要连浏览器一起下，几百 MB，不该压在每个开发者头上）。
// 找不到就由调用方决定跳过还是失败；CI 的发布流程里会装上，保证正式包一定过这道关。
// 装在别处时可以用 PLAYWRIGHT_MODULE 指过去。

const url = process.argv[2];
if (!url) {
  console.error("用法: node browser-check.mjs <url>");
  process.exit(2);
}

const modulePath = process.env.PLAYWRIGHT_MODULE || "playwright";
let chromium;
try {
  ({ chromium } = await import(modulePath));
} catch (err) {
  console.error(`加载不了 playwright(${modulePath}): ${err.message}`);
  process.exit(3); // 3 = 环境不具备，与"检查不通过"区分开
}

// 未登录时这些是预期的：面板还没走安装向导，或者只是没登录，
// 前端照样会去拉一次用户信息然后拿到 403。它们不代表前端坏了。
// 中文面板下同一条消息会被 i18n 成"权限不足"，两种都要认 —— 只写英文的话，
// 在 locale=zh-CN 下跑就会把正常的未登录状态报成失败。
const EXPECTED_ERRORS = [
  /\/api\/auth\/?\b.*\b403\b/,
  /403 \(Forbidden\)/,
  /Insufficient Permissions/,
  /权限不足/
];
const isExpected = (text) => EXPECTED_ERRORS.some((re) => re.test(text));

const browser = await chromium.launch();
// 语言跟着浏览器走：前端的初始语言取自 window.navigator.language
const page = await browser.newPage({ locale: "zh-CN" });

const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];

page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});
page.on("pageerror", (err) => pageErrors.push(err.stack || err.message));
page.on("requestfailed", (req) => {
  failedRequests.push(`${req.failure()?.errorText}  ${req.url()}`);
});

let navError = null;
await page
  .goto(url, { waitUntil: "networkidle", timeout: 45000 })
  .catch((err) => (navError = err.message));

// initApp 是异步的，networkidle 之后它可能还在跑（加载语言包、动态 import mount）
await page.waitForTimeout(Number(process.env.BROWSER_CHECK_SETTLE_MS || 5000));

const mounted = await page
  .evaluate(() => (document.querySelector("#app-mount-point")?.childElementCount ?? 0) > 0)
  .catch(() => false);
// index.html 里的错误框只有 initApp 抛异常时才会显示，是最直接的失败信号
const errorBox = await page
  .locator("#before-app-mounted .loading-error.show .error-message")
  .textContent()
  .catch(() => null);
const stage = await page
  .locator("#before-app-mounted .loading-title")
  .textContent()
  .catch(() => null);

await browser.close();

const unexpectedConsole = consoleErrors.filter((t) => !isExpected(t));
const problems = [];
if (navError) problems.push(`打不开页面: ${navError}`);
if (errorBox) problems.push(`前端报错: ${errorBox}（卡在 "${stage}" 阶段）`);
if (!mounted) problems.push("应用没有挂载：#app-mount-point 是空的");
if (pageErrors.length) problems.push(`有 ${pageErrors.length} 个未捕获异常`);
if (unexpectedConsole.length) problems.push(`有 ${unexpectedConsole.length} 条非预期的控制台错误`);

if (!problems.length) {
  console.log("      应用已挂载，控制台无异常");
  process.exit(0);
}

console.error("前端启动检查未通过：");
for (const p of problems) console.error(`  - ${p}`);
if (pageErrors.length) {
  console.error("\n未捕获异常：");
  for (const e of pageErrors.slice(0, 3)) console.error(e.split("\n").slice(0, 8).join("\n"));
}
if (unexpectedConsole.length) {
  console.error("\n控制台错误：");
  for (const e of unexpectedConsole.slice(0, 10)) console.error(`  ${e.split("\n")[0]}`);
}
if (failedRequests.length) {
  console.error("\n失败的请求：");
  for (const r of failedRequests.slice(0, 10)) console.error(`  ${r}`);
}
process.exit(1);
