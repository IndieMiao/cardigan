import { expect, test } from "vitest";
import { call, webHarness } from "../../test-support/web.js";

const PASSWORD = "correct horse battery";
const PUBLIC_ORIGIN = "https://workbench.example:8443";
const OTHER_ORIGIN = "https://other.example";
const PUBLIC_ORIGINS = `${PUBLIC_ORIGIN},${OTHER_ORIGIN}`;
const forwarded = {
  "x-forwarded-host": "workbench.example:8443",
  "x-forwarded-proto": "https",
  "x-forwarded-port": "8443",
  forwarded: 'host="workbench.example:8443";proto=https',
};

test("configured HTTPS hosts and origins coexist with loopback access", async () => {
  const h = await webHarness({
    password: PASSWORD,
    env: { CARDIGAN_WEB_PUBLIC_ORIGINS: PUBLIC_ORIGINS },
  });
  try {
    expect(h.server.host).toBe("127.0.0.1");
    for (const host of [
      h.hostHeader,
      `localhost:${h.port}`,
      "workbench.example:8443",
      "other.example",
    ]) {
      expect(
        (await call(h.port, "/api/session", { headers: { host } })).status,
      ).toBe(200);
      expect((await call(h.port, "/", { headers: { host } })).status).toBe(200);
    }
    for (const origin of [
      PUBLIC_ORIGIN,
      OTHER_ORIGIN,
      `http://${h.hostHeader}`,
    ]) {
      const response = await call(h.port, "/api/login", {
        method: "POST",
        body: JSON.stringify({ password: PASSWORD }),
        headers: { origin, "content-type": "application/json" },
      });
      expect(response.status, origin).toBe(200);
      // The Origin alone never changes cookie flags on a loopback Host.
      expect(String(response.headers["set-cookie"])).not.toContain("Secure");
    }
    for (const host of [
      "evil.example:8443",
      "workbench.example",
      "workbench.example:8444",
      "workbench.example.evil:8443",
      "other.example:8443",
    ]) {
      const response = await call(h.port, "/api/session", {
        headers: { host, ...forwarded },
      });
      expect(response.status, host).toBe(421);
      expect(response.json).toMatchObject({
        error: { code: "misdirected_request" },
      });
    }
  } finally {
    await h.close();
  }
});

test("unconfigured origins cannot log in or revoke a session through a public Host", async () => {
  const h = await webHarness({
    password: PASSWORD,
    env: { CARDIGAN_WEB_PUBLIC_ORIGINS: PUBLIC_ORIGINS },
  });
  try {
    const cookie = await h.login(PASSWORD);
    for (const origin of [
      undefined,
      "null",
      "https://evil.example",
      "http://workbench.example:8443",
      "https://workbench.example",
      "https://workbench.example:8444",
      `${PUBLIC_ORIGIN}/`,
    ]) {
      for (const path of ["/api/login", "/api/logout"]) {
        const response = await call(h.port, path, {
          method: "POST",
          cookie,
          body: JSON.stringify({ password: PASSWORD }),
          headers: {
            host: "workbench.example:8443",
            "content-type": "application/json",
            ...forwarded,
            ...(origin === undefined ? {} : { origin }),
          },
        });
        expect(response.status, `${path} ${origin}`).toBe(403);
        expect(response.json).toMatchObject({
          error: {
            code: origin === undefined ? "origin_required" : "origin_rejected",
          },
        });
        expect(response.headers["set-cookie"]).toBeUndefined();
      }
    }
    expect((await call(h.port, "/api/me", { cookie })).status).toBe(200);
  } finally {
    await h.close();
  }
});

test.each([
  { configured: true, origin: PUBLIC_ORIGIN },
  { configured: true, origin: OTHER_ORIGIN },
  { configured: true, origin: undefined },
  { configured: false, origin: undefined },
])(
  "login and logout Secure flags depend only on configured Host (%j)",
  async ({ configured, origin }) => {
    const h = await webHarness({
      password: PASSWORD,
      env: { CARDIGAN_WEB_PUBLIC_ORIGINS: configured ? PUBLIC_ORIGINS : "" },
    });
    try {
      const secure = origin !== undefined;
      const headers = {
        host: origin === undefined ? h.hostHeader : new URL(origin).host,
        origin: origin ?? `http://${h.hostHeader}`,
        "content-type": "application/json",
        ...forwarded,
        // A claimed HTTP scheme must not remove Secure from a configured Host.
        ...(secure
          ? { "x-forwarded-proto": "http", forwarded: "proto=http" }
          : {}),
      };
      const login = await call(h.port, "/api/login", {
        method: "POST",
        headers,
        body: JSON.stringify({ password: PASSWORD }),
      });
      expect(login.status).toBe(200);
      const cookie = String(login.headers["set-cookie"]).split(";")[0] ?? "";
      expect((await call(h.port, "/api/me", { headers, cookie })).status).toBe(
        200,
      );
      const logout = await call(h.port, "/api/logout", {
        method: "POST",
        headers,
        cookie,
        body: "{}",
      });
      expect(logout.status).toBe(200);
      for (const [response, maxAge] of [
        [login, 604800],
        [logout, 0],
      ] as const) {
        const attributes = String(response.headers["set-cookie"]).split("; ");
        expect(attributes.slice(1)).toEqual([
          "Path=/",
          "HttpOnly",
          "SameSite=Strict",
          `Max-Age=${maxAge}`,
          ...(secure ? ["Secure"] : []),
        ]);
      }
      expect((await call(h.port, "/api/me", { headers, cookie })).status).toBe(
        401,
      );
    } finally {
      await h.close();
    }
  },
);

test.each([undefined, "", "  "])(
  "public access requires explicit configuration (%j)",
  async (value) => {
    const h = await webHarness({ env: { CARDIGAN_WEB_PUBLIC_ORIGINS: value } });
    try {
      const publicHost = await call(h.port, "/api/session", {
        headers: { host: "workbench.example:8443", ...forwarded },
      });
      expect(publicHost.status).toBe(421);
      const publicOrigin = await call(h.port, "/api/login", {
        method: "POST",
        headers: {
          origin: PUBLIC_ORIGIN,
          "content-type": "application/json",
          ...forwarded,
        },
        body: "{}",
      });
      expect(publicOrigin.status).toBe(403);
    } finally {
      await h.close();
    }
  },
);
