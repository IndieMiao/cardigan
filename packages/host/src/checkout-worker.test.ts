import { EventEmitter } from "node:events";
import * as path from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, expect, test, vi } from "vitest";
import { CHECKOUT_WORKER } from "./checkout-worker.js";

afterEach(() => vi.useRealTimers());

type Fault =
  | "status"
  | "status-timeout"
  | "stat"
  | "stat-unlisted"
  | "cwd"
  | "cwd-timeout"
  | "older-cwd"
  | "gone"
  | "gone-after-status"
  | "status-gone";
/** Executes the shipped worker with fake processes and IO; no real signals or blocked kernel tasks. */
async function simulate(options: {
  stuck: "remove" | "list" | "descendant";
  fault?: Fault;
}) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const container = "/agent/checks/p/attempt";
  const sha = "a".repeat(40),
    tree = "b".repeat(40),
    survivor = 900000002;
  const input = new EventEmitter();
  const processEvents = new EventEmitter();
  const events: Record<string, unknown>[] = [];
  const removals: string[] = [];
  const markers: { path: string; data: string; mode: number; flag: string }[] =
    [];
  const reads: string[] = [];
  let nextPid = 100,
    group = 0,
    statReads = 0,
    live = false,
    disappeared = false;
  const missing = () => Object.assign(new Error("gone"), { code: "ENOENT" });
  const failure = () => Object.assign(new Error("unreadable"), { code: "EIO" });
  const stream = () =>
    Object.assign(new EventEmitter(), {
      setEncoding() {
        return this;
      },
      destroy() {},
    });
  const spawn = vi.fn((file: string, args: string[]) => {
    const isRemove = args.includes("remove"),
      isList = args.includes("list");
    const stuck =
      (options.stuck === "remove" && isRemove) ||
      (options.stuck === "list" && isList);
    const pid = stuck ? survivor : nextPid++;
    const child = Object.assign(new EventEmitter(), {
      pid,
      stdout: stream(),
      stderr: stream(),
      unref() {},
    });
    if (stuck || (file === "/bin/sh" && options.stuck === "descendant")) {
      live = true;
      group = pid;
    }
    queueMicrotask(() => {
      if (stuck) return; // TERM/KILL deliberately have no effect in this model.
      if (file === "/bin/sh" && options.stuck === "descendant") {
        child.emit("exit", 0);
        return;
      }
      let code = 0;
      if (options.stuck === "list" && args.includes("add")) {
        processEvents.emit("SIGTERM");
        code = 143;
      }
      if (options.stuck === "list" && isRemove) code = 1;
      if (args.includes("rev-parse"))
        child.stdout.emit("data", `${args.at(-1) === "HEAD" ? sha : tree}\n`);
      child.emit("exit", code);
      child.emit("close", code);
    });
    return child;
  });
  const fs = {
    mkdir: async () => {},
    chmod: async () => {},
    symlink: async () => {},
    lstat: async () => ({ isDirectory: () => true, uid: 1234, mode: 0o700 }),
    realpath: async (value: string) => value,
    rm: async (value: string) => {
      removals.push(value);
    },
    readdir: async () =>
      live && !(options.fault === "stat-unlisted" && statReads > 0)
        ? [String(survivor)]
        : [],
    readlink: async (value: string) => {
      reads.push(value);
      if (options.fault === "cwd" || options.fault === "older-cwd")
        throw failure();
      if (options.fault === "cwd-timeout") return new Promise<string>(() => {});
      return `${container}/worktree`;
    },
    readFile: async (value: string) => {
      reads.push(value);
      if (value === "/proc/50/stat") {
        const fields = Array(20).fill("0");
        fields[0] = "S";
        fields[19] = "100";
        return `50 (supervisor) ${fields.join(" ")}`;
      }
      if (!value.startsWith(`/proc/${survivor}/`)) throw missing();
      if (value.endsWith("/stat")) {
        statReads++;
        if (options.fault === "gone" || disappeared) throw missing();
        if (
          ["stat", "stat-unlisted"].includes(options.fault ?? "") &&
          statReads > 1
        )
          throw failure();
        const fields = Array(20).fill("0");
        fields[0] = "D";
        fields[1] = "1";
        fields[2] = String(options.fault?.includes("cwd") ? 0 : group);
        fields[19] = options.fault === "older-cwd" ? "50" : "12345";
        return `${survivor} (worker child) ${fields.join(" ")}`;
      }
      if (value.endsWith("/status")) {
        if (options.fault === "status") throw failure();
        if (options.fault === "status-gone") throw missing();
        if (options.fault === "gone-after-status") {
          disappeared = true;
          throw missing();
        }
        if (options.fault === "status-timeout")
          return new Promise<string>(() => {});
        return "Uid:\t1234\t1234\t1234\t1234";
      }
      if (value.endsWith("/wchan")) return "exit_mm";
      throw new Error("Unexpected process read");
    },
    writeFile: async (
      value: string,
      data: string,
      flags: { mode: number; flag: string },
    ) => {
      markers.push({ path: value, data, ...flags });
    },
  };
  runInNewContext(CHECKOUT_WORKER, {
    require: (name: string) => {
      if (name === "node:child_process") return { spawn };
      if (name === "node:fs/promises") return fs;
      if (name === "node:os")
        return { userInfo: () => ({ homedir: "/agent" }) };
      if (name === "node:path") return path;
      if (name === "node:readline")
        return { createInterface: () => Object.assign(input, { close() {} }) };
      if (name === "node:crypto")
        return {
          createHmac: () => ({ update: () => ({ digest: () => "auth" }) }),
        };
      throw new Error("Unexpected dependency");
    },
    process: Object.assign(processEvents, {
      pid: 50,
      platform: "linux",
      argv: ["node", container],
      env: {},
      getuid: () => 1234,
      chdir() {},
      kill: vi.fn(),
      stdin: { destroy() {} },
      stdout: Object.assign(new EventEmitter(), {
        write: (line: string) => events.push(JSON.parse(line)),
      }),
      exit: () => {
        throw new Error("Unexpected worker exit");
      },
    }),
    setTimeout,
    clearTimeout,
  });
  input.emit(
    "line",
    JSON.stringify({
      nonce: "fixture",
      auth_key: "fixture",
      container,
      directory: `${container}/worktree`,
      alias_container: "/agent/s/alias",
      repository: "/agent/repos/p",
      sha,
      tree,
      path: "/bin",
      env: {},
      totalTimeoutMs: 60_000,
      checks: [{ name: "test", run: "true", timeoutMs: 30_000 }],
    }),
  );
  await vi.runAllTimersAsync();
  const result = events.find((event) => event.type === "result");
  expect(result, "worker must return a bounded result").toBeDefined();
  return { result, events, removals, markers, reads, survivor };
}

