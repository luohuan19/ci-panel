import Router from "@koa/router";
import { isEmpty, toBoolean, toNumber, toText } from "mcsmanager-common";
import { ROLE } from "../entity/user";
import { $t } from "../i18n";
import { speedLimit } from "../middleware/limit";
import permission from "../middleware/permission";
import validator from "../middleware/validator";
import { checkInstanceAdvancedParams } from "../service/instance_service";
import { operationLogger } from "../service/operation_logger";
import { getUserPermission, getUserUuid } from "../service/passport_service";
import { timeUuid } from "../service/password";
import { isHaveInstanceByUuid, isTopPermissionByUuid } from "../service/permission_service";
import RemoteRequest, { RemoteRequestTimeoutError } from "../service/remote_command";
import RemoteServiceSubsystem from "../service/remote_service";
import { systemConfig } from "../setting";

const router = new Router({ prefix: "/protected_instance" });

// Routing permission verification middleware
router.use(async (ctx, next) => {
  const instanceUuid = String(ctx.query.uuid);
  const daemonId = String(ctx.query.daemonId);
  const userUuid = getUserUuid(ctx);
  if (isHaveInstanceByUuid(userUuid, daemonId, instanceUuid)) {
    await next();
  } else {
    ctx.status = 403;
    ctx.body = $t("TXT_CODE_permission.forbiddenInstance");
  }
});

// [Low-level Permission]
// Enable instance routing
router.all(
  "/open",
  permission({ level: ROLE.USER }),
  validator({ query: { daemonId: String, uuid: String } }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      const instanceUuid = String(ctx.query.uuid);
      const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
      const result = await new RemoteRequest(remoteService).request("instance/open", {
        instanceUuids: [instanceUuid]
      });
      operationLogger.log("instance_start", {
        daemon_id: daemonId,
        instance_id: instanceUuid,
        operator_ip: ctx.ip,
        operator_name: ctx.session?.["userName"],
        instance_name: result?.instances?.[0]?.nickname
      });
      ctx.body = result;
    } catch (err) {
      if (err instanceof RemoteRequestTimeoutError) {
        ctx.body = {};
        return;
      }
      ctx.body = err;
    }
  }
);

// [Low-level Permission]
// The instance closes the route
router.all(
  "/stop",
  permission({ level: ROLE.USER }),
  validator({ query: { daemonId: String, uuid: String } }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      const instanceUuid = String(ctx.query.uuid);
      const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
      const result = await new RemoteRequest(remoteService).request("instance/stop", {
        instanceUuids: [instanceUuid]
      });
      operationLogger.log("instance_stop", {
        daemon_id: daemonId,
        instance_id: instanceUuid,
        operator_ip: ctx.ip,
        operator_name: ctx.session?.["userName"],
        instance_name: result?.instances?.[0]?.nickname
      });
      ctx.body = result;
    } catch (err) {
      ctx.body = err;
    }
  }
);

// [Low-level Permission]
// Send the command route to the instance
// At this stage, WS cross-panel command transfer has been implemented, and this interface is reserved as an API interface
router.all(
  "/command",
  permission({ level: ROLE.USER }),
  validator({ query: { daemonId: String, uuid: String, command: String } }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      const instanceUuid = String(ctx.query.uuid);
      const command = String(ctx.query.command);
      const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
      const result = await new RemoteRequest(remoteService).request("instance/command", {
        instanceUuid,
        command
      });
      ctx.body = result;
    } catch (err) {
      ctx.body = err;
    }
  }
);

// [Low-level Permission]
// restart the instance
router.all(
  "/restart",
  permission({ level: ROLE.USER }),
  validator({ query: { daemonId: String, uuid: String } }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      const instanceUuid = String(ctx.query.uuid);
      const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
      const result = await new RemoteRequest(remoteService).request("instance/restart", {
        instanceUuids: [instanceUuid]
      });
      operationLogger.log("instance_restart", {
        daemon_id: daemonId,
        instance_id: instanceUuid,
        operator_ip: ctx.ip,
        operator_name: ctx.session?.["userName"],
        instance_name: result?.instances?.[0]?.nickname
      });
      ctx.body = result;
    } catch (err) {
      ctx.body = err;
    }
  }
);

// [Low-level Permission]
// terminate the instance
router.all(
  "/kill",
  permission({ level: ROLE.USER }),
  validator({ query: { daemonId: String, uuid: String } }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      const instanceUuid = String(ctx.query.uuid);
      const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
      const result = await new RemoteRequest(remoteService).request("instance/kill", {
        instanceUuids: [instanceUuid]
      });
      operationLogger.warning("instance_kill", {
        daemon_id: daemonId,
        instance_id: instanceUuid,
        operator_ip: ctx.ip,
        operator_name: ctx.session?.["userName"],
        instance_name: result?.instances?.[0]?.nickname
      });
      ctx.body = result;
    } catch (err) {
      ctx.body = err;
    }
  }
);

// [Low-level Permission]
// stop an asynchronous task
router.all(
  "/stop_asynchronous",
  permission({ level: ROLE.USER }),
  validator({
    query: { daemonId: String, uuid: String }
  }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      const instanceUuid = String(ctx.query.uuid);
      const parameter = ctx.request.body;
      const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
      // No permission check is required because "Parameter.TaskId" is not easily obtained.
      const result = await new RemoteRequest(remoteService).request("instance/stop_asynchronous", {
        instanceUuid,
        parameter
      });
      ctx.body = result;
    } catch (err) {
      ctx.body = err;
    }
  }
);

