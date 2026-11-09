/**
 * M5.1 Workbench listener: security checks, login and static files (plan
 * phase-1-m5 §3.1, §3.2; development plan §8, §14).
 *
 * The acceptance items of M5.1 are the tests here: unauthenticated API calls
 * are 401, an MCP token does not open the API, a wrong Host is 421, a
 * state-changing request without the matching Origin is 403, a login failure
 * backs off, and only the described cookie is issued.
 */
import { expect, test } from "vitest";
import { call, webHarness } from "../../test-support/web.js";

const PASSWORD = "correct horse battery";

const jsonPost = (body: unknown) => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
});

test("every response carries the CSP and anti-clickjacking headers", async () => {
  const harness = await webHarness({ password: PASSWORD });
  try {
    const res = await call(harness.port, "/api/session");
    expect(res.status).toBe(200);
    const csp = String(res.headers["content-security-policy"]);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("'unsafe-inline'; script-src");
    expect(csp).toMatch(/script-src 'self'($|;)/);
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  } finally {
    await harness.close();
  }
});

test("a Host header that does not name this listener is refused with 421", async () => {
  const harness = await webHarness({ password: PASSWORD });
  try {
    for (const host of [
      "evil.example",
      `evil.example:${harness.port}`,
      "127.0.0.1",
      `127.0.0.1:${harness.port + 1}`,
    ]) {
      const res = await call(harness.port, "/api/session", {
        headers: { host },
      });
      expect(res.status, host).toBe(421);
    }
    const ok = await call(harness.port, "/api/session", {
      headers: { host: `localhost:${harness.port}` },
    });
    expect(ok.status).toBe(200);
  } finally {
    await harness.close();
  }
});

test("a state-changing request needs the Origin of the served page", async () => {
  const harness = await webHarness({ password: PASSWORD });
  try {
    const noOrigin = await call(
      harness.port,
      "/api/login",
      jsonPost({ password: PASSWORD }),
    );
    expect(noOrigin.status).toBe(403);

    const foreign = await call(harness.port, "/api/login", {
      ...jsonPost({ password: PASSWORD }),
      headers: {
        "content-type": "application/json",
        origin: "http://evil.example",
      },
    });
    expect(foreign.status).toBe(403);

    const wrongPort = await call(harness.port, "/api/login", {
      ...jsonPost({ password: PASSWORD }),
      headers: {
        "content-type": "application/json",
        origin: `http://127.0.0.1:${harness.port + 1}`,
      },
    });
    expect(wrongPort.status).toBe(403);

    const same = await call(harness.port, "/api/login", {
      ...jsonPost({ password: PASSWORD }),
      headers: {
        "content-type": "application/json",
        origin: `http://127.0.0.1:${harness.port}`,
      },
    });
    expect(same.status).toBe(200);
  } finally {
    await harness.close();
  }
});

test("the API answers 401 without a session", async () => {
  const harness = await webHarness({ password: PASSWORD });
  try {
    for (const [method, path] of [
      ["GET", "/api/me"],
      ["POST", "/api/logout"],
    ] as const) {
      const res = await call(harness.port, path, {
        method,
        ...(method === "POST"
          ? {
              headers: {
                "content-type": "application/json",
                origin: `http://127.0.0.1:${harness.port}`,
              },
            }
          : {}),
      });
      expect(res.status, `${method} ${path}`).toBe(401);
      expect((res.json as { error: { code: string } }).error.code).toBe(
        "unauthorized",
      );
    }
  } finally {
    await harness.close();
  }
});

test("an MCP Bearer token does not open the Workbench API", async () => {
  const harness = await webHarness({ password: PASSWORD });
  try {
    const issued = harness.store.issueToken({
      project_id: "p-fictional" as never,
      assignment_id: "A-1" as never,
      role: { role_version: 1, allowed_tools: ["whoami"] },
    });
    const res = await call(harness.port, "/api/me", {
      headers: { authorization: `Bearer ${issued.token}` },
    });
    expect(res.status).toBe(401);
  } finally {
    await harness.close();
  }
});

