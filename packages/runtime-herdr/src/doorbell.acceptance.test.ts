import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  checkDoorbell,
  DOORBELL,
  doorbellAgent,
  OBSERVED,
} from "../test-support/doorbell.js";
import { type HcClient, RuntimeFailure } from "./client.js";
import { HC_RELEASE } from "./hc-version.js";
import { HerdrRuntime } from "./index.js";
import { ref, value } from "./test-support.js";

afterEach(() => vi.useRealTimers());

/** Inject transport timing, without starting hc or using a real clock/load. */
async function fixture(
  delayAt: "send" | "get" | "snapshot",
  mode = "handshake",
) {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  let sentAt: number | undefined;
  let acknowledged = false;
  let receipt = "";
  let seq = 0;
  let startup = true;
  const snapshots: { at: number; state: string }[] = [];
  const state = () => {
    if (sentAt === undefined || ["missing", "no working"].includes(mode))
      return "idle";
    if (mode === "legacy" && Date.now() - sentAt >= 200) return "idle";
    if (acknowledged && ["done", "unknown", "error"].includes(mode))
      return mode;
    if (acknowledged && mode !== "stuck") return "idle";
    return "working";
  };
  const delay = (phase: typeof delayAt) => {
    if (sentAt !== undefined && delayAt === phase)
      vi.setSystemTime(Date.now() + 300);
  };
  const terminal = () => ({
    address: ref.terminal_ref,
    state: mode === "exited" && sentAt !== undefined ? "finished" : "live",
    status: { state: state() },
  });
  const client: HcClient = {
    available: async () => true,
    exec: vi.fn(async (args) => {
      if (args[0] === "--version") return `hc ${HC_RELEASE.version}`;
      if (args[0] === "send") {
        if (args.at(-1) === DOORBELL) {
          expect(args).toContain("--if");
          expect(state()).toBe("idle");
          sentAt = Date.now();
          receipt =
            mode === "missing"
              ? ""
              : mode === "wrong receipt"
                ? "other bell"
                : DOORBELL;
        } else {
          expect(args.at(-1)).toBe(OBSERVED);
          expect(snapshots.at(-1)?.state).toBe("working");
          acknowledged = true;
        }
        delay("send");
      }
      if (args[0] === "get") delay("get");
      return JSON.stringify(terminal());
    }),
    async *lines() {
      delay("snapshot");
      if (mode === "status error" && sentAt !== undefined)
        throw new RuntimeFailure("runtime_unavailable", "fixture status error");
      const t = terminal();
      // Readiness must wait for idle, not accept the first unknown snapshot.
      if (startup || mode === "not ready") t.status.state = "unknown";
      startup = false;
      snapshots.push({ at: Date.now(), state: t.status.state });
      yield JSON.stringify({ seq: ++seq, terminals: [t] });
    },
  };
  const runtime = value(await HerdrRuntime.create({ client }));
  const release = vi.spyOn(runtime, "release");
  return {
    runtime,
    snapshots,
    release,
    received: () => receipt,
    cleaned: () => {
      expect(release).toHaveBeenCalledExactlyOnceWith(ref, { force: true });
      expect(client.exec).toHaveBeenCalledWith([
        "rm",
        ref.terminal_ref,
        "--json",
      ]);
      expect(vi.getTimerCount()).toBe(0);
    },
  };
}

test.each(["send", "get", "snapshot"] as const)(
  "legacy 200ms transition is missed when %s takes 300ms, despite delivery",
  async (phase) => {
    const f = await fixture(phase, "legacy");
    const failed = expect(
      checkDoorbell(f.runtime, ref, f.received),
    ).rejects.toThrow(/after doorbell: timed out; last=.*"agent":"idle"/);
    await vi.runAllTimersAsync();
    await failed;
    expect(f.received()).toBe(DOORBELL);
    expect(f.snapshots.some((s) => s.state === "working")).toBe(false);
    f.cleaned();
  },
);

test.each(["send", "get", "snapshot"] as const)(
  "handshake preserves working across a delayed %s, then observes idle",
  async (phase) => {
    const f = await fixture(phase);
    const checked = checkDoorbell(f.runtime, ref, f.received);
    await vi.runAllTimersAsync();
    await checked;
    expect(f.snapshots.map((s) => s.state)).toEqual([
      "unknown",
      "idle",
      "working",
      "idle",
    ]);
    f.cleaned();
  },
);

test.each([
  ["not ready", "before doorbell: timed out"],
  ["missing", "after doorbell: timed out"],
  ["no working", "after doorbell: timed out"],
  ["wrong receipt", "agent received a different doorbell"],
  ["stuck", "after acknowledgement: timed out"],
  ["done", "after acknowledgement: timed out"],
  ["unknown", "after acknowledgement: timed out"],
  ["error", "after acknowledgement: timed out"],
  ["exited", "after doorbell: terminal exited"],
  ["status error", "runtime_unavailable: fixture status error"],
])("%s fails the contract and still cleans up", async (mode, message) => {
  const f = await fixture("get", mode);
  const failed = expect(
    checkDoorbell(f.runtime, ref, f.received),
  ).rejects.toThrow(message);
  await vi.runAllTimersAsync();
  await failed;
  f.cleaned();
});

test("a refused send fails before observation and still releases the terminal", async () => {
  const f = await fixture("get");
  vi.spyOn(f.runtime, "wake").mockResolvedValue({
    ok: true,
    value: { sent: false },
  });
  const failed = expect(
    checkDoorbell(f.runtime, ref, f.received),
  ).rejects.toThrow("doorbell was not sent");
  await vi.runAllTimersAsync();
  await failed;
  f.cleaned();
});

test("cleanup failure preserves the original doorbell diagnostic", async () => {
  const f = await fixture("get", "missing");
  f.release.mockResolvedValue({
    ok: false,
    error: { code: "runtime_unavailable", message: "fixture cleanup error" },
  });
  const checked = checkDoorbell(f.runtime, ref, f.received).catch(
    (error) => error,
  );
  await vi.runAllTimersAsync();
  const error = await checked;
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.errors.map((e: Error) => e.message)).toEqual([
    expect.stringContaining("after doorbell: timed out"),
    "runtime_unavailable: fixture cleanup error",
  ]);
  expect(f.release).toHaveBeenCalledExactlyOnceWith(ref, { force: true });
});

test.each([OBSERVED, "wrong acknowledgement", null])(
  "shell agent records the bell and requires the exact acknowledgement: %s",
  async (ack) => {
    const directory = mkdtempSync(join(tmpdir(), "cg-doorbell-"));
    const agent = doorbellAgent(directory);
    const child = spawn(agent.command, agent.args, { stdio: "pipe" });
    const closed = once(child, "close");
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    async function reported(state: string) {
      while (!output.endsWith(`\x1b]7501;state=${state}\x07`))
        await once(child.stdout, "data", { signal: AbortSignal.timeout(5000) });
    }
    try {
      await reported("idle");
      // Backslashes and shell metacharacters are input, never shell code.
      const bell = `${DOORBELL} literal=\\$()"'`;
      child.stdin.write(`${bell}\n`);
      await reported("working");
      expect(readFileSync(agent.receipt, "utf8")).toBe(bell);
      expect(output.match(/state=idle/g)).toHaveLength(1);
      child.stdin.end(ack === null ? undefined : `${ack}\n`);
      const [code] = await closed;
      expect(code).toBe(ack === OBSERVED ? 0 : ack === null ? 1 : 2);
      expect(output.match(/state=idle/g)).toHaveLength(
        ack === OBSERVED ? 2 : 1,
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
