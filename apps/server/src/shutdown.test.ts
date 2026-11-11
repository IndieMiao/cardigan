/**
 * C-117: a SIGTERM must not wait for a Workbench tab to hang up.
 *
 * The server stops accepting connections, ends every SSE stream at once with
 * `event: shutdown`, lets in-flight requests finish within the grace period and
 * cuts what is left when it runs out. No test waits on real time: the grace
 * timer is driven by hand, and in-flight requests are held open by sending
 * their body in two parts.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { type ClientRequest, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test } from "vitest";
import { call } from "../test-support/web.js";
import { project_id, seedWebProject } from "../test-support/web-data.js";
import { stubGit } from "./git-test-support.js";
import { awaitShutdown } from "./index.js";
import {
  closeWithin,
  SHUTDOWN_EXIT_MARGIN_MS,
  type ShutdownTimer,
} from "./lifecycle.js";
import { type CardiganServer, startCardiganServer } from "./server.js";
import { resolveWebConfig } from "./web/config.js";

const PASSWORD = "correct horse battery";

/** A grace timer that only fires when the test says so. */
function manualTimer() {
  const pending: { ms: number; fire: () => void; cancelled: boolean }[] = [];
  const timer: ShutdownTimer = (ms, fire) => {
    const entry = { ms, fire, cancelled: false };
    pending.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };
  return {
    timer,
    get armed() {
      return pending.filter((entry) => !entry.cancelled).map((e) => e.ms);
    },
    fire(ms: number) {
      for (const entry of pending)
        if (!entry.cancelled && entry.ms === ms) entry.fire();
    },
  };
}

let dataDir: string;
let server: CardiganServer;
let webPort: number;
let cookie: string;
let clock: ReturnType<typeof manualTimer>;
let closed = false;

const idleRuntime = {
  status: async () => ({ ok: true, value: { process: "gone" } }),
  wake: async () => ({ ok: true, value: { sent: true } }),
  provision: async () => ({
    ok: false,
    error: { code: "runtime_unavailable", message: "x" },
  }),
  release: async () => ({ ok: true, value: undefined }),
  interrupt: async () => ({ ok: true, value: undefined }),
  resume_or_replace: async () => ({
    ok: false,
    error: { code: "runtime_unavailable", message: "x" },
  }),
  human_entry: async () => ({ ok: true, value: "" }),
  async *events() {
    yield* [] as never[];
  },
} as never;

async function start(
  extra: Pick<
    Parameters<typeof startCardiganServer>[0] & {},
    "git" | "dispatcher"
  > = {},
): Promise<void> {
  closed = false;
  clock = manualTimer();
  dataDir = mkdtempSync(join(tmpdir(), "cardigan-shutdown-"));
  server = await startCardiganServer({
    config: { dataDir, host: "127.0.0.1", port: 0, shutdownGraceMs: 10_000 },
    warn: () => undefined,
    // Seeded before the control plane starts, so its first tick sees it.
    store: seeded(dataDir),
    ...extra,
    web: {
      config: resolveWebConfig(
        {},
        { port: 0, staticDir: dataDir, loginFailureDelayMs: 0 },
      ),
      log: () => undefined,
      stream: { pollMs: 20, heartbeatMs: 60_000 },
      shutdownTimer: clock.timer,
    },
  });
  webPort = server.web?.port ?? 0;
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
}

let owned: Store | undefined;
function seeded(dir: string): Store {
  owned = Store.open({ dataDir: dir });
  owned.setWebPassword(PASSWORD);
  seedWebProject(owned, dir);
  return owned;
}

beforeEach(async (context) => {
  if (!context.task.name.includes("control plane")) await start();
});
afterEach(async () => {
  if (!closed) await server.close();
  owned?.close();
  owned = undefined;
  rmSync(dataDir, { recursive: true, force: true });
});

interface OpenStream {
  readonly frames: string[];
  /** Resolves when the server ends the response. */
  readonly ended: Promise<void>;
}

