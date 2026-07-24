import fs from "fs-extra";
import path from "path";
import Instance from "../entity/instance/instance";
import { $t } from "../i18n";
import logger from "../service/log";
import * as protocol from "../service/protocol";
import { routerApp } from "../service/router";
import InstanceSubsystem from "../service/system_instance";

import { arrayUnique, toNumber } from "mcsmanager-common";
import ProcessInfoCommand from "../entity/commands/process_info";
import { IInstanceDetail } from "../service/interfaces";
import { ROLE } from "../service/protocol";

// Some instances operate router authentication middleware
routerApp.use((event, ctx, data, next) => {
  if (event === "instance/new" && data) return next();
  if (event === "instance/overview") return next();
  if (event === "instance/select") return next();
  if (event === "instance/asynchronous") return next();
  if (event === "instance/query_asynchronous") return next();
  if (event === "instance/stop_asynchronous") return next();
  if (event.startsWith("instance")) {
    if (data.instanceUuids) return next();
    const instanceUuid = data.instanceUuid;
    if (!InstanceSubsystem.exists(instanceUuid)) {
      return protocol.error(ctx, event, {
        instanceUuid: instanceUuid,
        err: `The operation failed, the instance ${instanceUuid} does not exist.`
      });
    }
  }
  next();
});

// Get the list of instances of this daemon (query)
routerApp.on("instance/select", (ctx, data) => {
  const page = toNumber(data.page) ?? 1;
  const pageSize = toNumber(data.pageSize) ?? 1;
  const condition = data.condition;
  const targetTag = data.condition.tag;
  const overview: IInstanceDetail[] = [];
  // keyword condition query
  const queryWrapper = InstanceSubsystem.getQueryMapWrapper();
  const allTags: string[] = [];

  let searchTags: string[] = [];
  if (targetTag instanceof Array && targetTag.length > 0) {
    searchTags = targetTag.map((v) => String(v).trim());
  }

  let result = queryWrapper.select<Instance>((v) => {
    if (v.config.tag) allTags.push(...v.config.tag);
    if (InstanceSubsystem.isGlobalInstance(v)) return false;
    if (
      condition.instanceName &&
      !v.config.nickname.toLowerCase().includes(condition.instanceName.toLowerCase())
    )
      return false;
    if (condition.status && v.instanceStatus !== Number(condition.status)) return false;

    if (searchTags.length > 0) {
      const myTags = v.config.tag || [];
      const res = myTags.filter((v) => searchTags.includes(v));
      if (res.length === 0 || res.length !== searchTags.length) return false;
    }
    return true;
  });
  // sort first by status， then by nickname
  result.sort((a, b) => {
    if (a.status() !== b.status()) {
      return b.status() - a.status();
    }
    return a.config.nickname >= b.config.nickname ? 1 : -1;
  });
  // paging function
  const pageResult = queryWrapper.page<Instance>(result, page, pageSize);
  // filter unwanted data
  pageResult.data.forEach((instance) => {
    overview.push({
      instanceUuid: instance.instanceUuid,
      started: instance.startCount,
      autoRestarted: instance.autoRestartCount,
      status: instance.status(),
      config: instance.config,
      info: instance.info
    });
  });

  protocol.response(ctx, {
    page: pageResult.page,
    pageSize: pageResult.pageSize,
    maxPage: pageResult.maxPage,
    allTags: arrayUnique(allTags).slice(0, 60),
    data: overview
  });
});

// Get an overview of this daemon instance
routerApp.on("instance/overview", (ctx) => {
  const overview: IInstanceDetail[] = [];
  InstanceSubsystem.getInstances().forEach((instance) => {
    overview.push({
      instanceUuid: instance.instanceUuid,
      started: instance.startCount,
      autoRestarted: instance.autoRestartCount,
      status: instance.status(),
      config: instance.config,
      info: instance.info
    });
  });

  protocol.msg(ctx, "instance/overview", overview);
});

// Get an overview of some instances of this daemon
routerApp.on("instance/section", (ctx, data) => {
  const instanceUuids = data.instanceUuids as string[];
  const overview: IInstanceDetail[] = [];
  InstanceSubsystem.getInstances().forEach((instance) => {
    instanceUuids.forEach((targetUuid) => {
      if (targetUuid === instance.instanceUuid) {
        overview.push({
          instanceUuid: instance.instanceUuid,
          started: instance.startCount,
          autoRestarted: instance.autoRestartCount,
          status: instance.status(),
          config: instance.config,
          info: instance.info
        });
      }
    });
  });
  protocol.msg(ctx, "instance/section", overview);
});

