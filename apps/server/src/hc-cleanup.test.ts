import { spawn } from "node:child_process";
import { expect, test } from "vitest";
import {
  HcCore,
  isHerdrCoreProcess,
  runCleanupSteps,
} from "../test-support/hc.js";

const running = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const exited = (child: ReturnType<typeof spawn>): Promise<void> =>
  new Promise((resolve) => child.once("exit", () => resolve()));

test("cleanup runs every step and reports all failures with the session and socket", async () => {
  const ran: string[] = [];
  await expect(
    runCleanupSteps({
      session: "fixture-session",
      socket: "/tmp/fixture.sock",
      steps: [
        {
          label: "stop herdr-core",
          run: () => {
            ran.push("stop");
            throw new Error("core still alive");
          },
        },
        {
          label: "close server",
          run: () => {
            ran.push("server");
            throw new Error("server busy");
          },
        },
        {
          label: "remove temporary directory",
          run: () => {
            ran.push("remove");
          },
        },
      ],
    }),
  ).rejects.toThrow(
    /Cleanup failed for herdr session fixture-session \(socket \/tmp\/fixture\.sock\):\n- stop herdr-core: core still alive\n- close server: server busy/,
  );
  expect(ran).toEqual(["stop", "server", "remove"]);
});

test("a recycled or non-herdr PID is never signalled", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    env: { ...process.env, HC_SESSION: "fixture-session" },
  });
  if (child.pid === undefined) throw new Error("child did not start");
  await new Promise((resolve) => setTimeout(resolve, 100));
  try {
    expect(isHerdrCoreProcess(child.pid, "fixture-session")).toBe(false);
    const core = new HcCore("fixture-session", "/tmp/no-such-core.sock", {});
    core.trackPid(child.pid);
    core.killRecordedNow();
    expect(running(child.pid)).toBe(true);
    await core.stop();
    expect(running(child.pid)).toBe(true);
  } finally {
    child.kill("SIGKILL");
    await exited(child);
  }
});

test("an already exited PID is skipped without throwing", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
  if (child.pid === undefined) throw new Error("child did not start");
  await exited(child);
  const core = new HcCore("fixture-session", "/tmp/no-such-core.sock", {});
  core.trackPid(child.pid, true);
  expect(() => core.killRecordedNow()).not.toThrow();
  await expect(core.stop()).resolves.toBeUndefined();
  expect(isHerdrCoreProcess(child.pid, "fixture-session")).toBe(false);
});
