import { Socket } from "socket.io";
import { describe, expect, it } from "vitest";
import RouterContext from "../../src/entity/ctx";
import { response } from "../../src/service/protocol";
import { RouterApp } from "../../src/service/router_app";

// Each case builds a fresh RouterApp rather than using the process-wide singleton:
// registrations would otherwise outlive the test that made them, and reaching for the
// singleton drags in every router module and its import-time side effects for no gain. It is
// the same class production runs.
//
// The packet contract the panel decodes. protocol.ts keeps these module-local, so they are
// restated here on purpose: panel/src/app/entity/remote_service.ts compares against the same
// two numbers, and a spec that imported the constant could not catch them drifting apart.
const STATUS_OK = 200;
const STATUS_ERR = 500;

interface SentPacket {
  event: string;
  packet: { uuid: string | null; status: number; event: string | null; data: any };
}

function fakeSocket() {
  const sent: SentPacket[] = [];
  const socket = {
    id: "spec-socket",
    handshake: { address: "127.0.0.1" },
    emit: (event: string, packet: SentPacket["packet"]) => {
      sent.push({ event, packet });
      return true;
    }
  };
  return { socket: socket as unknown as Socket, sent };
}

// The rejection handler runs on a microtask, so the assertions have to come after the event
// loop has turned once. setImmediate rather than Promise.resolve: it drains the whole
// microtask queue instead of advancing it by a single tick.
function settle() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

describe("a handler that fails must produce an error packet, not silence", () => {
  // This is the failure that cost a production node an afternoon. globalConfiguration.store()
  // threw ENOSPC inside the async "info/setting" handler; emitRouter's try/catch never saw it
  // because an async function signals failure by returning a rejected promise, and
  // EventEmitter.emit had already returned. Nothing was sent and nothing was logged, so the
  // panel sat out its 6s RPC timeout and told the operator to check the node's network.
  it("answers an async rejection on the same event the caller is listening to", async () => {
    const routerApp = new RouterApp();
    routerApp.on("spec/async_reject", async () => {
      throw new Error("ENOSPC: no space left on device, write");
    });
    const { socket, sent } = fakeSocket();

    routerApp.emitRouter(
      "spec/async_reject",
      new RouterContext("req-async", socket, {}, "spec/async_reject"),
      null
    );
    await settle();

    expect(sent).toHaveLength(1);
    // Same event name — the panel registers its one-shot listener on the event it emitted,
    // so a reply on any other channel is indistinguishable from no reply at all.
    expect(sent[0].event).toBe("spec/async_reject");
    expect(sent[0].packet.status).toBe(STATUS_ERR);
    expect(sent[0].packet.uuid).toBe("req-async");
    expect(String(sent[0].packet.data)).toContain("ENOSPC");
  });

  it("answers a rejection that carries no Error object", async () => {
    const routerApp = new RouterApp();
    routerApp.on("spec/async_reject_string", async () => {
      return Promise.reject("plain string rejection");
    });
    const { socket, sent } = fakeSocket();

    routerApp.emitRouter(
      "spec/async_reject_string",
      new RouterContext("req-string", socket, {}, "spec/async_reject_string"),
      null
    );
    await settle();

    expect(sent).toHaveLength(1);
    expect(sent[0].packet.status).toBe(STATUS_ERR);
    expect(String(sent[0].packet.data)).toContain("plain string rejection");
  });

  it("answers a rejecting thenable that is not a native Promise", async () => {
    // `instanceof Promise` is false for a library's thenable and for a native promise built in
    // another realm, so a wrapper keyed on it would drop exactly the rejections it exists to
    // catch. Nothing in daemon/src returns one today; this pins the guard rather than the
    // current call sites, because the day one does the symptom is silence.
    const routerApp = new RouterApp();
    routerApp.on("spec/thenable_reject", () => ({
      then(_resolve: (v: unknown) => void, reject: (e: unknown) => void) {
        reject(new Error("thenable rejection"));
      }
    }));
    const { socket, sent } = fakeSocket();

    routerApp.emitRouter(
      "spec/thenable_reject",
      new RouterContext("req-thenable", socket, {}, "spec/thenable_reject"),
      null
    );
    await settle();

    expect(sent).toHaveLength(1);
    expect(sent[0].packet.status).toBe(STATUS_ERR);
    expect(String(sent[0].packet.data)).toContain("thenable rejection");
  });

  it("answers a rejection value that is neither an Error nor a string", async () => {
    // responseError takes Error | string, but `Promise.reject(undefined)` is legal. The packet
    // must still carry something readable rather than the caller seeing nothing.
    const routerApp = new RouterApp();
    routerApp.on("spec/async_reject_undefined", async () => {
      return Promise.reject(undefined);
    });
    const { socket, sent } = fakeSocket();

    routerApp.emitRouter(
      "spec/async_reject_undefined",
      new RouterContext("req-undef", socket, {}, "spec/async_reject_undefined"),
      null
    );
    await settle();

    expect(sent).toHaveLength(1);
    expect(sent[0].packet.status).toBe(STATUS_ERR);
    expect(sent[0].packet.data).toBe("undefined");
  });

  it("still answers a synchronous throw", async () => {
    // emitRouter already handled this case; the wrapper must not have taken it away.
    const routerApp = new RouterApp();
    routerApp.on("spec/sync_throw", () => {
      throw new Error("thrown before any await");
    });
    const { socket, sent } = fakeSocket();

    routerApp.emitRouter(
      "spec/sync_throw",
      new RouterContext("req-sync", socket, {}, "spec/sync_throw"),
      null
    );
    await settle();

    expect(sent).toHaveLength(1);
    expect(sent[0].packet.status).toBe(STATUS_ERR);
    expect(String(sent[0].packet.data)).toContain("thrown before any await");
  });
});