/** Open the SSE endpoint and keep it open, the way a Workbench tab does. */
function openStream(): Promise<OpenStream> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: webPort,
        path: `/api/projects/${project_id}/stream`,
        agent: false,
        headers: { cookie, accept: "text/event-stream" },
      },
      (res) => {
        expect(res.statusCode).toBe(200);
        const frames: string[] = [];
        let buffer = "";
        res.setEncoding("utf8");
        const ended = new Promise<void>((done) => {
          res.on("end", done);
          res.on("close", done);
        });
        res.on("data", (chunk: string) => {
          buffer += chunk;
          let index = buffer.indexOf("\n\n");
          while (index >= 0) {
            frames.push(buffer.slice(0, index));
            buffer = buffer.slice(index + 2);
            index = buffer.indexOf("\n\n");
          }
        });
        resolve({ frames, ended });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

interface HeldRequest {
  readonly req: ClientRequest;
  /** Status code, or `"cut"` when the connection was closed without one. */
  readonly result: Promise<number | "cut">;
}

/**
 * A login whose body is only half sent: the server is inside the request
 * (reading the body) until `req.end(rest)` sends the remainder.
 */
async function heldLogin(): Promise<{ held: HeldRequest; rest: string }> {
  const body = JSON.stringify({ password: PASSWORD });
  const half = Math.floor(body.length / 2);
  const req = httpRequest({
    host: "127.0.0.1",
    port: webPort,
    path: "/api/login",
    method: "POST",
    // A fresh socket: the global agent would reuse the login's keep-alive
    // connection, which never emits `connect`.
    agent: false,
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
      origin: `http://127.0.0.1:${webPort}`,
    },
  });
  const result = new Promise<number | "cut">((resolve) => {
    req.on("response", (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", () => resolve("cut"));
  });
  // Wait until the server has accepted the request line before shutting down.
  const accepted = new Promise<void>((resolve) =>
    req.on("socket", (socket) => socket.on("connect", () => resolve())),
  );
  req.write(body.slice(0, half));
  await accepted;
  // Let the server parse the headers and enter the handler.
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { held: { req, result }, rest: body.slice(half) };
}

function fakeSignals() {
  const handlers = new Map<string, () => void>();
  return {
    host: {
      once: (signal: NodeJS.Signals, listener: () => void) => {
        handlers.set(signal, listener);
      },
      off: (signal: NodeJS.Signals) => {
        handlers.delete(signal);
      },
    },
    send: (signal: NodeJS.Signals) => handlers.get(signal)?.(),
  };
}

test("with an SSE stream open, SIGTERM closes the stream and the server exits within the grace period", async () => {
  const stream = await openStream();
  const signals = fakeSignals();
  const lines: string[] = [];
  const exits: number[] = [];
  let storeClosed = false;
  const code = awaitShutdown({
    server,
    store: {
      close: () => {
        storeClosed = true;
      },
    },
    write: (line) => lines.push(line),
    graceMs: 10_000,
    signals: signals.host,
    timer: clock.timer,
    exit: (value) => exits.push(value),
  });

  signals.send("SIGTERM");
  closed = true;

  // The process resolves cleanly while neither the request grace period nor
  // the process deadline has fired: the stream did not hold the shutdown.
  expect(await code).toBe(0);
  await stream.ended;
  expect(stream.frames).toContain("event: shutdown\ndata: {}");
  expect(exits).toEqual([]);
  expect(storeClosed).toBe(true);
  expect(lines).toEqual([JSON.stringify({ shutting_down: "SIGTERM" })]);
  // Both timers were armed and cancelled once the close finished.
  expect(clock.armed).toEqual([]);
  // No new connection is accepted after the signal.
  await expect(call(webPort, "/api/session")).rejects.toThrow();
});

test("SSE streams end while the control plane is still draining its current tick", async () => {
  // The backup loop's first tick blocks until the test releases it: the same
  // shape as a merge or a delivery that is still running at SIGTERM.
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let backups = 0;
  let started = () => {};
  const backupStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  await start({
    git: stubGit({
      project: { project_id } as never,
      backup: async () => {
        backups += 1;
        started();
        await held;
      },
    }),
    dispatcher: {
      runtime: idleRuntime,
      snapshot: async () => ({ model: "m", agent_cli_version: "c" }),
      startRun: async () => {},
    },
  });
  await backupStarted;
  const stream = await openStream();

  let done = false;
  const closing = server.close().then(() => {
    done = true;
  });
  closed = true;

  // The stream is gone and the listener refuses new connections, although the
  // control plane is still inside its tick.
  await stream.ended;
  expect(stream.frames).toContain("event: shutdown\ndata: {}");
  await expect(call(webPort, "/api/session")).rejects.toThrow();
  expect(done).toBe(false);
  expect(backups).toBe(1);

  release();
  await closing;
  expect(done).toBe(true);
});

test("an in-flight request finishes normally within the grace period", async () => {
  const stream = await openStream();
  const { held, rest } = await heldLogin();

  const closing = server.close();
  closed = true;
  await stream.ended;
  expect(stream.frames).toContain("event: shutdown\ndata: {}");

  // Still waiting for the request; the grace timer is armed, not fired.
  let done = false;
  void closing.then(() => {
    done = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(done).toBe(false);
  expect(clock.armed).toEqual([10_000]);

  held.req.end(rest);
  expect(await held.result).toBe(200);
  await closing;
  expect(clock.armed).toEqual([]);
});

test("a request still running when the grace period ends is cut off", async () => {
  const { held } = await heldLogin();

  const closing = server.close();
  closed = true;
  clock.fire(10_000);

  await closing;
  expect(await held.result).toBe("cut");
});

test("a close that never finishes is forced after the grace period and its margin", async () => {
  const signals = fakeSignals();
  const lines: string[] = [];
  const exits: number[] = [];
  let storeClosed = false;
  const code = awaitShutdown({
    server: { close: () => new Promise<void>(() => {}) },
    store: {
      close: () => {
        storeClosed = true;
      },
    },
    write: (line) => lines.push(line),
    graceMs: 10_000,
    signals: signals.host,
    timer: clock.timer,
    exit: (value) => exits.push(value),
  });

  signals.send("SIGTERM");
  expect(clock.armed).toEqual([10_000 + SHUTDOWN_EXIT_MARGIN_MS]);
  clock.fire(10_000 + SHUTDOWN_EXIT_MARGIN_MS);

  expect(await code).toBe(1);
  expect(exits).toEqual([1]);
  // A loop may still be using the store; SQLite recovers on the next start.
  expect(storeClosed).toBe(false);
  expect(lines).toEqual([
    JSON.stringify({ shutting_down: "SIGTERM" }),
    JSON.stringify({ shutdown_forced: "SIGTERM" }),
  ]);
});

test("closeWithin reports a failing close without waiting for the deadline", async () => {
  const outcome = await closeWithin(
    () => Promise.reject(new Error("boom")),
    1_000,
    clock.timer,
  );
  expect(outcome).toEqual({ kind: "failed", error: new Error("boom") });
  expect(clock.armed).toEqual([]);
});