test("the session endpoint reports whether a password is configured", async () => {
  const empty = await webHarness();
  try {
    const res = await call(empty.port, "/api/session");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      authenticated: false,
      password_configured: false,
    });
  } finally {
    await empty.close();
  }

  const configured = await webHarness({ password: PASSWORD });
  try {
    const res = await call(configured.port, "/api/session");
    expect(res.json).toEqual({
      authenticated: false,
      password_configured: true,
    });
  } finally {
    await configured.close();
  }
});

test("login rejects a non-JSON body", async () => {
  const harness = await webHarness({
    password: PASSWORD,
    overrides: { loginFailureDelayMs: 0 },
  });
  try {
    const res = await call(harness.port, "/api/login", {
      method: "POST",
      body: `password=${PASSWORD}`,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: `http://127.0.0.1:${harness.port}`,
      },
    });
    expect(res.status).toBe(415);
    expect((res.json as { error: { code: string } }).error.code).toBe(
      "unsupported_media_type",
    );
  } finally {
    await harness.close();
  }
});

test("a correct password issues a Strict, HttpOnly session that logout kills", async () => {
  const harness = await webHarness({ password: PASSWORD });
  try {
    const wrong = await call(harness.port, "/api/login", {
      ...jsonPost({ password: "not the password" }),
      headers: {
        "content-type": "application/json",
        origin: `http://127.0.0.1:${harness.port}`,
      },
    });
    expect(wrong.status).toBe(401);
    expect(wrong.headers["set-cookie"]).toBeUndefined();

    const login = await call(harness.port, "/api/login", {
      ...jsonPost({ password: PASSWORD }),
      headers: {
        "content-type": "application/json",
        origin: `http://127.0.0.1:${harness.port}`,
      },
    });
    expect(login.status).toBe(200);
    const cookie = String(login.headers["set-cookie"]);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    // 7 days, the decided default (§0).
    expect(cookie).toContain("Max-Age=604800");
    const sessionCookie = cookie.split(";")[0] ?? "";

    const me = await call(harness.port, "/api/me", { cookie: sessionCookie });
    expect(me.status).toBe(200);
    expect((me.json as { authenticated: boolean }).authenticated).toBe(true);

    const logout = await call(harness.port, "/api/logout", {
      method: "POST",
      cookie: sessionCookie,
      headers: {
        "content-type": "application/json",
        origin: `http://127.0.0.1:${harness.port}`,
      },
    });
    expect(logout.status).toBe(200);
    expect(String(logout.headers["set-cookie"])).toContain("Max-Age=0");

    const after = await call(harness.port, "/api/me", {
      cookie: sessionCookie,
    });
    expect(after.status).toBe(401);
  } finally {
    await harness.close();
  }
});

test("changing the password invalidates the live session immediately", async () => {
  const harness = await webHarness({ password: PASSWORD });
  try {
    const login = await call(harness.port, "/api/login", {
      ...jsonPost({ password: PASSWORD }),
      headers: {
        "content-type": "application/json",
        origin: `http://127.0.0.1:${harness.port}`,
      },
    });
    const cookie = String(login.headers["set-cookie"]).split(";")[0] ?? "";
    expect((await call(harness.port, "/api/me", { cookie })).status).toBe(200);

    harness.store.setWebPassword("a completely new passphrase");
    expect((await call(harness.port, "/api/me", { cookie })).status).toBe(401);
  } finally {
    await harness.close();
  }
});

test("an expired session is refused", async () => {
  const harness = await webHarness({ password: PASSWORD });
  try {
    const issued = harness.store.createWebSession({ ttlMs: 1 });
    await new Promise((done) => setTimeout(done, 5));
    const res = await call(harness.port, "/api/me", {
      cookie: `cardigan_session=${issued.token}`,
    });
    expect(res.status).toBe(401);
  } finally {
    await harness.close();
  }
});

