import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { expect, test, vi } from "vitest";
import type { HcClient } from "./client.js";
import { HC_RELEASE } from "./hc-version.js";
import { idleRetirementHelper } from "./idle-retirement.js";
import { HerdrRuntime } from "./index.js";
import { ref, value } from "./test-support.js";

const exec = promisify(execFile);
function adapter(finishAfter?: string) {
  let finished = false;
  const terminal = {
    address: ref.terminal_ref,
    state: "live",
    pid: 12345,
    created_ms: 1000,
    labels: { project: "fixture", assignment: "A-1" },
    keep: false,
  };
  const client: HcClient = {
    available: async () => true,
    async *lines() {},
    exec: vi.fn(async (args) => {
      if (args[0] === "--version") return `hc ${HC_RELEASE.version}`;
      if (args[0] === "get")
        return JSON.stringify({
          ...terminal,
          state: finished ? "finished" : "live",
        });
      const mode = args[args.indexOf(idleRetirementHelper) + 1];
      if (mode === "probe")
        return JSON.stringify({
          pid: 12345,
          start: "10",
          uid: 1000,
          boot: "fixture",
        });
      if (mode === finishAfter) finished = true;
      return "";
    }),
  };
  return {
    client,
    terminal,
    create: async () =>
      value(await HerdrRuntime.create({ client, session: "fixture" })),
  };
}
const options = () => ({
  project_id: "fixture",
  assignment_id: "A-1",
  hangup_ms: 1,
  terminate_ms: 1,
  before_signal: () => true,
});
test("legacy retirement-held wake rechecks live ownership inside the send slot", async () => {
  const f = adapter(),
    runtime = await f.create();
  const guard = { if_idle: true, retirement_owner: options() };
  Object.assign(f.terminal, { status: { state: "idle" } });
  expect(value(await runtime.observe_retirement(ref, options()))).toBe("alive");
  f.terminal.labels.assignment = "A-2";
  expect(value(await runtime.wake(ref, "bell", guard))).toEqual({
    sent: false,
    withdrawn: true,
  });
  expect(
    vi.mocked(f.client.exec).mock.calls.some(([args]) => args[0] === "send"),
  ).toBe(false);
  f.terminal.labels.assignment = "A-1";
  expect(value(await runtime.wake(ref, "bell", guard))).toEqual({ sent: true });
});
test.each(["probe", "signal-slot", "after-signal", "busy", "safe"])(
  "system turn stop binds one signal to the process and never removes by address (%s)",
  async (mode) => {
    const f = adapter("TERM"),
      runtime = await f.create();
    const call = vi.mocked(f.client.exec),
      original = call.getMockImplementation();
    if (!original) throw new Error("Missing mock client");
    let probed = false,
      afterProbe = 0;
    call.mockImplementation(async (args) => {
      if (args.includes("probe")) probed = true;
      if (probed && args[0] === "get") {
        afterProbe++;
        if (
          (mode === "probe" && afterProbe === 1) ||
          (mode === "signal-slot" && afterProbe === 2) ||
          (mode === "after-signal" && afterProbe === 3)
        )
          f.terminal.labels.assignment = "A-2";
        if (mode === "busy" && afterProbe === 2)
          Object.assign(f.terminal, { status: { state: "working" } });
      }
      return original(args);
    });
    const guard = vi.fn(() => true);
    const stopped = await runtime.retire_idle(ref, {
      ...options(),
      system_finished_turn: true,
      before_signal: guard,
    });
    expect(stopped).toMatchObject({
      ok: true,
      value: {
        outcome:
          mode === "safe"
            ? "exited"
            : mode === "after-signal"
              ? "uncertain"
              : "withdrawn",
        ...(mode === "busy" ? { evidence: { reason: "terminal_busy" } } : {}),
      },
    });
    const writes = call.mock.calls
      .map(([a]) => a)
      .filter((a) => a.includes("TERM"));
    const signals = ["safe", "after-signal"].includes(mode) ? 1 : 0;
    expect(writes).toHaveLength(signals);
    expect(guard).toHaveBeenCalledTimes(signals);
    for (const [args] of call.mock.calls)
      expect(args).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/^(kill|rm|HUP)$/)]),
      );
  },
);
test.each(["HUP", "TERM", undefined])(
  "retirement uses only HUP/TERM; finish after %s",
  async (finishAfter) => {
    const f = adapter(finishAfter),
      runtime = await f.create();
    const result = await runtime.retire_idle(ref, options());
    expect(result).toMatchObject({
      ok: true,
      value: { outcome: finishAfter ? "exited" : "timeout" },
    });
    const calls = vi.mocked(f.client.exec).mock.calls.map(([args]) => args);
    expect(
      calls
        .filter((args) => args[0] === "exec")
        .every((args) => !args.includes("--on")),
    ).toBe(true);
    expect(
      calls.some((args) => ["kill", "rm", "interrupt"].includes(args[0]!)),
    ).toBe(false);
    expect(
      calls
        .filter((args) => args[0] === "exec")
        .map((args) => args[args.indexOf(idleRetirementHelper) + 1]),
    ).toEqual(
      finishAfter === "HUP" ? ["probe", "HUP"] : ["probe", "HUP", "TERM"],
    );
  },
);
test("new work at the final guard and uncertain identity prevent every signal", async () => {
  const f = adapter(),
    runtime = await f.create();
  expect(
    await runtime.retire_idle(ref, {
      ...options(),
      before_signal: () => false,
    }),
  ).toMatchObject({
    ok: true,
    value: { outcome: "withdrawn", evidence: { reason: "guard_changed" } },
  });
  expect(
    vi
      .mocked(f.client.exec)
      .mock.calls.filter(([a]) => a.includes("HUP") || a.includes("TERM")),
  ).toHaveLength(0);
  f.terminal.keep = true;
  expect(await runtime.retire_idle(ref, options())).toMatchObject({
    ok: true,
    value: { outcome: "withdrawn", evidence: { reason: "kept_terminal" } },
  });
  f.terminal.keep = false;
  f.terminal.labels.assignment = "A-99";
  expect(await runtime.retire_idle(ref, options())).toMatchObject({
    ok: true,
    value: { outcome: "withdrawn", evidence: { reason: "identity_changed" } },
  });
});
test("only a single exact get can prove retirement exit; snapshot, missing labels or a recycled address cannot", async () => {
  const f = adapter(),
    runtime = await f.create(),
    get = vi.mocked(f.client.exec);
  const generation = { run_id: "R-1" as const, generation: "g1" };
  const generated = { ...ref, launch_generation: generation };
  const labels = { ...f.terminal.labels, run: "R-1", generation: "g1" };
  for (const [owned, address, tags, ok] of [
    [ref, ref.terminal_ref, f.terminal.labels, true],
    [ref, ref.terminal_ref, { project: "fixture", assignment: "A-2" }, false],
    [ref, ref.terminal_ref, { project: "other", assignment: "A-1" }, false],
    [ref, ref.terminal_ref, undefined, false],
    [ref, "t2", f.terminal.labels, false],
    [ref, ref.terminal_ref, labels, false],
    [generated, ref.terminal_ref, { ...labels, run: "R-2" }, false],
    [generated, ref.terminal_ref, { ...labels, generation: "g2" }, false],
    [generated, ref.terminal_ref, labels, true],
  ] as const) {
    get
      .mockClear()
      .mockResolvedValueOnce(
        JSON.stringify({ address, state: "finished", labels: tags }),
      );
    const observed = await runtime.observe_retirement(owned, options());
    expect(observed).toMatchObject(
      ok ? { ok: true, value: "exited" } : { ok: false },
    );
    expect(get.mock.calls.map(([args]) => args)).toEqual([
      ["get", ref.terminal_ref, "--json"],
    ]);
  }
});

