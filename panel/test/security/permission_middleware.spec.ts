import type Koa from "koa";
import { beforeEach, describe, expect, it } from "vitest";
import "../setup";
import permission from "../../src/app/middleware/permission";
import { ROLE, User } from "../../src/app/entity/user";
import userSystem from "../../src/app/service/user_service";
import { $t } from "../../src/app/i18n";

// permission() is the only thing standing between an HTTP request and every panel route. It has
// four independent ways to admit a request — API key, session, an unspecified level, and the
// `token: false` escape — and the build checks none of them. Each branch is pinned here.
//
// Placeholder credentials only — this is a public repository.
const KEY_ADMIN = "PLACEHOLDER_ADMIN_API_KEY";
const KEY_USER = "PLACEHOLDER_USER_API_KEY";
const KEY_BANNED = "PLACEHOLDER_BANNED_API_KEY";

const addUser = (uuid: string, permissionLevel: number, apiKey: string): User => {
  const u = new User();
  u.uuid = uuid;
  u.userName = `user-${uuid}`;
  u.permission = permissionLevel;
  u.apiKey = apiKey;
  userSystem.objects.set(uuid, u);
  return u;
};

// isAjax reads ctx.header, not ctx.request.header — the middleware touches both, so the fake
// carries both and keeps them the same object.
interface FakeSession extends Record<string, unknown> {
  save: () => void;
  maxAge?: number;
}
interface FakeCtx {
  status?: number;
  body?: unknown;
  method: string;
  query: Record<string, unknown>;
  header: Record<string, unknown>;
  request: { header: Record<string, unknown> };
  session: FakeSession | null;
}

const AJAX = { "x-requested-with": "XMLHttpRequest" };

const makeSession = (over: Record<string, unknown> = {}): FakeSession => ({
  login: true,
  token: "T",
  uuid: "u-admin",
  userName: "user-u-admin",
  save: () => {},
  ...over
});

const makeCtx = (over: Partial<FakeCtx> & { header?: Record<string, unknown> } = {}): FakeCtx => {
  const header = over.header ?? { ...AJAX };
  return {
    method: "GET",
    // Default to a token matching the default session's, so a case that is about something else
    // is not silently rejected by the CSRF check before it reaches the branch under test.
    query: { token: "T" },
    ...over,
    header,
    request: { header },
    session: over.session !== undefined ? over.session : makeSession()
  };
};

// Returns whether next() ran, plus the ctx it ran against.
const run = async (cfg: Parameters<typeof permission>[0], ctx: FakeCtx) => {
  let passed = false;
  await permission(cfg)(ctx as unknown as Koa.ParameterizedContext, async () => {
    passed = true;
  });
  return { passed, ctx };
};

// Four separate guards all answer 403. Asserting only the status cannot tell them apart, so a
// regression that swapped which one fires would stay green — hence the body assertions below.
const bodyOf = (ctx: FakeCtx) => String(ctx.body ?? "");

beforeEach(() => {
  userSystem.objects.clear();
  addUser("u-admin", ROLE.ADMIN, KEY_ADMIN);
  addUser("u-user", ROLE.USER, KEY_USER);
  addUser("u-banned", ROLE.BAN, KEY_BANNED);
});

describe("session-based authorisation", () => {
  it("admits a session whose permission meets the level", async () => {
    const { passed } = await run({ level: ROLE.USER }, makeCtx({
      session: makeSession({ uuid: "u-user", userName: "user-u-user" })
    }));
    expect(passed).toBe(true);
  });

  it("rejects a session whose permission is below the level", async () => {
    const { passed, ctx } = await run({ level: ROLE.ADMIN }, makeCtx({
      session: makeSession({ uuid: "u-user", userName: "user-u-user" })
    }));
    expect(passed).toBe(false);
    expect(ctx.status).toBe(403);
  });

  it("rejects when the session is not logged in", async () => {
    const { passed, ctx } = await run({ level: ROLE.USER }, makeCtx({
      session: makeSession({ login: false, uuid: "u-user", userName: "user-u-user" })
    }));
    expect(passed).toBe(false);
    expect(ctx.status).toBe(403);
  });

  it("rejects when the session names a user that no longer exists", async () => {
    const { passed, ctx } = await run({ level: ROLE.USER }, makeCtx({
      session: makeSession({ uuid: "u-deleted", userName: "gone" })
    }));
    expect(passed).toBe(false);
    expect(ctx.status).toBe(403);
  });

  it("logs a banned user out rather than merely refusing", async () => {
    // permission < 0 is a distinct branch: the session is destroyed, not just denied, so a
    // banned user cannot keep probing with the same cookie.
    const { passed, ctx } = await run({ level: ROLE.USER }, makeCtx({
      session: makeSession({ uuid: "u-banned", userName: "user-u-banned" })
    }));
    expect(passed).toBe(false);
    // logout() clears the fields and zeroes maxAge rather than dropping the session object.
    expect(ctx.session?.login).toBeNull();
    expect(ctx.session?.uuid).toBeNull();
    expect(ctx.session?.maxAge).toBe(0);
  });
});

