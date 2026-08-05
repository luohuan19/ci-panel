import Router from "@koa/router";
import axios from "axios";
import Koa from "koa";
import { GlobalVariable } from "mcsmanager-common";
import SystemConfig from "../entity/setting";
import { ROLE } from "../entity/user";
import { $t } from "../i18n";
import permission from "../middleware/permission";
import validator from "../middleware/validator";
import { logger } from "../service/log";
import { operationLogger } from "../service/operation_logger";
import { check, checkBanIp, login, logout } from "../service/passport_service";
import { checkSafeUrl } from "../utils/url";
import userSystem, { TwoFactorError } from "../service/user_service";
import { systemConfig } from "../setting";

const router = new Router({ prefix: "/auth" });

// [Public Permission]
// login route
router.post(
  "/login",
  permission({ token: false, level: null }),
  validator({ body: { username: String, password: String } }),
  async (ctx: Koa.ParameterizedContext) => {
    if (systemConfig?.ssoEnabled && systemConfig?.ssoOnlyMode) {
      ctx.body = new Error("Password login is disabled. Please use SSO.");
      return;
    }
    const userName = String(ctx.request.body.username);
    const passWord = String(ctx.request.body.password);
    const code = String(ctx.request.body.code);
    if (!checkBanIp(ctx)) throw new Error($t("TXT_CODE_router.login.ban"));
    if (check(ctx)) return (ctx.body = "Logined");
    try {
      ctx.body = login(ctx, userName, passWord, code);
      operationLogger.info("user_login", {
        operator_ip: ctx.ip,
        operator_name: userName,
        login_result: true
      });
    } catch (error: any) {
      if (error instanceof TwoFactorError && !code) {
        ctx.body = "NEED_2FA";
        return;
      }
      ctx.body = error;
      operationLogger.warning("user_login", {
        operator_ip: ctx.ip,
        operator_name: userName,
        login_result: false
      });
    }
  }
);

// [Public Permission]
// exit route
router.get(
  "/logout",
  permission({ token: false, level: null, speedLimit: false }),
  async (ctx: Koa.ParameterizedContext) => {
    logout(ctx);
    ctx.body = true;
  }
);

// [Public Permission]
// Display the text of the login interface
router.all(
  "/login_info",
  permission({ token: false, level: null, speedLimit: false }),
  async (ctx: Koa.ParameterizedContext) => {
    ctx.body = {
      loginInfo: systemConfig?.loginInfo
    };
  }
);

// [Public Permission]
// Get the state information that the panel can expose
router.all(
  "/status",
  permission({ token: false, level: null, speedLimit: false }),
  async (ctx: Koa.ParameterizedContext) => {
    let isInstall = true;
    if (userSystem.objects.size === 0) {
      isInstall = false;
    }
    ctx.body = {
      versionChange: GlobalVariable.get("versionChange", null),
      isInstall,
      language: systemConfig?.language || null,
      settings: {
        canFileManager: systemConfig?.canFileManager || false,
        allowChangeCmd: systemConfig?.allowChangeCmd || false,
        ssoEnabled: systemConfig?.ssoEnabled || false,
        ssoOnlyMode: systemConfig?.ssoOnlyMode || false
      } as Partial<SystemConfig>
    };
  }
);

// [Public Permission]
// Install the panel, only available when the number of user entities is 0
router.all(
  "/install",
  permission({ token: false, level: null }),
  validator({ body: { username: String, password: String } }),
  async (ctx: Koa.ParameterizedContext) => {
    const userName = String(ctx.request.body.username);
    const passWord = String(ctx.request.body.password);
    if (userSystem.objects.size === 0) {
      if (!userSystem.validatePassword(passWord))
        throw new Error($t("TXT_CODE_router.user.passwordCheck"));
      logger.info($t("TXT_CODE_router.login.init", { userName }));
      await userSystem.create({
        userName,
        passWord,
        permission: 10
      });
      operationLogger.log("user_create", {
        operator_ip: ctx.ip,
        operator_name: userName,
        target_user_name: userName
      });
      login(ctx, userName, passWord);
      return (ctx.body = true);
    }
    throw new Error($t("TXT_CODE_router.user.installed"));
  }
);

router.all(
  "/proxy",
  validator({ query: { target: String } }),
  permission({ level: ROLE.ADMIN }),
  async (ctx) => {
    // 声明在 try 之外:下面的 catch 要用它拼日志。
    const target = String(ctx.query.target);
    try {
      // target 完全由调用方指定,而这个路由把响应体原样回传 —— 不校验的话它就是一个
      // 面向面板所在内网的读取原语(SSRF):管理员能借面板去探测 169.254.169.254、
      // 内网 gitlab、localhost 上只监听回环的服务。ADMIN 能改配置不等于 ADMIN 该能
      // 拿面板当跳板,何况管理员凭据本身也会被钓走。
      if (!checkSafeUrl(target)) {
        ctx.status = 403;
        ctx.body = $t("TXT_CODE_PROXY_UNSAFE_TARGET");
        return;
      }
      const response = await axios.request({
        method: (ctx.query.method as string) || ctx.method,
        url: target,
        // 不跟随重定向:否则一个公网可解析的域名 302 到 127.0.0.1 就把上面的校验绕过去了。
        maxRedirects: 0
      });
      if (response.status !== 200) throw new Error("Response code != 200");
      ctx.body = response.data;
    } catch (err) {
      // 不把 err 原样回传:axios 的错误对象序列化后带 stack(服务器绝对路径)和完整的
      // request config,而 Koa 会把它当 200 发出去。maxRedirects: 0 之后每个重定向目标
      // 都会走到这里,所以这条路径比从前好走得多。详情进日志,调用方只拿到一句话。
      logger.error(`[auth/proxy] request to ${target} failed`, err);
      ctx.status = 502;
      ctx.body = $t("TXT_CODE_PROXY_REQUEST_FAILED");
    }
  }
);

export default router;