// [Low-level Permission]
// Request to establish a data stream dedicated channel with the daemon
router.post(
  "/stream_channel",
  permission({ level: ROLE.USER }),
  validator({ query: { daemonId: String, uuid: String } }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      const instanceUuid = String(ctx.query.uuid);
      const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
      if (!remoteService) throw new Error($t("TXT_CODE_dd559000") + ` Daemon ID: ${daemonId}`);
      const addr = remoteService.config.addr;
      const prefix = remoteService.config.prefix;
      const remoteMappings = remoteService.config.getConvertedRemoteMappings();
      const password = timeUuid();
      await new RemoteRequest(remoteService).request("passport/register", {
        name: "stream_channel",
        password: password,
        parameter: {
          instanceUuid
        }
      });
      ctx.body = {
        password,
        addr,
        prefix,
        remoteMappings
      };
    } catch (err) {
      ctx.body = err;
    }
  }
);

// [Low-level Permission]
// Update instance low-privilege configuration data (normal user)
router.put(
  "/instance_update",
  speedLimit(3),
  permission({ level: ROLE.USER }),
  validator({
    query: { uuid: String, daemonId: String },
    body: {}
  }),
  async (ctx) => {
    try {
      // Here is the low-privileged user configuration setting interface,
      // in order to prevent data injection, a layer of filtering must be performed
      const daemonId = toText(ctx.query.daemonId);
      const instanceUuid = toText(ctx.query.uuid);
      const config = ctx.request.body;

      let instanceTags: string[] | null = null;

      if (config.tag instanceof Array && isTopPermissionByUuid(getUserUuid(ctx))) {
        instanceTags = (config.tag as any[]).map((tag: any) => {
          const tmp = String(tag).trim();
          if (tmp.length > 20) throw new Error($t("TXT_CODE_1556989"));
          return tmp;
        });
        if (instanceTags.length > 6) {
          throw new Error($t("TXT_CODE_dc9fb6ce"));
        }
        instanceTags = instanceTags!.sort((a, b) => (a > b ? 1 : -1));
      }

      // event task configuration
      const eventTask = {
        autoStart: toBoolean(config.eventTask?.autoStart),
        autoRestart: toBoolean(config.eventTask?.autoRestart),
        autoRestartMaxTimes: toNumber(config.eventTask?.autoRestartMaxTimes)
      };

      // web terminal settings
      const terminalOption = {
        haveColor: toBoolean(config.terminalOption?.haveColor),
        pty: toBoolean(config.terminalOption?.pty),
        ptyWindowCol: toNumber(config.terminalOption?.ptyWindowCol),
        ptyWindowRow: toNumber(config.terminalOption?.ptyWindowRow)
      };

      const crlf = !isEmpty(config.crlf) ? toNumber(config?.crlf) : null;
      const oe = !isEmpty(config.oe) ? toText(config?.oe) : null;
      const ie = !isEmpty(config.ie) ? toText(config?.ie) : null;
      const fileCode = toText(config.fileCode);
      const stopCommand = config.stopCommand ? toText(config.stopCommand) : null;
      const remoteService = RemoteServiceSubsystem.getInstance(daemonId || "");
      const isTopPermission = isTopPermissionByUuid(getUserUuid(ctx));

      let advancedConfig = {};
      advancedConfig = checkInstanceAdvancedParams(config, isTopPermission);

      await new RemoteRequest(remoteService).request("instance/update", {
        instanceUuid,
        config: {
          eventTask: !isEmpty(config.eventTask) ? eventTask : null,
          terminalOption: !isEmpty(config.terminalOption) ? terminalOption : null,
          crlf,
          oe,
          ie,
          stopCommand,
          tag: instanceTags,
          fileCode,
          ...advancedConfig
        }
      });
      ctx.body = true;
    } catch (err) {
      ctx.body = err;
    }
  }
);

// [Low-level Permission]
// Get the terminal log of an instance
router.get(
  "/outputlog",
  permission({ level: ROLE.USER, speedLimit: false }),
  validator({ query: { daemonId: String, uuid: String } }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      const instanceUuid = String(ctx.query.uuid);
      const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
      let result = await new RemoteRequest(remoteService).request("instance/outputlog", {
        instanceUuid
      });
      if (ctx.query.size) {
        let size,
          sizeStr = ctx.query.size;
        if (sizeStr instanceof Array) {
          sizeStr = sizeStr[0];
        }
        size = parseInt(sizeStr);
        if (sizeStr.toLowerCase().endsWith("kb")) {
          size *= 1024;
        }
        if (result.length > size) {
          result = result.slice(-size);
        }
      }
      ctx.body = result;
    } catch (err) {
      ctx.body = err;
    }
  }
);

// [Low-level Permission]
// start asynchronous task
router.post(
  "/asynchronous",
  speedLimit(3),
  permission({ level: ROLE.USER }),
  validator({
    query: { daemonId: String, uuid: String, task_name: String },
    body: {}
  }),
  async (ctx) => {
    try {
      const daemonId = String(ctx.query.daemonId);
      const instanceUuid = String(ctx.query.uuid);
      const taskName = String(ctx.query.task_name).toLowerCase().trim();
      const parameter = ctx.request.body;
      const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
      const result = await new RemoteRequest(remoteService).request("instance/asynchronous", {
        instanceUuid,
        taskName,
        parameter,
        role: getUserPermission(ctx) // Permission check is performed in the daemon
      });
      ctx.body = result;
    } catch (err) {
      ctx.body = err;
    }
  }
);

export default router;
