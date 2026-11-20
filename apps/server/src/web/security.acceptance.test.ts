/** M5.T1: expectations from phase-1-m5 §0/§3.2 and development-plan §14. */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_DB_FILE, webCredential } from "@cardigan/store";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  type M5Cross,
  m5Cross,
  TEST_PASSWORD,
} from "../../test-support/m5-cross.js";
import { resolveWebConfig } from "./config.js";
import { MAX_LOGIN_FAILURES } from "./login-limiter.js";
import { type RunningWebServer, startWebServer } from "./server.js";

let f: M5Cross;
beforeEach(async () => {
  f = await m5Cross();
  expect((await f.password(TEST_PASSWORD)).code).toBe(0);
});
afterEach(async () => {
  await f?.close();
}, 30_000);
const success = async () => {
  expect((await f.login()).status).toBe(200);
};

test("S01 §3.2: protected reads require a session; an invalid cookie cannot reveal project data", async () => {
  for (const path of [
    "/api/projects",
    "/api/me",
    ...[
      "/cards",
      `/cards/${f.card.id}`,
      "/needs-you",
      "/snapshot",
      "/execution",
      "/activity",
      "/attachments/absent",
    ].map(f.projectPath),
  ]) {
    expect((await f.call(path, { anonymous: true })).status, path).toBe(401);
    expect(
      (await f.call(path, { headers: { cookie: "cardigan_session=invalid" } }))
        .status,
      path,
    ).toBe(401);
  }
});

test.each(["0.0.0.0", "::", "public.example.invalid"])(
  "S02 §0: configuration refuses non-loopback %s",
  (host) => {
    expect(() =>
      resolveWebConfig({}, { host, port: 0, staticDir: f.staticDir }),
    ).toThrow();
  },
);

test("S03 §0: the public server entry also refuses a non-loopback config", async () => {
  let started: RunningWebServer | undefined, failure: unknown;
  try {
    started = await startWebServer({
      store: f.store(),
      dataDir: f.dataDir,
      config: {
        ...resolveWebConfig({}, { port: 0, staticDir: f.staticDir }),
        host: "0.0.0.0",
      },
    });
  } catch (error) {
    failure = error;
  } finally {
    await started?.close();
  }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toMatch(/loopback|回环/iu);
});

test("S04 §3.2: an untrusted Host receives 421 even with a valid cookie", async () => {
  await success();
  const response = await f.call("/api/projects", {
    headers: { host: `foreign.invalid:${f.web.port}` },
  });
  expect(response.status).toBe(421);
  expect(response.text).not.toContain(f.card.title);
});

test.each(["missing", "different"])(
  "S05 §3.2: %s Origin rejects login/logout and authenticated writes without mutations",
  async (kind) => {
    await success();
    const before = JSON.stringify(f.state());
    const headers = {
      origin: kind === "missing" ? "" : "https://foreign.invalid",
    };
    for (const path of [
      "/api/login",
      "/api/logout",
      f.projectPath(`/cards/${f.card.id}/comments`),
    ])
      expect(
        (
          await f.call(path, {
            method: "POST",
            body: { password: TEST_PASSWORD, body: "Injected" },
            headers,
          })
        ).status,
      ).toBe(403);
    expect((await f.call("/api/me")).status).toBe(200);
    expect(JSON.stringify(f.state())).toBe(before);
  },
);

for (const action of ["login", "logout"]) {
  test(`S06 §3.2: ${action} requires JSON Content-Type`, async () => {
    await success();
    const response = await f.call(`/api/${action}`, {
      method: "POST",
      body: { password: TEST_PASSWORD },
      headers: { "content-type": "text/plain" },
    });
    expect(response.status).toBe(415);
    expect((await f.call("/api/me")).status).toBe(200);
  });
}

test("S07 §0: the CLI refuses 11-character passwords, accepts 12, salts hashes and never persists plaintext", async () => {
  const old = webCredential(f.store().database)?.password_hash;
  const short = "a".repeat(11);
  expect((await f.password(short)).code).not.toBe(0);
  expect(webCredential(f.store().database)?.password_hash).toBe(old);
  const password = "b".repeat(12);
  expect((await f.password(password)).code).toBe(0);
  const first = webCredential(f.store().database)?.password_hash;
  expect(first).toMatch(/^scrypt/);
  expect((await f.password(password)).code).toBe(0);
  expect(webCredential(f.store().database)?.password_hash).not.toBe(first);
  expect((await f.login(password)).status).toBe(200);
  const cookie = f.cookie().split("=")[1] as string;
  for (const suffix of ["", "-wal"]) {
    const path = join(f.dataDir, DEFAULT_DB_FILE + suffix);
    if (existsSync(path))
      for (const plain of [password, cookie])
        expect(readFileSync(path).includes(Buffer.from(plain))).toBe(false);
  }
  expect(JSON.stringify(f.logs)).not.toContain(password);
  expect(JSON.stringify(f.logs)).not.toContain(cookie);
});

test("S08 §3.2: consecutive bad logins trigger backoff; even the correct password must wait", async () => {
  for (let n = 0; n < MAX_LOGIN_FAILURES; n++)
    expect((await f.login("incorrect password")).status).toBe(401);
  const locked = await f.login();
  expect(locked.status).toBe(429);
  const seconds = Number(locked.headers["retry-after"]);
  expect(seconds).toBeGreaterThan(0);
  f.advance(seconds * 1000 + 1);
  expect((await f.login()).status).toBe(200);
  expect((await f.login("incorrect password")).status).toBe(401);
  expect((await f.login()).status).toBe(200);
});