test.each(["remove", "list"] as const)(
  "a stuck cleanup Git %s stops deletion and marks the surviving process",
  async (stuck) => {
    const f = await simulate({ stuck });
    expect(f.result).toMatchObject({ manual_attention: true });
    expect(f.result?.status).not.toBe("passed");
    expect(f.removals).toEqual([]);
    expect(f.markers).toEqual([
      {
        path: "/agent/checks/p/attempt/manual-attention.json",
        mode: 0o600,
        flag: "wx",
        data: expect.any(String),
      },
    ]);
    expect(JSON.parse(f.markers[0]?.data ?? "{}").processes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pid: f.survivor,
          state: "D",
          wchan: "exit_mm",
        }),
      ]),
    );
  },
);

test.each([
  "status",
  "status-timeout",
  "stat",
  "stat-unlisted",
  "cwd",
  "cwd-timeout",
  "status-gone",
] as const)(
  "an exited shell with a descendant's %s unavailable preserves the directory",
  async (fault) => {
    const f = await simulate({ stuck: "descendant", fault });
    expect(f.result).toMatchObject({ manual_attention: true });
    expect(f.removals).toEqual([]);
    const processes = JSON.parse(f.markers[0]?.data ?? "{}").processes;
    expect(processes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pid: f.survivor, state: "unknown" }),
      ]),
    );
    if (!fault.startsWith("cwd"))
      expect(processes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ pid: f.survivor, start: "12345" }),
        ]),
      );
    expect(JSON.stringify(f.events)).toContain(`PID ${f.survivor}`);
    expect(f.reads.some((read) => /\/(cmdline|environ)$/u.test(read))).toBe(
      false,
    );
  },
);

test.each(["gone", "gone-after-status"] as const)(
  "a process confirmed gone (%s) does not become an unknown survivor",
  async (fault) => {
    const f = await simulate({ stuck: "descendant", fault });
    expect(f.result).not.toHaveProperty("manual_attention");
    expect(f.markers).toEqual([]);
    expect(f.removals).toContain("/agent/checks/p/attempt/worktree");
  },
);

test("an unrelated older process with unreadable cwd does not block cleanup", async () => {
  const f = await simulate({ stuck: "descendant", fault: "older-cwd" });
  expect(f.result).not.toHaveProperty("manual_attention");
  expect(f.markers).toEqual([]);
  expect(f.removals).toContain("/agent/checks/p/attempt/worktree");
});
