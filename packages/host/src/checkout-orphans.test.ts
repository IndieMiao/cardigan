import { basename } from "node:path";
import { runInNewContext } from "node:vm";
import { expect, test, vi } from "vitest";
import { CHECKOUT_HANDSHAKE_TITLE } from "./checkout-limits.js";
import { CHECKOUT_ORPHAN_SWEEP } from "./checkout-orphans.js";

interface Process {
  uid?: number;
  title?: string;
  exe?: string;
  start?: string;
  state?: string;
  beforeRecheck?: (entry: Process) => void;
}
function simulate(entries: Record<string, Process>, username = "agent") {
  let output = "";
  const reads = new Map<string, number>();
  const kill = vi.fn();
  const fs = {
    readdirSync: () => Object.keys(entries),
    lstatSync: (path: string) => {
      const pid = path.split("/")[2] ?? "";
      const entry = entries[pid];
      if (!entry) throw new Error("gone");
      const count = (reads.get(pid) ?? 0) + 1;
      reads.set(pid, count);
      if (count === 2) entry.beforeRecheck?.(entry);
      return { uid: entry.uid ?? 1234 };
    },
    readlinkSync: (path: string) =>
      entries[path.split("/")[2] ?? ""]?.exe ?? "/usr/bin/node",
    readFileSync: (path: string) => {
      if (path === "/proc/uptime") return "1000 0";
      const entry = entries[path.split("/")[2] ?? ""];
      if (!entry) throw new Error("gone");
      if (path.endsWith("/status"))
        return `Uid:\t${Array(4)
          .fill(entry.uid ?? 1234)
          .join("\t")}`;
      if (path.endsWith("/cmdline"))
        return `${entry.title ?? CHECKOUT_HANDSHAKE_TITLE}\0\0`;
      const fields = Array(20).fill("0");
      fields[0] = entry.state ?? "S";
      fields[19] = entry.start ?? "100";
      return `10 (node with spaces) ${fields.join(" ")}`;
    },
  };
  const execute = () =>
    runInNewContext(CHECKOUT_ORPHAN_SWEEP, {
      require: (name: string) => {
        if (name === "node:fs") return fs;
        if (name === "node:os")
          return { userInfo: () => ({ uid: 1234, username }) };
        if (name === "node:path") return { basename };
        if (name === "node:child_process") return { execFileSync: () => "100" };
        throw new Error("Unexpected dependency");
      },
      process: {
        getuid: () => 1234,
        kill,
        stdout: {
          write: (line: string) => {
            output += line;
          },
        },
        exit: () => {
          throw new Error("refused");
        },
      },
      setTimeout: (fn: () => void) => fn(),
    });
  return { execute, kill, output: () => output };
}

test("sweeps only old agent Node handshake workers and audits every signal", async () => {
  const s = simulate({
    "10": {},
    "11": { uid: 2345 },
    "12": { title: "cardigan-check-running-v1" },
    "13": { title: "node\0-e\0old unmarked checkout" },
    "14": { start: "99500" },
    "15": { exe: "/bin/sh" },
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
});

test.each(["uid", "title", "start"] as const)(
  "revalidates %s before signalling a discovered PID",
  async (field) => {
    const s = simulate({
      "10": {
        beforeRecheck: (entry) => {
          if (field === "uid") entry.uid = 2345;
          if (field === "title") entry.title = "cardigan-check-running-v1";
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

test("refuses to inspect or kill processes under a different account", () => {
  const s = simulate({ "10": {} }, "operator");
  expect(s.execute).toThrow("refused");
  expect(s.kill).not.toHaveBeenCalled();
});
