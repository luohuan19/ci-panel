// CI Job 看板（自研补充，非 MCSManager 原生）：
// 调 GitHub Actions API 拉 workflow 运行状态，供前端 CI 看板页展示。
// 仓库列表与 PAT 都取自仓库注册表（panel/data/RepoConfig/），与 runner 纳管的仓库同源；
// 仓库没配自己的 PAT 时回退到全局环境变量 CIP_GITHUB_TOKEN。
import Router from "@koa/router";
import axios from "axios";
import { ROLE } from "../entity/user";
import permission from "../middleware/permission";
import RepoService from "../service/repo_service";

const router = new Router({ prefix: "/ci" });

const GH_API = "https://api.github.com";

// PAT 是可选的：公开仓库匿名就能读 workflow 运行记录（限流 60 次/小时/IP）。
// 配了 PAT 则限流提到 5000 次/小时；私有仓库、以及 workflow_dispatch 则必须配。
function ghHeaders(repo: string) {
  const token = RepoService.tokenOf(repo);
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

// GitHub 对匿名请求私有仓库一律回 404（不暴露仓库是否存在），照搬这个错误没法排查
function explainGhError(repo: string, err: any) {
  const status = err?.response?.status;
  const hasToken = Boolean(RepoService.tokenOf(repo));
  if ((status === 404 || status === 401) && !hasToken) {
    return `拿不到 ${repo} 的数据：若它是私有仓库，需要在仓库设置里为它配置 PAT`;
  }
  if (status === 403 && !hasToken) {
    return `GitHub 限流（匿名 60 次/小时）：为 ${repo} 配置 PAT 可提升到 5000 次/小时`;
  }
  return err?.response?.data?.message || err.message;
}

function defaultRepo() {
  return RepoService.list()[0]?.slug || "";
}

// 已纳管的仓库列表，前端做下拉
router.get("/repos", permission({ level: ROLE.ADMIN, token: false }), async (ctx) => {
  ctx.body = RepoService.list().map((repo) => repo.slug);
});

// 最近的 workflow 运行
router.get("/runs", permission({ level: ROLE.ADMIN, token: false }), async (ctx) => {
  const repo = String(ctx.query.repo || defaultRepo());
  const perPage = Number(ctx.query.per_page || 20);
  if (!repo) {
    ctx.status = 400;
    ctx.body = { error: "未指定仓库，且注册表中没有任何已纳管的仓库" };
    return;
  }
  try {
    const { data } = await axios.get(`${GH_API}/repos/${repo}/actions/runs`, {
      headers: ghHeaders(repo),
      params: { per_page: perPage },
      // 面板在墙内，需要时可走代理：CIP_HTTPS_PROXY
      proxy: false,
      timeout: 15000
    });
    ctx.body = (data.workflow_runs || []).map((run: any) => ({
      id: run.id,
      name: run.name,
      branch: run.head_branch,
      event: run.event,
      status: run.status, // queued / in_progress / completed
      conclusion: run.conclusion, // success / failure / cancelled ...
      run_number: run.run_number,
      html_url: run.html_url,
      created_at: run.created_at
    }));
  } catch (err: any) {
    ctx.status = err?.response?.status || 500;
    ctx.body = { error: explainGhError(repo, err) };
  }
});

// 触发 workflow_dispatch
router.post("/dispatch", permission({ level: ROLE.ADMIN, token: false }), async (ctx) => {
  const { repo, workflow, ref = "main" } = ctx.request.body as any;
  if (!repo || !workflow) {
    ctx.status = 400;
    ctx.body = { error: "缺少 repo 或 workflow" };
    return;
  }
  try {
    await axios.post(
      `${GH_API}/repos/${repo}/actions/workflows/${workflow}/dispatches`,
      { ref },
      { headers: ghHeaders(repo), proxy: false, timeout: 15000 }
    );
    ctx.body = { ok: true };
  } catch (err: any) {
    ctx.status = err?.response?.status || 500;
    ctx.body = { error: explainGhError(repo, err) };
  }
});

export default router;
