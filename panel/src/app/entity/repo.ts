// 仓库注册表实体（自研补充，非 MCSManager 原生）。
//
// 「哪些仓库被纳入管理」以本表为唯一真相源；「某个 runner 属于哪个仓库」仍然是
// runner 实例 config.tag[0] 里的既成事实，两者用 slug（owner/repo）关联。

// GitHub 的 owner 最长 39 字符、只允许字母数字和连字符；repo 名额外允许 . _ -
const SLUG_REGEX = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

// @Entity
export class RepoConfig {
  public slug = ""; // owner/repo，主键
  public url = ""; // https://github.com/owner/repo
  public token = ""; // 该仓库专用 PAT；留空则回退全局 CIP_GITHUB_TOKEN
  public remark = "";
  public createdAt = 0;
}

export function isValidSlug(slug: string) {
  // 额外挡掉 ".."：StorageSubsystem 用 slug 派生文件名，要防路径穿越
  return SLUG_REGEX.test(slug) && !slug.includes("..");
}

// 与 daemon/src/service/runner_provision.ts 的 repoSlug() 对齐：
// https://github.com/owner/repo(.git)、git@github.com:owner/repo.git、owner/repo → owner/repo
// 解析不出合法 slug 时返回空串（daemon 那边是原样返回，这里更严格，因为要落盘）
export function parseRepoSlug(input: string): string {
  const raw = String(input || "").trim();
  if (!raw) return "";
  const path = raw
    .replace(/^git@[^:]+:/, "")
    .replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]+\//, "")
    .replace(/\.git$/, "")
    .replace(/^\/+|\/+$/g, "");
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) return "";
  const slug = `${parts[0]}/${parts[1]}`;
  return isValidSlug(slug) ? slug : "";
}

export function repoUrlOf(slug: string) {
  return `https://github.com/${slug}`;
}

// StorageSubsystem 的文件名黑名单含 "/"，slug 不能直接当主键。owner 与 repo 的
// 命名规则都不允许 "@"，所以用它做分隔符可逆且不会碰撞。
export function slugToFileId(slug: string) {
  return slug.replace("/", "@");
}

export function fileIdToSlug(fileId: string) {
  return fileId.replace("@", "/");
}