// View details of a single instance
routerApp.on("instance/detail", async (ctx, data) => {
  try {
    const instanceUuid = data.instanceUuid;
    const instance = InstanceSubsystem.getInstance(instanceUuid);
    if (!instance) throw new Error($t("TXT_CODE_3bfb9e04"));
    let processInfo = null;
    let space = 0;
    try {
      // Parts that may be wrong due to file permissions, avoid affecting the acquisition of the entire configuration
      processInfo = await instance.forceExec(new ProcessInfoCommand());
    } catch (err: any) {}
    protocol.msg(ctx, "instance/detail", {
      instanceUuid: instance.instanceUuid,
      started: instance.startCount,
      autoRestarted: instance.autoRestartCount,
      status: instance.status(),
      config: instance.config,
      info: instance.info,
      space,
      processInfo
    });
  } catch (err: any) {
    protocol.error(ctx, "instance/detail", { err: err.message });
  }
});

// create a new application instance
routerApp.on("instance/new", (ctx, data) => {
  const config = data;
  try {
    const newInstance = InstanceSubsystem.createInstance(config);
    protocol.msg(ctx, "instance/new", {
      instanceUuid: newInstance.instanceUuid,
      config: newInstance.config,
      nickname: newInstance.config.nickname
    });
  } catch (err: any) {
    protocol.error(ctx, "instance/new", { instanceUuid: null, err: err.message });
  }
});

// update instance data
routerApp.on("instance/update", (ctx, data) => {
  const instanceUuid = data.instanceUuid;
  const config = data.config;
  try {
    // 标签（仓库分组）在创建时确定后锁死：更新时忽略 tag，禁止改动/新增
    if (config && typeof config === "object") delete config.tag;
    InstanceSubsystem.getInstance(instanceUuid)?.parameters(config);
    protocol.msg(ctx, "instance/update", { instanceUuid });
  } catch (err: any) {
    protocol.error(ctx, "instance/update", { instanceUuid: instanceUuid, err: err.message });
  }
});

// Request to forward all IO data of an instance
routerApp.on("instance/forward", (ctx, data) => {
  const targetInstanceUuid = data.instanceUuid;
  const isforward: boolean = data.forward;
  try {
    // InstanceSubsystem.getInstance(targetInstanceUuid);
    if (isforward) {
      logger.info(
        $t("TXT_CODE_Instance_router.requestIO", {
          id: ctx.socket.id,
          targetInstanceUuid: targetInstanceUuid
        })
      );
      InstanceSubsystem.forward(targetInstanceUuid, ctx.socket);
    } else {
      logger.info(
        $t("TXT_CODE_Instance_router.cancelIO", {
          id: ctx.socket.id,
          targetInstanceUuid: targetInstanceUuid
        })
      );
      InstanceSubsystem.stopForward(targetInstanceUuid, ctx.socket);
    }
    protocol.msg(ctx, "instance/forward", { instanceUuid: targetInstanceUuid });
  } catch (err: any) {
    protocol.error(ctx, "instance/forward", { instanceUuid: targetInstanceUuid, err: err.message });
  }
});

// open the instance
routerApp.on("instance/open", async (ctx, data) => {
  const disableResponse = data.disableResponse;
  const instances = [];
  for (const instanceUuid of data.instanceUuids) {
    const instance = InstanceSubsystem.getInstance(instanceUuid);
    instances.push({
      instanceUuid: instanceUuid,
      nickname: instance?.config.nickname
    });
    try {
      if (!instance) throw new Error($t("TXT_CODE_3bfb9e04"));
      await instance.execPreset("start");
      instance.autoRestartCount = 0;
      if (!disableResponse) protocol.msg(ctx, "instance/open", { instanceUuid, instances });
    } catch (err: any) {
      if (!disableResponse) {
        logger.error(
          $t("TXT_CODE_Instance_router.openInstanceErr", { instanceUuid: instanceUuid }),
          err
        );
        protocol.error(ctx, "instance/open", {
          instanceUuid: instanceUuid,
          nickname: instance?.config.nickname,
          err: err.message
        });
      }
    }
  }
});

// close the instance
routerApp.on("instance/stop", async (ctx, data) => {
  const disableResponse = data.disableResponse;
  const instances = [];
  for (const instanceUuid of data.instanceUuids) {
    const instance = InstanceSubsystem.getInstance(instanceUuid);
    instances.push({
      instanceUuid: instanceUuid,
      nickname: instance?.config.nickname
    });
    try {
      if (!instance) throw new Error($t("TXT_CODE_3bfb9e04"));
      await instance.execPreset("stop");
      //Note: Removing this reply will cause the front-end response to be slow, because the front-end will wait for the panel-side message to be forwarded
      if (!disableResponse) protocol.msg(ctx, "instance/stop", { instanceUuid, instances });
    } catch (err: any) {
      if (!disableResponse)
        protocol.error(ctx, "instance/stop", {
          instanceUuid: instanceUuid,
          nickname: instance?.config.nickname,
          err: err.message
        });
    }
  }
});

