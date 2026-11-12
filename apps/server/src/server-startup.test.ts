import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ControlPlaneOptions } from "./assembly.js";
import { stubGit } from "./git-test-support.js";
import { type CardiganServer, startCardiganServer } from "./server.js";
import { resolveWebConfig } from "./web/config.js";

let dataDir: string;
let store: Store;
let server: CardiganServer | undefined;
const sockets: Server[] = [];
const project = {
  project_id: "p-startup",
  source_repo: "/fixture/repo",
  base_branch: "main",
};

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "cardigan-startup-"));
  store = Store.open({ dataDir });
  store.createProject({ id: project.project_id, name: "Startup" });
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  for (const socket of sockets.splice(0))
    if (socket.listening) await close(socket);
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const close = (socket: Server) =>
  new Promise<void>((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve())),
  );

async function bind(port = 0) {
  const socket = createServer();
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(port, "127.0.0.1", resolve);
  });
  return { socket, port: (socket.address() as { port: number }).port };
}

function dispatcher(): Omit<ControlPlaneOptions, "store" | "git"> {
  return {
    runtime: {
      status: vi.fn(),
      wake: vi.fn(),
      provision: vi.fn(),
      release: vi.fn(),
      interrupt: vi.fn(),
      resume_or_replace: vi.fn(),
      human_entry: vi.fn(),
      async *events() {},
    },
    snapshot: vi.fn(),
    startRun: vi.fn(),
    onError: vi.fn(),
    reconcileIntervalMs: 5,
  };
}

test("Web timeout with a dispatcher never starts background work or waits for it to drain", async () => {
  const occupied = await bind();
  const mcp = await bind();
  await close(mcp.socket);
  const conflict = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();
  const reconcile = vi.fn(async () => {
    // If started during retries, this external operation would block stop().
    await held.promise;
    return [];
  });
  const backup = vi.fn(async () => {});
  const options = dispatcher();
  const startup = startCardiganServer({
    config: {
      dataDir,
      host: "127.0.0.1",
      port: mcp.port,
      listenRetryIntervalMs: 10,
      listenRetryTimeoutMs: 30,
    },
    store,
    git: stubGit({ project, reconcile, backup }),
    dispatcher: options,
    web: { config: resolveWebConfig({}, { port: occupied.port }) },
    warn: (message) => {
      if (message.includes("EADDRINUSE")) conflict.resolve();
    },
  });
  const result = startup.then(
    (value) => {
      server = value;
      return value;
    },
    (error: unknown) => error,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await conflict.promise;
    const outcome = await Promise.race([
      result,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve("startup did not settle"), 2_000);
      }),
    ]);
    expect(outcome).toMatchObject({ code: "EADDRINUSE", port: occupied.port });
    expect(reconcile).not.toHaveBeenCalled();
    expect(backup).not.toHaveBeenCalled();
    expect(options.onError).not.toHaveBeenCalled();
    // The MCP port has been released before any held work is allowed to finish.
    await bind(mcp.port);
    expect(() => store.listProjects()).not.toThrow();
  } finally {
    clearTimeout(timer);
    held.resolve();
    await result;
  }
});

test("background work starts only after the occupied Web port becomes available", async () => {
  const occupied = await bind();
  const reconciled = Promise.withResolvers<void>();
  const reconcile = vi.fn(async () => {
    reconciled.resolve();
    return [];
  });
  let release: Promise<void> | undefined;
  const callsWhileOccupied: number[] = [];
  server = await startCardiganServer({
    config: {
      dataDir,
      host: "127.0.0.1",
      port: 0,
      listenRetryIntervalMs: 10,
      listenRetryTimeoutMs: 1_000,
    },
    store,
    git: stubGit({ project, reconcile }),
    dispatcher: dispatcher(),
    web: { config: resolveWebConfig({}, { port: occupied.port }) },
    warn: (message) => {
      if (!message.includes("EADDRINUSE")) return;
      callsWhileOccupied.push(reconcile.mock.calls.length);
      release ??= close(occupied.socket);
    },
  });
  await release;
  await reconciled.promise;
  expect(callsWhileOccupied.length).toBeGreaterThan(0);
  expect(callsWhileOccupied.every((count) => count === 0)).toBe(true);
  expect(reconcile).toHaveBeenCalled();
  expect((await fetch(`${server.web?.url}/api/session`)).status).toBe(200);
});

test("a control-plane startup error closes both successfully bound listeners", async () => {
  const mcp = await bind(),
    web = await bind();
  await close(mcp.socket);
  await close(web.socket);
  await expect(
    startCardiganServer({
      config: { dataDir, host: "127.0.0.1", port: mcp.port },
      store,
      git: stubGit({ project }),
      dispatcher: { ...dispatcher(), intervalMs: 0 },
      web: { config: resolveWebConfig({}, { port: web.port }) },
      warn: () => {},
    }),
  ).rejects.toThrow("Invalid dispatcher interval");
  await bind(mcp.port);
  await bind(web.port);
  expect(() => store.listProjects()).not.toThrow();
});
