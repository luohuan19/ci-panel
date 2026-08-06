import { EventEmitter } from "events";
import RouterContext from "../entity/ctx";
import { responseError } from "./protocol";

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
      } catch (error: any) {
        return responseError(ctx, error);
      }
      // Every handler that can fail is an async function, so a native promise is what comes
      // back and instanceof is enough.
      if (result instanceof Promise) result.catch((error: any) => responseError(ctx, error));
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
