import { Socket } from "socket.io";
import RouterContext from "../entity/ctx";
import { $t } from "../i18n";
import { IPacket } from "../service/protocol";
import logger from "./log";
import { routerApp } from "./router_app";

// The controller itself lives in router_app.ts; re-exported here unchanged because every
// router imports routerApp from "../service/router", and repointing ten files at a new path
// would buy nothing.
export { RouterApp, routerApp } from "./router_app";

/**
 * Based on Socket.io for routing decentralization and secondary forwarding
 * @param {Socket} socket
 */
export function navigation(socket: Socket) {
  // Full-life session variables (Between connection and disconnection)
  const session: any = {};
  // Register all middleware with Socket
  for (const fn of routerApp.getMiddlewares()) {
    socket.use((packet, next) => {
      const protocol = packet[1] as IPacket;
      if (!protocol)
        return logger.info(`session ${socket.id} request data protocol format is incorrect`);
      const ctx = new RouterContext(protocol.uuid, socket, session);
      fn(packet[0], ctx, protocol.data, next);
    });
  }
  // Register all events with Socket
  for (const event of routerApp.eventNames()) {
    socket.on(event as string, (protocol: IPacket) => {
      if (!protocol)
        return logger.info(`session ${socket.id} request data protocol format is incorrect`);
      const ctx = new RouterContext(protocol.uuid, socket, session, event.toString());
      routerApp.emitRouter(event as string, ctx, protocol.data);
    });
  }
  // The connected event route is triggered
  const ctx = new RouterContext(null, socket, session);
  routerApp.emitRouter("connection", ctx, null);
}

// The authentication routing order must be the first load. These routing orders cannot be changed without authorization
import "../routers/auth_router";
import "../routers/environment_router";
import "../routers/file_router";
import "../routers/info_router";
import "../routers/instance_event_router";
import "../routers/Instance_router";
import "../routers/passport_router";
import "../routers/schedule_router";
import "../routers/stream_router";
import "../routers/runner_router";

logger.info($t("TXT_CODE_router.initComplete"));
