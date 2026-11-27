import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Attachment,
  CardId,
  ProjectId,
  TimelineEntry,
} from "@cardigan/domain";
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

test("external notification configuration is loaded once at startup and disabled leaves dispatch unchanged", async () => {
  const previous = process.env.CARDIGAN_CONFIG_DIR;
  process.env.CARDIGAN_CONFIG_DIR = dataDir;
  const path = join(dataDir, "ext-message.yaml");
  writeFileSync(path, "enabled: false\n", { mode: 0o600 });
  try {
    server = await startCardiganServer({
      config: { dataDir, host: "127.0.0.1", port: 0 },
      store,
      git: stubGit({ project }),
      dispatcher: dispatcher(),
      warn: () => {},
    });
    const read = () =>
      JSON.parse(
        String(
          store.database
            .prepare("SELECT doc FROM ext_message_host_status WHERE id=1")
            .get()?.doc,
        ),
      );
    expect(read()).toMatchObject({
      status: "loaded",
      enabled: false,
      channels: {},
    });
    writeFileSync(path, "invalid yaml [");
    expect(read()).toMatchObject({ status: "loaded", enabled: false });
    expect(
      store.database.prepare("SELECT * FROM ext_message_outbox").all(),
    ).toEqual([]);
    await server.close();
    server = undefined;
  } finally {
    if (previous === undefined) delete process.env.CARDIGAN_CONFIG_DIR;
    else process.env.CARDIGAN_CONFIG_DIR = previous;
  }
});

test.each([true, false])(
  "startup fence holds even after listeners bind (release=%s)",
  async (release) => {
    const gate = Promise.withResolvers<void>();
    const reconcile = vi.fn(async () => []);
    const dispatch = vi.fn(async () => {});
    server = await startCardiganServer({
      role: "background",
      backgroundReady: gate.promise,
      config: { dataDir, host: "127.0.0.1", port: 0 },
      store,
      git: stubGit({ project, reconcile }),
      dispatcher: { ...dispatcher(), intervalMs: 5, recoverLaunches: dispatch },
      warn: () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(reconcile).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    if (release) {
      gate.resolve();
      await vi.waitFor(() => {
        expect(dispatch).toHaveBeenCalled();
        expect(reconcile).toHaveBeenCalled();
      });
    }
    await server.close();
    server = undefined;
    // A late ready after shutdown cannot start a new owner.
    gate.resolve();
    if (!release) expect(dispatch).not.toHaveBeenCalled();
  },
);

test("C-819: startup gives old streamed images their verdict and reports the counts", async () => {
  const png = Buffer.from("\x89PNG\r\n\x1a\nrest-of-file", "latin1");
  mkdirSync(join(dataDir, "artifacts"), { recursive: true });
  const put = (id: string, onDisk: boolean) => {
    const blob_id = randomUUID();
    if (onDisk) writeFileSync(join(dataDir, "artifacts", blob_id), png);
    store.uow.run((tx) =>
      tx.attachments.put(project.project_id as ProjectId, {
        id: id as Attachment["id"],
        sha256: "0".repeat(64),
        mime: "image/png",
        size: png.byteLength,
        card_id: "C-1" as CardId,
        uploaded_by: "assignment:A-1",
        storage_path: `artifacts/${blob_id}`,
        attach_to: {
          kind: "timeline_entry",
          id: "C-1#1" as TimelineEntry["id"],
        },
        kind: "evidence",
        streamed_artifact: {
          blob_id,
          run_id: "R-1" as never,
          created_at: "2026-11-27T04:03:00.000Z" as never,
        },
      }),
    );
  };
  put("S-1", true);
  put("S-2", false);
  const warnings: string[] = [];
  server = await startCardiganServer({
    config: { dataDir, host: "127.0.0.1", port: 0 },
    store,
    git: stubGit({ project }),
    dispatcher: dispatcher(),
    warn: (line) => warnings.push(line),
  });
  expect(
    store.uow
      .read((tx) => tx.attachments.list(project.project_id as ProjectId))
      .map((a) => [a.id, a.streamed_artifact?.inline_image]),
  ).toEqual([
    ["S-1", true],
    ["S-2", undefined],
  ]);
  expect(warnings).toContain(
    "旧流式图片补标记：可内嵌 1 条，只给下载 0 条，文件不在本机跳过 1 条",
  );
});