describe("the success path is untouched", () => {
  it("sends exactly one OK packet for a handler that resolves", async () => {
    const routerApp = new RouterApp();
    routerApp.on("spec/async_ok", async (ctx) => {
      response(ctx, { ok: true });
    });
    const { socket, sent } = fakeSocket();

    routerApp.emitRouter(
      "spec/async_ok",
      new RouterContext("req-ok", socket, {}, "spec/async_ok"),
      null
    );
    await settle();

    // One packet, not two: wrapping the handler must not append an error alongside a reply
    // that already went out.
    expect(sent).toHaveLength(1);
    expect(sent[0].packet.status).toBe(STATUS_OK);
    expect(sent[0].packet.data).toEqual({ ok: true });
  });

  it("passes the request payload through to the handler unchanged", async () => {
    const seen: any[] = [];
    const routerApp = new RouterApp();
    routerApp.on("spec/async_payload", async (ctx, data) => {
      seen.push(data);
      response(ctx, null);
    });
    const { socket } = fakeSocket();

    routerApp.emitRouter(
      "spec/async_payload",
      new RouterContext("req-payload", socket, {}, "spec/async_payload"),
      { language: "zh_cn", port: 24444 }
    );
    await settle();

    expect(seen).toEqual([{ language: "zh_cn", port: 24444 }]);
  });
});

describe("a handler with no event on its context", () => {
  it("does not emit, and does not throw either", async () => {
    // The "connection" route is emitted with a context that has no event (router.ts builds it
    // with three arguments). responseError has nowhere to reply, but it must still absorb the
    // rejection rather than let it escape as an unhandled one and take the daemon down under
    // Node's default --unhandled-rejections=throw. Like the two success-path cases, this
    // passes against the unfixed code as well — it guards the wrapper, not the old defect.
    const routerApp = new RouterApp();
    routerApp.on("spec/no_event", async () => {
      throw new Error("failed with nowhere to reply");
    });
    const { socket, sent } = fakeSocket();

    routerApp.emitRouter("spec/no_event", new RouterContext(null, socket, {}), null);
    await settle();

    expect(sent).toHaveLength(0);
  });
});
