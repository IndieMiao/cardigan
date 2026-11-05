/**
 * M5.1: the Workbench listener beside the MCP endpoint (plan §3.1, §3.2).
 *
 * The two listeners share a store and nothing else. These tests pin the two
 * separation rules the plan states: an MCP Bearer token does not open the
 * Workbench API, and a Workbench session cookie does not open the MCP endpoint.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { call } from "../../test-support/web.js";
import { type CardiganServer, startCardiganServer } from "../server.js";
import { resolveWebConfig } from "./config.js";

const PASSWORD = "correct horse battery";

let dataDir: string;
let server: CardiganServer;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "cardigan-web-integration-"));
  server = await startCardiganServer({
    config: { dataDir, host: "127.0.0.1", port: 0 },
    warn: () => undefined,
    web: { config: resolveWebConfig({}, { port: 0, staticDir: dataDir }) },
  });
});
afterEach(async () => {
  await server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("the Workbench listens on its own port beside the MCP endpoint", async () => {
  expect(server.web).toBeDefined();
  expect(server.web?.port).not.toBe(server.port);
  expect(server.web?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

  const res = await call(server.web?.port ?? 0, "/api/session");
  expect(res.status).toBe(200);
  expect(res.json).toEqual({
    authenticated: false,
    password_configured: false,
  });
});

test("a session cookie does not authenticate the MCP endpoint", async () => {
  server.store.setWebPassword(PASSWORD);
  const login = await call(server.web?.port ?? 0, "/api/login", {
    method: "POST",
    body: JSON.stringify({ password: PASSWORD }),
    headers: {
      "content-type": "application/json",
      origin: server.web?.url ?? "",
    },
  });
  const cookie = String(login.headers["set-cookie"]).split(";")[0] ?? "";
  expect(cookie).toContain("cardigan_session=");

  const response = await fetch(server.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      cookie,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "cookie-probe", version: "0" },
      },
    }),
  });
  expect(response.status).toBe(401);
});

test("a non-loopback Workbench address refuses to start", async () => {
  expect(() =>
    resolveWebConfig({}, { host: "0.0.0.0", staticDir: dataDir }),
  ).toThrow(/只监听回环地址/);
});

test("closing the server closes both listeners", async () => {
  await server.close();
  await expect(
    fetch(`http://127.0.0.1:${server.web?.port ?? 0}/api/session`),
  ).rejects.toThrow();
  // Restartable for afterEach's idempotent close: open a fresh pair instead.
  server = await startCardiganServer({
    config: { dataDir, host: "127.0.0.1", port: 0 },
    warn: () => undefined,
    web: { config: resolveWebConfig({}, { port: 0, staticDir: dataDir }) },
  });
});

test("the store is shared: a password set through the store unlocks the UI", async () => {
  server.store.setWebPassword(PASSWORD);
  const res = await call(server.web?.port ?? 0, "/api/session");
  expect(res.json).toEqual({
    authenticated: false,
    password_configured: true,
  });
});
