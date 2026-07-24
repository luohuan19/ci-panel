import Router from "@koa/router";
import Koa from "koa";

import "./service/remote_service";
import "./service/user_service";
import "./service/visual_data";

import ciRouter from "./routers/ci_router";
import serviceRouter from "./routers/daemon_router";
import environmentRouter from "./routers/environment_router";
import filemanager_router from "./routers/filemananger_router";
import lowUserRouter from "./routers/general_user_router";
import instanceRouter from "./routers/instance_admin_router";
import userInstanceRouter from "./routers/instance_operate_router";
import loginRouter from "./routers/login_router";
import businessUserRouter from "./routers/manage_user_router";
import overviewRouter from "./routers/overview_router";
import repoRouter from "./routers/repo_router";
import runnerRouter from "./routers/runner_router";
import scheduleRouter from "./routers/schedule_router";
import settingsRouter from "./routers/settings_router";
import ssoRouter from "./routers/sso_router";
import userRouter from "./routers/user_overview_router";

export function mountRouters(app: Koa<Koa.DefaultState, Koa.DefaultContext>) {
  const apiRouter = new Router({ prefix: "/api" });
  apiRouter.use(overviewRouter.routes()).use(overviewRouter.allowedMethods());
  apiRouter.use(userInstanceRouter.routes()).use(userInstanceRouter.allowedMethods());
  apiRouter.use(instanceRouter.routes()).use(instanceRouter.allowedMethods());
  apiRouter.use(serviceRouter.routes()).use(serviceRouter.allowedMethods());
  apiRouter.use(filemanager_router.routes()).use(filemanager_router.allowedMethods());
  apiRouter.use(businessUserRouter.routes()).use(businessUserRouter.allowedMethods());
  apiRouter.use(loginRouter.routes()).use(loginRouter.allowedMethods());
  apiRouter.use(lowUserRouter.routes()).use(lowUserRouter.allowedMethods());
  apiRouter.use(userRouter.routes()).use(userRouter.allowedMethods());
  apiRouter.use(scheduleRouter.routes()).use(scheduleRouter.allowedMethods());
  apiRouter.use(settingsRouter.routes()).use(settingsRouter.allowedMethods());
  apiRouter.use(ssoRouter.routes()).use(ssoRouter.allowedMethods());
  apiRouter.use(environmentRouter.routes()).use(environmentRouter.allowedMethods());
  apiRouter.use(ciRouter.routes()).use(ciRouter.allowedMethods()); // CI Job 看板（自研补充）
  apiRouter.use(runnerRouter.routes()).use(runnerRouter.allowedMethods()); // 一键添加 runner（自研补充）
  apiRouter.use(repoRouter.routes()).use(repoRouter.allowedMethods()); // 仓库注册表（自研补充）

  app.use(apiRouter.routes()).use(apiRouter.allowedMethods());
}