test("a changed process after HUP cannot receive TERM and is not reported exited", async () => {
  const f = adapter(),
    runtime = await f.create();
  const original = vi.mocked(f.client.exec).getMockImplementation()!;
  vi.mocked(f.client.exec).mockImplementation(async (args) => {
    const result = await original(args);
    if (args.includes("HUP")) f.terminal.pid++;
    return result;
  });
  expect(await runtime.retire_idle(ref, options())).toMatchObject({
    ok: true,
    value: {
      outcome: "uncertain",
      evidence: { reason: "identity_changed", terminal_state: "live" },
    },
  });
  expect(
    vi.mocked(f.client.exec).mock.calls.some(([args]) => args.includes("TERM")),
  ).toBe(false);
});
test.skipIf(process.platform !== "linux")(
  "real isolated pidfd helper rejects wrong identity and sends HUP then TERM without escalation",
  async () => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        `process.on('SIGHUP',()=>console.log('HUP'));process.on('SIGTERM',()=>{console.log('TERM');process.exit(0)});process.stdin.resume();process.stdin.on('data',()=>process.exit(0));console.log('ready')`,
      ],
      {
        env: { PATH: process.env.PATH, HC_TERMINAL_ID: "fixture-t1" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (data) => {
      output += data;
    });
    const exited = once(child, "exit");
    const helper = (mode: string, identity?: string, terminal = "fixture-t1") =>
      exec(
        "python3",
        [
          "-I",
          "-c",
          idleRetirementHelper,
          mode,
          String(child.pid),
          terminal,
          ...(identity ? [identity] : []),
        ],
        { timeout: 5000 },
      );
    try {
      await vi.waitFor(() => expect(output).toContain("ready"));
      const identity = JSON.parse((await helper("probe")).stdout);
      await expect(
        helper("probe", undefined, "other-terminal"),
      ).rejects.toMatchObject({ code: 22 });
      await expect(
        helper("HUP", JSON.stringify({ ...identity, start: "wrong" })),
      ).rejects.toThrow();
      await expect(helper("KILL", JSON.stringify(identity))).rejects.toThrow();
      await expect(
        helper("TERM", JSON.stringify(identity), "other-terminal"),
      ).rejects.toThrow();
      expect(child.exitCode).toBeNull();
      await helper("HUP", JSON.stringify(identity));
      await vi.waitFor(() => expect(output).toContain("HUP"));
      await helper("TERM", JSON.stringify(identity));
      expect(await exited).toEqual([0, null]);
      expect(output).toContain("TERM");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.stdin.end("exit");
        await exited;
      }
    }
  },
);
