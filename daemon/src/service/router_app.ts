import { EventEmitter } from "events";
import { inspect } from "util";
import RouterContext from "../entity/ctx";
import { responseError } from "./protocol";

// responseError takes Error | string, and a rejection value can be neither — `throw 42` and
// `Promise.reject(undefined)` are both legal. Narrow here rather than widening the protocol
// signature to any, so the packet the panel receives always carries something readable.
function toReportableError(error: unknown): Error | string {
  if (error instanceof Error) return error;
  if (typeof error === "string") return error;
  // inspect() rather than String(): `String(Object.create(null))` throws TypeError, and this
  // function is called from inside a .catch — a throw there is a fresh unhandled rejection,
  // which under Node's default --unhandled-rejections=throw takes the daemon down. That is a
  // worse outcome than the silence this whole wrapper exists to fix. inspect also keeps the
  // shape of a plain object ({ code: 'ENOSPC' }) instead of flattening it to [object Object].
  return inspect(error);
}

// The class and its singleton live here rather than alongside navigation() in router.ts.
// router.ts imports every router at its foot, and each router reads routerApp back out of
// router.ts — a cycle. Under the production build tsc emits the requires in source order, so
// the cycle happens to unwind correctly (that is what router.ts's "authentication routing
// order must be the first load" comment is guarding); under any toolchain that hoists imports
// instead, those routers run before routerApp has been assigned. As a leaf module there is no
// cycle left to get right.
class RouterApp extends EventEmitter {
  public readonly middlewares: Array<Function>;

  constructor() {
    super();
    this.middlewares = [];
  }

  emitRouter(event: string, ctx: RouterContext, data: any) {
    try {
      // service logic routing trigger point
      super.emit(event, ctx, data);
    } catch (error: any) {
      responseError(ctx, error);
    }
    return this;
  }

  // The return type is unknown rather than void | Promise<void>. TypeScript has a special
  // rule letting a function with any return type be assigned to a void-returning function
  // type, and spelling it as a union throws that rule away — Instance_router has a handler
  // returning boolean that then fails to compile. Nothing here cares what a handler returns,
  // only whether it is a promise that can reject.
  on(event: string, fn: (ctx: RouterContext, data: any) => unknown) {
    // Register a wrapper rather than fn itself. Nearly every handler is async, and an async
    // function reports failure by returning a rejected promise — super.emit() in emitRouter
    // has long returned by the time that settles, so the try/catch there never sees it. The
    // caller receives no packet and nothing reaches the log: the panel waits out its RPC
    // timeout and blames the node's network. Funnel the rejection into the same responseError
    // path a synchronous throw already takes, so the caller gets a real error and the cause is
    // written down.
    //
    // The cost of wrapping: removeListener(event, fn) with the original handler no longer
    // unregisters it, and listeners() returns wrappers. Nothing in daemon/src unregisters a
    // router handler — keep it that way, or keep a handler → wrapper map here.
    return super.on(event, (ctx: RouterContext, data: any) => {
      let result: unknown;
      try {
        result = fn(ctx, data);
      } catch (error: unknown) {
        return responseError(ctx, toReportableError(error));
      }
      // Adopt unconditionally rather than testing the result first. `instanceof Promise` is
      // false for a library's thenable and for a native promise from another realm, and even a
      // duck-typed `typeof result.then === "function"` has to read the property — a `then`
      // getter that throws would then throw right here, outside the try above, escaping this
      // narrowing entirely. Promise.resolve covers every one of those: it reads `then` exactly
      // once, turns a throwing getter into a rejection instead of a synchronous throw, and
      // passes non-thenables straight through. The cost is a promise pair per event, which is
      // nothing against a socket router that handles commands rather than a data plane.
      void Promise.resolve(result).catch((error: unknown) =>
        responseError(ctx, toReportableError(error))
      );
    });
  }

  use(fn: (event: string, ctx: RouterContext, data: any, next: Function) => void) {
    this.middlewares.push(fn);
  }

  getMiddlewares() {
    return this.middlewares;
  }
}

// routing controller singleton class
const routerApp = new RouterApp();

export { RouterApp, routerApp };
