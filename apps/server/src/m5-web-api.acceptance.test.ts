/**
 * M5.1 acceptance: the Workbench Web API as the plan describes it
 * (docs/plans/phase-1-m5.md §3.1–§3.3, §4 M5.1).
 *
 * This file walks the acceptance list once, over the real `startCardiganServer`
 * assembly: an unauthenticated API is 401, an MCP token is 401, a bad Host is
 * 421, a bad Origin is 403, the read surface answers with the seeded project,
 * the SSE stream resumes, and SVG/HTML attachments come back as downloads.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { call } from "../test-support/web.js";
import { project_id, seedWebProject } from "../test-support/web-data.js";
import { type CardiganServer, startCardiganServer } from "./server.js";
import { resolveWebConfig } from "./web/config.js";

const PASSWORD = "correct horse battery";

let dataDir: string;
let server: CardiganServer;
let webPort: number;
let cookie: string;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "cardigan-m5-web-"));
  server = await startCardiganServer({
    config: { dataDir, host: "127.0.0.1", port: 0 },
    warn: () => undefined,
    web: {
      config: resolveWebConfig(
        {},
        {
          port: 0,
          staticDir: dataDir,
          loginFailureDelayMs: 0,
        },
      ),
      stream: { pollMs: 20, heartbeatMs: 20 },
    },
  });
  webPort = server.web?.port ?? 0;
  server.store.setWebPassword(PASSWORD);
  const login = await call(webPort, "/api/login", {
    method: "POST",
    body: JSON.stringify({ password: PASSWORD }),
    headers: {
      "content-type": "application/json",
      origin: `http://127.0.0.1:${webPort}`,
    },
  });
  expect(login.status).toBe(200);
  cookie = String(login.headers["set-cookie"]).split(";")[0] ?? "";
});
afterEach(async () => {
  await server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const api = (path: string, init: { method?: string; cookie?: string } = {}) =>
  call(webPort, path, {
    cookie: init.cookie ?? "",
    ...(init.method === undefined ? {} : { method: init.method }),
  });

test("the Workbench API is a separate listener from MCP", () => {
  expect(server.web).toBeDefined();
  expect(webPort).not.toBe(server.port);
  expect(server.web?.url).toBe(`http://127.0.0.1:${webPort}`);
});

test("unauthenticated and MCP-token calls are 401, a bad Host is 421 and a bad Origin is 403", async () => {
  seedWebProject(server.store, dataDir);

  // No cookie.
  for (const path of [
    "/api/projects",
    `/api/projects/${project_id}/snapshot`,
    `/api/projects/${project_id}/stream`,
  ]) {
    expect((await api(path)).status, path).toBe(401);
  }

  // A live MCP token is not a Workbench credential.
  const token = server.store.issueToken({
    project_id: project_id,
    assignment_id: "A-1" as never,
    role: { role_version: 1, allowed_tools: ["whoami"] },
  });
  const withToken = await call(webPort, `/api/projects/${project_id}/cards`, {
    headers: { authorization: `Bearer ${token.token}` },
  });
  expect(withToken.status).toBe(401);

  // DNS rebinding.
  const rebinding = await call(webPort, "/api/session", {
    headers: { host: "attacker.example" },
  });
  expect(rebinding.status).toBe(421);

  // CSRF: a state-changing request from another origin.
  const crossSite = await call(webPort, "/api/login", {
    method: "POST",
    body: JSON.stringify({ password: PASSWORD }),
    headers: {
      "content-type": "application/json",
      origin: "http://attacker.example",
    },
  });
  expect(crossSite.status).toBe(403);
});

test("the read surface answers with the project's cards, Needs You and snapshot", async () => {
  seedWebProject(server.store, dataDir);
  const projects = await api("/api/projects", { cookie });
  expect(
    (projects.json as { projects: { id: string }[] }).projects[0]?.id,
  ).toBe(project_id);

  const cards = await api(`/api/projects/${project_id}/cards?filter=needs_me`, {
    cookie,
  });
  expect(cards.status).toBe(200);
  expect((cards.json as { cards: { id: string }[] }).cards).toEqual([
    expect.objectContaining({ id: "C-1" }),
  ]);

  const needsYou = await api(`/api/projects/${project_id}/needs-you`, {
    cookie,
  });
  expect((needsYou.json as { decisions: unknown[] }).decisions).toHaveLength(1);

  const snapshot = await api(`/api/projects/${project_id}/snapshot`, {
    cookie,
  });
  expect((snapshot.json as { cards: unknown[] }).cards).toHaveLength(3);

  const execution = await api(`/api/projects/${project_id}/execution`, {
    cookie,
  });
  expect(
    (execution.json as { assignments: unknown[] }).assignments,
  ).toHaveLength(1);

  const activity = await api(`/api/projects/${project_id}/activity?limit=2`, {
    cookie,
  });
  expect((activity.json as { events: unknown[] }).events).toHaveLength(2);
});

test("HTML and SVG attachments are downloads, never inline documents", async () => {
  const seeded = seedWebProject(server.store, dataDir);
  for (const [id, mime] of [
    [seeded.htmlAttachment.id, "text/html"],
    [seeded.svgAttachment.id, "image/svg+xml"],
    [seeded.attachment.id, "image/png"],
  ] as const) {
    const res = await api(`/api/projects/${project_id}/attachments/${id}`, {
      cookie,
    });
    expect(res.status).toBe(200);
    expect(String(res.headers["content-type"])).toBe(mime);
    const disposition = String(res.headers["content-disposition"]);
    expect(
      disposition.startsWith(mime === "image/png" ? "inline;" : "attachment;"),
    ).toBe(true);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  }

  // The SVG body itself is untouched, so the browser must not render it.
  const svg = await api(`/api/projects/${project_id}/attachments/F-3`, {
    cookie,
  });
  expect(svg.body).toContain("<script>");
  expect(String(svg.headers["content-disposition"])).toMatch(/^attachment;/);
});

test("the SSE stream resumes from the client's cursors", async () => {
  seedWebProject(server.store, dataDir);
  const response = await fetch(
    `http://127.0.0.1:${webPort}/api/projects/${project_id}/stream?after=project:1,C-1:1,C-2:1`,
    { headers: { cookie, accept: "text/event-stream" } },
  );
  expect(response.status).toBe(200);
  expect(String(response.headers.get("content-type"))).toContain(
    "text/event-stream",
  );
  const reader = response.body?.getReader();
  expect(reader).toBeDefined();
  const first = await reader?.read();
  const text = first === undefined ? "" : new TextDecoder().decode(first.value);
  expect(text).toContain("retry:");
  await reader?.cancel();
});

test("a non-loopback Workbench configuration refuses to start", async () => {
  expect(() =>
    resolveWebConfig({ CARDIGAN_WEB_PORT: "7781" }, { host: "0.0.0.0" }),
  ).toThrow(/只监听回环地址/);
});
