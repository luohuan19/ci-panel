// 仓库注册表（自研补充，非 MCSManager 原生）：
// 「哪些 GitHub 仓库被纳入管理」的增删改查。runner 归属（config.tag[0]）不在这里改，
// 只在 /list 里实时聚合展示。
import Router from "@koa/router";
import { ROLE } from "../entity/user";
import permission from "../middleware/permission";
import validator from "../middleware/validator";
import RepoService from "../service/repo_service";

const router = new Router({ prefix: "/repo" });

// [Top-level Permission]
// 已纳管的仓库 + 每个仓库在各节点上的 runner 分布。
// 附带 unregistered（runner 的 tag 里有、但注册表还没收录的仓库）和 untaggedRunners。
router.get("/list", permission({ level: ROLE.ADMIN }), async (ctx) => {
  try {
    ctx.body = await RepoService.listWithRunners();
  } catch (err) {
    ctx.body = err;
  }
});

// [Top-level Permission]
// 纳管一个仓库。url 可传完整 URL，也可以直接传 owner/repo
router.post(
  "/add",
  permission({ level: ROLE.ADMIN }),
  validator({ body: { url: String } }),
  async (ctx) => {
    try {
      const { url, token, remark } = ctx.request.body as {
        url: string;
        token?: string;
        remark?: string;
      };
      const config = RepoService.add(url, token || "", remark || "");
      // token 不回传
      ctx.body = {
        slug: config.slug,
        url: config.url,
        remark: config.remark,
        createdAt: config.createdAt,
        hasToken: Boolean(config.token)
      };
    } catch (err) {
      ctx.body = err;
    }
  }
);

// [Top-level Permission]
// 改 PAT / 备注。token 传空串表示清空并回退到全局 CIP_GITHUB_TOKEN
router.put(
  "/update",
  permission({ level: ROLE.ADMIN }),
  validator({ body: { slug: String } }),
  async (ctx) => {
    try {
      const { slug, token, remark } = ctx.request.body as {
        slug: string;
        token?: string;
        remark?: string;
      };
      const config = RepoService.update(slug, { token, remark });
      ctx.body = {
        slug: config.slug,
        url: config.url,
        remark: config.remark,
        createdAt: config.createdAt,
        hasToken: Boolean(config.token)
      };
    } catch (err) {
      ctx.body = err;
    }
  }
);

// [Top-level Permission]
// 取消纳管。只摘注册表，不动该仓库名下的任何 runner 实例
router.delete(
  "/delete",
  permission({ level: ROLE.ADMIN }),
  validator({ query: { slug: String } }),
  async (ctx) => {
    try {
      RepoService.remove(String(ctx.query.slug));
      ctx.body = true;
    } catch (err) {
      ctx.body = err;
    }
  }
);

export default router;