test.each(["mcp-to-web", "web-to-mcp"])(
  "S09 §3.2: %s credentials cannot cross listeners",
  async (direction) => {
    await success();
    await f.start(f.primary.owner);
    if (direction === "mcp-to-web") {
      expect(
        (
          await f.call("/api/projects", {
            anonymous: true,
            headers: { authorization: `Bearer ${f.token(f.primary.owner)}` },
          })
        ).status,
      ).toBe(401);
    } else {
      const response = await fetch(f.url(), {
        method: "POST",
        headers: {
          cookie: f.cookie(),
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "whoami", arguments: {} },
        }),
      });
      expect(response.status).toBe(401);
      await response.body?.cancel();
    }
  },
);

test("S10 §3.2: cookie attributes and the default seven-day session lifetime are enforced", async () => {
  const response = await f.login();
  expect(response.status).toBe(200);
  const cookie = String(response.headers["set-cookie"]);
  expect(cookie).toContain("Max-Age=604800");
  for (const flag of ["HttpOnly", "SameSite=Strict", "Path=/"])
    expect(cookie).toContain(flag);
  const me = await f.call("/api/me");
  const session = me.json as { created_at: string; expires_at: string };
  expect(Date.parse(session.expires_at) - Date.parse(session.created_at)).toBe(
    7 * 24 * 60 * 60 * 1000,
  );
  f.setTime(Date.parse(session.expires_at));
  expect((await f.call("/api/me")).status).toBe(401);
});

test("S11 §3.2: logout invalidates a copied cookie immediately", async () => {
  await success();
  const copied = f.cookie();
  expect(
    (await f.call("/api/logout", { method: "POST", body: {} })).status,
  ).toBe(200);
  expect(
    (await f.call("/api/me", { headers: { cookie: copied } })).status,
  ).toBe(401);
});

test("S12 §3.2: a password change revokes every old session and rejects the old password", async () => {
  await success();
  const first = f.cookie();
  await success();
  const second = f.cookie();
  const next = "a different acceptance password";
  expect((await f.password(next)).code).toBe(0);
  for (const cookie of [first, second])
    expect((await f.call("/api/me", { headers: { cookie } })).status).toBe(401);
  expect((await f.login()).status).toBe(401);
  expect((await f.login(next)).status).toBe(200);
});

test("S13 §3.2: HTML and error responses carry CSP, frame and MIME-sniffing defenses", async () => {
  for (const path of ["/", "/api/session", "/api/projects", "/nonexistent"]) {
    const r = await f.call(path, { anonymous: true });
    if (path === "/") {
      expect(r.status).toBe(200);
      expect(r.headers["content-type"]).toContain("text/html");
    }
    const csp = String(r.headers["content-security-policy"]);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    const script =
      csp.split(";").find((d) => d.trim().startsWith("script-src")) ??
      csp.split(";").find((d) => d.trim().startsWith("default-src")) ??
      "";
    expect(script).not.toContain("'unsafe-inline'");
    expect(script).not.toContain("'unsafe-eval'");
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
  }
});

test.each(["image/svg+xml", "text/html"])(
  "S14 §3.2: %s attachments can only download under a sandbox CSP",
  async (mime) => {
    const attachment = await f.attachment(
      mime,
      '<svg onload="alert(1)"></svg>',
    );
    await success();
    const response = await f.call(
      f.projectPath(`/attachments/${attachment.id}`),
    );
    expect(response.status).toBe(200);
    expect(String(response.headers["content-disposition"])).toMatch(
      /^attachment/,
    );
    expect(String(response.headers["content-security-policy"])).toContain(
      "default-src 'none'",
    );
    expect(String(response.headers["content-security-policy"])).toContain(
      "sandbox",
    );
    expect(response.text).toBe('<svg onload="alert(1)"></svg>');
  },
);

test("Workbench serves a streamed artifact through the authenticated download with integrity and sandbox headers", async () => {
  const body = "<svg/>",
    a = await f.attachment("image/svg+xml", body),
    id = randomUUID();
  mkdirSync(join(f.dataDir, "artifacts"), { recursive: true });
  writeFileSync(join(f.dataDir, "artifacts", id), body);
  f.store().uow.run((tx) =>
    tx.attachments.put(f.project.project_id, {
      ...a,
      storage_path: `artifacts/${id}`,
      streamed_artifact: {
        blob_id: id,
        run_id: "R-1" as never,
        created_at: new Date().toISOString(),
      },
    }),
  );
  const path = f.projectPath(`/attachments/${a.id}`);
  expect((await f.call(path, { anonymous: true })).status).toBe(401);
  await success();
  const r = await f.call(path);
  expect(r.status).toBe(200);
  expect(r.text).toBe(body);
  expect(r.headers["x-attachment-sha256"]).toBe(a.sha256);
  expect(r.headers["content-disposition"]).toMatch(/^attachment/);
  expect(r.headers["x-content-type-options"]).toBe("nosniff");
  expect(r.headers["content-security-policy"]).toContain("sandbox");
});