test("repeated login failures lock the source out until a success resets it", async () => {
  const harness = await webHarness({
    password: PASSWORD,
    overrides: { loginFailureDelayMs: 0 },
  });
  try {
    const attempt = (password: string) =>
      call(harness.port, "/api/login", {
        ...jsonPost({ password }),
        headers: {
          "content-type": "application/json",
          origin: `http://127.0.0.1:${harness.port}`,
        },
      });

    for (let i = 0; i < 5; i += 1) {
      expect((await attempt("wrong password")).status).toBe(401);
    }
    const blocked = await attempt(PASSWORD);
    expect(blocked.status).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
    expect((blocked.json as { error: { code: string } }).error.code).toBe(
      "too_many_attempts",
    );
  } finally {
    await harness.close();
  }
});

test("the SPA shell and its assets are served from the build", async () => {
  const harness = await webHarness({ password: PASSWORD });
  try {
    const shell = await call(harness.port, "/");
    expect(shell.status).toBe(200);
    expect(String(shell.headers["content-type"])).toContain("text/html");
    expect(shell.body).toContain('id="root"');
    expect(shell.headers["cache-control"]).toBe("no-cache");

    const asset = await call(harness.port, "/assets/app.js");
    expect(asset.status).toBe(200);
    expect(String(asset.headers["content-type"])).toContain("javascript");
    expect(asset.headers["cache-control"]).toContain("immutable");

    // A client-side route falls back to the shell.
    const route = await call(harness.port, "/projects/p-1/cards/C-1");
    expect(route.status).toBe(200);
    expect(route.body).toContain('id="root"');

    // A missing asset stays a 404 rather than an HTML body.
    expect((await call(harness.port, "/assets/missing.js")).status).toBe(404);
  } finally {
    await harness.close();
  }
});

test("static paths cannot escape the build directory", async () => {
  const harness = await webHarness({ password: PASSWORD });
  try {
    for (const path of [
      "/../package.json",
      "/..%2fpackage.json",
      "/assets/../../package.json",
      "/%2e%2e/package.json",
    ]) {
      const res = await call(harness.port, path);
      expect(res.status, path).toBe(404);
      expect(res.body).not.toContain("cardigan");
    }
  } finally {
    await harness.close();
  }
});

test("non-GET requests outside the API are refused", async () => {
  const harness = await webHarness({ password: PASSWORD });
  try {
    const res = await call(harness.port, "/", {
      method: "POST",
      body: "{}",
      headers: {
        "content-type": "application/json",
        origin: `http://127.0.0.1:${harness.port}`,
      },
    });
    expect(res.status).toBe(405);
  } finally {
    await harness.close();
  }
});

test("an unknown API path answers a JSON 404", async () => {
  const harness = await webHarness({ password: PASSWORD });
  try {
    const login = await call(harness.port, "/api/login", {
      ...jsonPost({ password: PASSWORD }),
      headers: {
        "content-type": "application/json",
        origin: `http://127.0.0.1:${harness.port}`,
      },
    });
    const cookie = String(login.headers["set-cookie"]).split(";")[0] ?? "";
    const res = await call(harness.port, "/api/unknown", { cookie });
    expect(res.status).toBe(404);
    expect((res.json as { error: { code: string } }).error.code).toBe(
      "not_found",
    );
  } finally {
    await harness.close();
  }
});

test("U6c local WOFF2 fonts keep their MIME type, immutable cache and self-only CSP", async () => {
  const harness = await webHarness({
    staticFiles: {
      "index.html": "<!doctype html><title>Fonts</title>",
      "assets/font.woff2": "font fixture",
    },
  });
  try {
    for (const method of ["GET", "HEAD"]) {
      const font = await call(harness.port, "/assets/font.woff2", { method });
      expect(font.status).toBe(200);
      expect(font.headers["content-type"]).toBe("font/woff2");
      expect(font.headers["content-length"]).toBe(
        String(Buffer.byteLength("font fixture")),
      );
      expect(font.headers["cache-control"]).toContain("immutable");
      expect(font.headers["content-security-policy"]).toContain(
        "font-src 'self'",
      );
      expect(font.body).toBe(method === "HEAD" ? "" : "font fixture");
    }
    const shell = await call(harness.port, "/");
    expect(shell.headers["content-security-policy"]).toContain(
      "font-src 'self'",
    );
    expect((await call(harness.port, "/assets/missing.woff2")).status).toBe(
      404,
    );
  } finally {
    await harness.close();
  }
});