// restart the instance
routerApp.on("instance/restart", async (ctx, data) => {
  const disableResponse = data.disableResponse;
  const instances = [];
  for (const instanceUuid of data.instanceUuids) {
    const instance = InstanceSubsystem.getInstance(instanceUuid);
    instances.push({
      instanceUuid: instanceUuid,
      nickname: instance?.config.nickname
    });
    try {
      if (!instance) throw new Error($t("TXT_CODE_3bfb9e04"));
      await instance.execPreset("restart");
      if (!disableResponse) protocol.msg(ctx, "instance/restart", { instanceUuid, instances });
    } catch (err: any) {
      if (!disableResponse)
        protocol.error(ctx, "instance/restart", {
          instanceUuid: instanceUuid,
          nickname: instance?.config.nickname,
          err: err.message
        });
    }
  }
});

// terminate instance method
routerApp.on("instance/kill", async (ctx, data) => {
  const disableResponse = data.disableResponse;
  const instances = [];
  for (const instanceUuid of data.instanceUuids) {
    const instance = InstanceSubsystem.getInstance(instanceUuid);
    instances.push({
      instanceUuid: instanceUuid,
      nickname: instance?.config.nickname
    });
    if (!instance) continue;
    try {
      await instance.execPreset("kill");
      if (!disableResponse) protocol.msg(ctx, "instance/kill", { instanceUuid, instances });
    } catch (err: any) {
      if (!disableResponse)
        protocol.error(ctx, "instance/kill", {
          instanceUuid: instanceUuid,
          nickname: instance?.config.nickname,
          err: err.message
        });
    }
  }
});

// Send a command to the application instance
routerApp.on("instance/command", async (ctx, data) => {
  const disableResponse = data.disableResponse;
  const instanceUuid = data.instanceUuid;
  const command = data.command || "";
  const instance = InstanceSubsystem.getInstance(instanceUuid);
  try {
    if (!instance) throw new Error($t("TXT_CODE_3bfb9e04"));
    await instance.execPreset("command", command);
    if (!disableResponse) protocol.msg(ctx, "instance/command", { instanceUuid });
  } catch (err: any) {
    if (!disableResponse)
      protocol.error(ctx, "instance/command", { instanceUuid: instanceUuid, err: err.message });
  }
});

// delete instance
routerApp.on("instance/delete", (ctx, data) => {
  const instanceUuids = data.instanceUuids;
  const deleteFile = data.deleteFile;
  const instances = [];
  for (const instanceUuid of instanceUuids) {
    try {
      const instance = InstanceSubsystem.getInstance(instanceUuid);
      if (!instance) throw new Error($t("TXT_CODE_3bfb9e04"));
      instances.push({
        instanceUuid: instance.instanceUuid,
        nickname: instance.config.nickname
      });
      InstanceSubsystem.removeInstance(instanceUuid, deleteFile);
    } catch (err: any) {}
  }
  protocol.msg(ctx, "instance/delete", { instanceUuids, instances });
});

// perform complex asynchronous tasks
routerApp.on("instance/asynchronous", (ctx, data) => {
  const instanceUuid = data.instanceUuid;
  const taskName = data.taskName;
  const parameter = data.parameter;
  const instance = InstanceSubsystem.getInstance(instanceUuid);
  const role = data.role as ROLE;

  if (!role) {
    throw new Error("Invalid role");
  }

  if (!instance) {
    throw new Error("Invalid instance");
  }

  logger.info(
    $t("TXT_CODE_Instance_router.performTasks", {
      id: ctx.socket.id,
      uuid: instanceUuid,
      taskName: taskName
    })
  );

  // Instance software update via Command
  if (taskName === "update") {
    instance
      .execPreset("update", parameter)
      .then(() => {})
      .catch((err) => {
        logger.error(
          $t("TXT_CODE_Instance_router.performTasksErr", {
            uuid: instance.instanceUuid,
            taskName: taskName,
            nickname: instance.config.nickname,
            err: err
          })
        );
      });
    return protocol.response(ctx, true);
  }

  throw new Error(`Access denied: ${taskName} is not allowed for role ${role}`);
});

// Terminate the execution of complex asynchronous tasks
routerApp.on("instance/stop_asynchronous", (ctx, data) => {
  const instanceUuid = data.instanceUuid;
  const instance = InstanceSubsystem.getInstance(instanceUuid);

  const task = instance?.asynchronousTask;
  if (task && task.stop) {
    task
      .stop(instance)
      .then(() => {})
      .catch((err) => {});
  } else {
    return protocol.error(
      ctx,
      "instance/stop_asynchronous",
      $t("TXT_CODE_Instance_router.taskEmpty")
    );
  }

  protocol.response(ctx, true);
});

// Get instance terminal log
routerApp.on("instance/outputlog", async (ctx, data) => {
  const instanceUuid = data.instanceUuid;
  try {
    const filePath = path.join(InstanceSubsystem.LOG_DIR, `${instanceUuid}.log`);
    if (fs.existsSync(filePath)) {
      const text = await fs.readFile(filePath, { encoding: "utf-8" });
      return protocol.response(ctx, text);
    }
    protocol.responseError(ctx, new Error($t("TXT_CODE_Instance_router.terminalLogNotExist")), {
      disablePrint: true
    });
  } catch (err: any) {
    protocol.responseError(ctx, err);
  }
});