describe("API-key authorisation", () => {
  it("admits a key whose owner meets the level, via header or query", async () => {
    for (const ctx of [
      makeCtx({ header: { "x-request-api-key": KEY_ADMIN }, session: null }),
      makeCtx({ query: { apikey: KEY_ADMIN }, session: null })
    ]) {
      const { passed } = await run({ level: ROLE.ADMIN, speedLimit: false }, ctx);
      expect(passed).toBe(true);
    }
  });

  it("BYPASSES the token and ajax checks entirely", async () => {
    // Documented, not incidental: an API request carries no session, so it cannot present a
    // CSRF token. The consequence is that the key alone is the whole credential.
    const { passed } = await run(
      { level: ROLE.ADMIN, token: true, speedLimit: false },
      makeCtx({
        header: { "x-request-api-key": KEY_ADMIN },
        query: {},
        session: null
      })
    );
    expect(passed).toBe(true);
  });

  it("rejects a key whose owner is below the level", async () => {
    const { passed, ctx } = await run(
      { level: ROLE.ADMIN, speedLimit: false },
      makeCtx({ header: { "x-request-api-key": KEY_USER }, session: null })
    );
    expect(passed).toBe(false);
    expect(ctx.status).toBe(403);
    // apiError, not verificationFailed — the caller needs to know the key was what failed.
    expect(bodyOf(ctx)).toBe($t("TXT_CODE_permission.apiError"));
  });

  it("rejects an unknown key", async () => {
    const { passed, ctx } = await run(
      { level: ROLE.USER, speedLimit: false },
      makeCtx({ header: { "x-request-api-key": "PLACEHOLDER_WRONG_KEY" }, session: null })
    );
    expect(passed).toBe(false);
    expect(ctx.status).toBe(403);
  });

  it("rejects a banned user's key", async () => {
    const { passed, ctx } = await run(
      { level: ROLE.GUEST, speedLimit: false },
      makeCtx({ header: { "x-request-api-key": KEY_BANNED }, session: null })
    );
    expect(passed).toBe(false);
    expect(ctx.status).toBe(403);
  });

  it("rejects when the route declares no level", async () => {
    // Number(undefined) is NaN, and `permission >= NaN` is false — so an API key can never
    // satisfy a route that omits `level`, whatever the key's owner can do.
    const { passed, ctx } = await run(
      { speedLimit: false },
      makeCtx({ header: { "x-request-api-key": KEY_ADMIN }, session: null })
    );
    expect(passed).toBe(false);
    expect(ctx.status).toBe(403);
  });
});

describe("CSRF token and ajax checks", () => {
  it("rejects a mismatched token", async () => {
    const { passed, ctx } = await run({ level: ROLE.USER }, makeCtx({ query: { token: "WRONG" } }));
    expect(passed).toBe(false);
    expect(ctx.status).toBe(403);
    expect(bodyOf(ctx)).toBe($t("TXT_CODE_permission.forbiddenTokenError"));
  });

  it("admits a matching token", async () => {
    const { passed } = await run(
      { level: ROLE.USER },
      makeCtx({ query: { token: "T" }, session: makeSession({ token: "T" }) })
    );
    expect(passed).toBe(true);
  });

  it("rejects a non-ajax request", async () => {
    const { passed, ctx } = await run(
      { level: ROLE.USER },
      makeCtx({ header: {}, query: { token: "T" } })
    );
    expect(passed).toBe(false);
    expect(ctx.status).toBe(403);
    expect(bodyOf(ctx)).toBe($t("TXT_CODE_permission.xmlhttprequestError"));
  });

  it("skips both checks when token is explicitly false", async () => {
    const { passed } = await run(
      { level: ROLE.USER, token: false },
      makeCtx({ header: {} })
    );
    expect(passed).toBe(true);
  });
});

describe("a route that declares no level admits everyone", () => {
  it("calls next() without any authorisation check", async () => {
    // `isNaN(parseInt(String(undefined)))` is true, so the whole session branch is skipped and
    // the request is admitted. Pinned because it is load-bearing for the public routes
    // (install status, login) and silently dangerous anywhere else.
    const { passed } = await run(
      { token: false, speedLimit: false },
      makeCtx({ session: null, header: {} })
    );
    expect(passed).toBe(true);
  });
});

describe("request speed limit", () => {
  it("throttles a non-admin level after 8 requests in a window", async () => {
    const ctx = makeCtx({ query: { token: "T" }, session: makeSession({ uuid: "u-user", userName: "user-u-user" }) });
    const results: boolean[] = [];
    for (let i = 0; i < 10; i++) results.push((await run({ level: ROLE.USER }, ctx)).passed);
    expect(results.slice(0, 8).every(Boolean)).toBe(true);
    expect(results[8]).toBe(false);
    expect(ctx.status).toBe(500);
  });

  it("does not throttle ADMIN, whose level is not < 10", async () => {
    const ctx = makeCtx({ query: { token: "T" } });
    const results: boolean[] = [];
    for (let i = 0; i < 12; i++) results.push((await run({ level: ROLE.ADMIN }, ctx)).passed);
    expect(results.every(Boolean)).toBe(true);
  });

  it("answers 500 rather than 403 when there is no session to count against", async () => {
    // requestSpeedLimit returns false for a missing session, which the caller cannot tell from
    // "too many requests". Documented as current behaviour: an unauthenticated request to a
    // throttled route gets tooFast, not forbidden.
    const { passed, ctx } = await run({ level: ROLE.USER }, makeCtx({ session: null }));
    expect(passed).toBe(false);
    expect(ctx.status).toBe(500);
  });
});
