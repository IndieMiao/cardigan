import { runInNewContext } from "node:vm";
import { afterEach, expect, test, vi } from "vitest";
import {
  CHECKOUT_HANDSHAKE_TITLE,
  CHECKOUT_LIMITS,
} from "./checkout-limits.js";
import { CHECKOUT_ORPHAN_SWEEP } from "./checkout-orphans.js";

interface Process {
  uid?: number;
  comm?: string;
  cwd?: string;
  start?: string;
  state?: string;
  beforeRecheck?: (entry: Process) => void;
}
afterEach(() => vi.useRealTimers());
function simulate(entries: Record<string, Process>, username = "agent") {
  let output = "";
  const reads = new Map<string, number>();
  const paths: string[] = [];
  const writes = vi.fn(async () => {});
  const kill = vi.fn((pid: number, signal: string) => {
    if (signal === "SIGKILL") delete entries[String(pid)];
  });
  const fs = {
    readdir: async () => Object.keys(entries),
    writeFile: writes,
    readlink: vi.fn(async (path: string) => {
      paths.push(path);
      return (
        entries[path.split("/")[2] ?? ""]?.cwd ?? "/agent/checks/p/attempt"
      );
    }),
    readFile: vi.fn(async (path: string) => {
      paths.push(path);
      if (path === "/proc/uptime") return "1000 0";
      const pid = path.split("/")[2] ?? "";
      const entry = entries[pid];
      if (!entry) throw Object.assign(new Error("gone"), { code: "ENOENT" });
      if (path.endsWith("/status"))
        return `Uid:\t${Array(4)
          .fill(entry.uid ?? 1234)
          .join("\t")}`;
      if (path.endsWith("/wchan")) return "exit_mm";
      if (!path.endsWith("/stat")) throw new Error("Forbidden process read");
      const count = (reads.get(pid) ?? 0) + 1;
      reads.set(pid, count);
      if (count === 2) entry.beforeRecheck?.(entry);
      const fields = Array(20).fill("0");
      fields[0] = entry.state ?? "S";
      fields[19] = entry.start ?? "100";
      return `${pid} (${entry.comm ?? CHECKOUT_HANDSHAKE_TITLE}) ${fields.join(" ")}`;
    }),
  };
  const execute = () =>
    runInNewContext(CHECKOUT_ORPHAN_SWEEP, {
      require: (name: string) => {
        if (name === "node:fs/promises") return fs;
        if (name === "node:os")
          return { userInfo: () => ({ uid: 1234, username }) };
        if (name === "node:child_process") return { execFileSync: () => "100" };
        throw new Error("Unexpected dependency");
      },
      process: {
        argv: ["node", "/agent"],
        getuid: () => 1234,
        kill,
        stdout: {
          write: (line: string) => {
            output += line;
          },
        },
        exit: (code: number) => {
          if (code !== 0) throw new Error("refused");
        },
      },
      setTimeout: (fn: () => void, ms: number) =>
        setTimeout(fn, ms === CHECKOUT_LIMITS.killGraceMs ? 0 : ms),
      clearTimeout,
    });
  return { execute, kill, fs, writes, paths, output: () => output };
}

test("sweeps only old agent handshake comm in a check container, without address-space reads", async () => {
  const s = simulate({
    "10": {},
    "11": { uid: 2345 },
    "12": { comm: "cg-check-run" },
    "13": { comm: "node" },
    "14": { start: "99500" },
    "15": { cwd: "/agent/checks-elsewhere/p/attempt" },
    "16": { state: "Z" },
  });
  await s.execute();
  expect(s.kill.mock.calls).toEqual([
    [10, "SIGTERM"],
    [10, "SIGKILL"],
  ]);
  expect(s.output()).toBe(
    "orphan 10 100 SIGTERM sent\norphan 10 100 SIGKILL sent\nsweep-complete\n",
  );
  expect(
    s.paths.every((path) => /\/(stat|status|wchan|cwd|uptime)$/u.test(path)),
  ).toBe(true);
});

test.each(["uid", "comm", "cwd", "start"] as const)(
  "revalidates %s before signalling a discovered PID",
  async (field) => {
    const s = simulate({
      "10": {
        beforeRecheck: (entry) => {
          if (field === "uid") entry.uid = 2345;
          if (field === "comm") entry.comm = "cg-check-run";
          if (field === "cwd") entry.cwd = "/agent/checks/p/different-attempt";
          if (field === "start") entry.start = "101";
        },
      },
    });
    await s.execute();
    expect(s.kill).not.toHaveBeenCalled();
  },
);

test("rechecks identity after TERM and audits a failed signal", async () => {
  const entry: Process = {};
  const s = simulate({ "10": entry });
  s.kill.mockImplementationOnce(() => {
    entry.start = "101";
    throw new Error("gone");
  });
  await s.execute();
  expect(s.kill).toHaveBeenCalledOnce();
  expect(s.output()).toContain("orphan 10 100 SIGTERM failed");
});

test("a surviving D-state worker leaves a manual-attention marker and PID/state audit", async () => {
  const s = simulate({ "10": { state: "D" } });
  s.kill.mockImplementation(() => {});
  await s.execute();
  expect(s.output()).toContain("manual p/attempt 10 100 D exit_mm");
  expect(s.writes).toHaveBeenCalledWith(
    "/agent/checks/p/attempt/manual-attention.json",
    expect.stringContaining('"state":"D"'),
    { mode: 0o600, flag: "wx" },
  );
});

test("a stuck cwd read times out without signalling or reading cmdline", async () => {
  vi.useFakeTimers();
  const s = simulate({ "10": {} });
  s.fs.readlink.mockImplementation(() => new Promise(() => {}));
  const run = s.execute();
  await vi.advanceTimersByTimeAsync(CHECKOUT_LIMITS.procReadMs);
  await run;
  expect(s.kill).not.toHaveBeenCalled();
  expect(s.paths.some((path) => path.endsWith("/cmdline"))).toBe(false);
});

test("refuses to inspect or kill processes under a different account", () => {
  const s = simulate({ "10": {} }, "operator");
  expect(s.execute).toThrow("refused");
  expect(s.kill).not.toHaveBeenCalled();
});
