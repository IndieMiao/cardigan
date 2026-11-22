import type { Runtime } from "@cardigan/domain";
import { expect, test, vi } from "vitest";
import { type HcClient, RuntimeFailure } from "./client.js";
import { HC_RELEASE } from "./hc-version.js";
import { HerdrRuntime } from "./index.js";
import { ref, value } from "./test-support.js";

function gate() {
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { pending, release };
}
function client(): HcClient {
  return {
    available: async () => true,
    exec: vi.fn(async (args) =>
      args[0] === "--version" ? `hc ${HC_RELEASE.version}` : "{}",
    ),
    async *lines() {},
  };
}

test("Runtime contract: authority is rechecked after liveness IO and withdrawal proves no send", async () => {
  const raw = client();
  const runtime: Runtime = value(await HerdrRuntime.create({ client: raw }));
  const entered = gate(),
    ready = gate();
  raw.available = async () => {
    entered.release();
    await ready.pending;
    return true;
  };
  let allowed = true;
  const check = vi.fn(() => allowed);
  const sending = runtime.wake(ref, "bell", { before_send: check });
  try {
    await entered.pending;
    expect(check).not.toHaveBeenCalled();
    allowed = false;
    ready.release();
    expect(await sending).toEqual({
      ok: true,
      value: { sent: false, withdrawn: true },
    });
    expect(check).toHaveBeenCalledOnce();
    expect(vi.mocked(raw.exec).mock.calls.map(([args]) => args[0])).toEqual([
      "--version",
    ]);
    allowed = true;
    expect(
      await runtime.wake(ref, "bell", { if_idle: true, before_send: check }),
    ).toEqual({ ok: true, value: { sent: true } });
    expect(raw.exec).toHaveBeenLastCalledWith([
      "send",
      "--json",
      "--if",
      "idle",
      "--",
      ref.terminal_ref,
      "bell",
    ]);
  } finally {
    ready.release();
    await sending;
  }
});

test("Runtime contract: a failed guard is closed and cannot send", async () => {
  const raw = client();
  const runtime: Runtime = value(await HerdrRuntime.create({ client: raw }));
  const outcome = await runtime.wake(ref, "bell", {
    before_send: () => {
      throw new Error("authority read unavailable");
    },
  });
  expect(outcome).toMatchObject({
    ok: false,
    error: { code: "runtime_unavailable" },
  });
  expect(raw.exec).toHaveBeenCalledTimes(1);
});

test("Runtime contract: stopping after send starts cannot turn an uncertain failure into withdrawal", async () => {
  const raw = client();
  const runtime: Runtime = value(await HerdrRuntime.create({ client: raw }));
  const entered = gate(),
    response = gate();
  raw.exec = vi.fn(async () => {
    entered.release();
    await response.pending;
    throw new RuntimeFailure("runtime_timeout", "fixture response lost");
  });
  let allowed = true;
  const sending = runtime.wake(ref, "bell", { before_send: () => allowed });
  try {
    await entered.pending;
    allowed = false;
    response.release();
    expect(await sending).toEqual({
      ok: false,
      error: { code: "runtime_timeout", message: "fixture response lost" },
    });
    expect(raw.exec).toHaveBeenCalledOnce();
  } finally {
    response.release();
    await sending;
  }
});

test.each([
  "done",
  "resumed",
  "steady_unknown",
  "becomes_idle",
  "new_turn",
  "osc_changed",
  "read_failure",
] as const)(
  "in-turn wake checks %s evidence inside the acquired hc slot",
  async (mode) => {
    const raw = client(),
      entered = gate(),
      release = gate();
    const runtime = value(
      await HerdrRuntime.create({
        client: raw,
        env: { CARDIGAN_HC_CONCURRENCY: "1" },
      }),
    );
    let state = mode === "done" || mode === "resumed" ? "done" : "unknown";
    let ended = true;
    const calls: string[][] = [];
    raw.exec = async (args) => {
      calls.push([...args]);
      if (args[0] === "send" && args.at(-1) === "hold") {
        entered.release();
        await release.pending;
      }
      if (args[0] === "get") {
        if (mode === "read_failure") throw new Error("status unavailable");
        return JSON.stringify({
          address: ref.terminal_ref,
          state: "live",
          status: { state },
        });
      }
      return "{}";
    };
    const holder = runtime.wake(ref, "hold");
    try {
      await entered.pending;
      const sending = runtime.wake(ref, "bell", {
        observed_guard:
          state === "done"
            ? { state: "done" }
            : {
                state: "unknown",
                confirm_turn_end: async () => {
                  if (mode === "becomes_idle") state = "idle";
                  return ended;
                },
              },
      });
      await expect.poll(() => runtime.diagnostics().queued).toBe(1);
      expect(calls).toHaveLength(1);
      if (mode === "resumed" || mode === "osc_changed") state = "working";
      if (mode === "new_turn") ended = false;
      release.release();
      const send = mode === "done" || mode === "becomes_idle";
      expect(value(await sending)).toEqual(
        send ? { sent: true } : { sent: false, withdrawn: true },
      );
      expect(calls.slice(1).map((args) => args[0])).toEqual(
        mode === "becomes_idle"
          ? ["get", "get", "send"]
          : mode === "steady_unknown"
            ? ["get", "get"]
            : send
              ? ["get", "send"]
              : ["get"],
      );
      if (send)
        expect(calls.at(-1)).toEqual([
          "send",
          "--json",
          ...(mode === "becomes_idle" ? ["--if", "idle"] : []),
          "--",
          ref.terminal_ref,
          "bell",
        ]);
    } finally {
      release.release();
      await holder;
    }
  },
);

test("withdraws if the terminal reports work while the transcript response is in flight", async () => {
  const raw = client(),
    sampled = gate(),
    response = gate();
  const runtime = value(await HerdrRuntime.create({ client: raw }));
  let state = "unknown";
  raw.exec = vi.fn(async (args) =>
    args[0] === "get"
      ? JSON.stringify({
          address: ref.terminal_ref,
          state: "live",
          status: { state },
        })
      : "{}",
  );
  const sending = runtime.wake(ref, "bell", {
    observed_guard: {
      state: "unknown",
      confirm_turn_end: async () => {
        sampled.release();
        await response.pending;
        return true;
      },
    },
  });
  try {
    await sampled.pending;
    state = "working";
    response.release();
    expect(value(await sending)).toEqual({ sent: false, withdrawn: true });
    expect(
      vi.mocked(raw.exec).mock.calls.some(([args]) => args[0] === "send"),
    ).toBe(false);
  } finally {
    response.release();
    await sending;
  }
});

test("target preflight runs before the final synchronous authority check and never sends on failure", async () => {
  const raw = client();
  const runtime: Runtime = value(await HerdrRuntime.create({ client: raw }));
  const guard = vi.fn(() => true);
  expect(
    await runtime.wake(ref, "bell", {
      resource_preflight: async () => false,
      before_send: guard,
    }),
  ).toMatchObject({ ok: true, value: { withdrawn: true } });
  expect(guard).not.toHaveBeenCalled();
  expect(
    await runtime.wake(ref, "bell", {
      resource_preflight: async () => {
        guard.mockReturnValue(false);
        return true;
      },
      before_send: guard,
    }),
  ).toMatchObject({ ok: true, value: { withdrawn: true } });
  expect(guard).toHaveBeenCalledOnce();
  expect(raw.exec).toHaveBeenCalledTimes(1);
});

test.each(["claude-code", "codex"] as const)(
  "bound %s prompt is re-proven inside send slot and never types into a kept shell",
  async (harness) => {
    const raw = client(),
      runtime = value(await HerdrRuntime.create({ client: raw }));
    const binding = {
      project_id: "fixture",
      assignment_id: "A-1",
      harness,
      require_disconnect: true as const,
    };
    const idle =
      harness === "codex"
        ? "■ stream disconnected before completion\n›\n? for shortcuts"
        : "⎿  API Error: Connection lost mid-response\n──────────\n❯\n──────────\n? for shortcuts";
    let screen = idle,
      fg = harness === "codex" ? "codex" : "claude",
      address = ref.terminal_ref,
      state = "unknown";
    const send = vi.fn();
    raw.exec = async (args) => {
      if (args[0] === "get")
        return JSON.stringify({
          address: args[1] === ref.agent_name ? address : ref.terminal_ref,
          state: "live",
          status: { state },
          labels: { project: "fixture", assignment: "A-1" },
          foreground: { pid: 10, name: fg },
          created_ms: 1000,
        });
      if (args[0] === "read") return screen;
      if (args[0] === "send") send();
      return "{}";
    };
    expect(value(await runtime.observe_prompt(ref, binding))).toBe(true);
    const poke = () =>
      runtime.wake(ref, "fixture", { prompt_binding: binding });
    fg = "bash";
    expect(value(await poke()).withdrawn).toBe(true);
    fg = harness === "codex" ? "codex" : "claude";
    address = "t2";
    expect(value(await poke()).withdrawn).toBe(true);
    address = ref.terminal_ref;
    state = "working";
    expect(value(await poke()).withdrawn).toBe(true);
    state = "unknown";
    screen = idle.replace(/\n([›❯])/u, "\n$1 pending input");
    expect(value(await poke()).withdrawn).toBe(true);
    screen = idle.replace(/disconnected|Connection lost/u, "other");
    expect(value(await poke()).withdrawn).toBe(true);
    expect(send).not.toHaveBeenCalled();
    screen = idle;
    expect(value(await poke())).toEqual({ sent: true });
    expect(send).toHaveBeenCalledOnce();
  },
);

test.each(["idle", "done"])(
  "kept %s still requires an empty editor before the original bell",
  async (state) => {
    const raw = client();
    const runtime = value(await HerdrRuntime.create({ client: raw }));
    const binding = {
      project_id: "fixture",
      assignment_id: "A-1",
      harness: "codex" as const,
    };
    let screen = "›\n? for shortcuts";
    const writes: string[][] = [];
    raw.exec = async (args) => {
      if (args[0] === "get")
        return JSON.stringify({
          address: ref.terminal_ref,
          state: "live",
          status: { state },
          labels: { project: "fixture", assignment: "A-1" },
          foreground: { name: "codex", pid: 42 },
        });
      if (args[0] === "read") return screen;
      if (args[0] === "send") writes.push([...args]);
      return "{}";
    };
    const send = () =>
      runtime.wake(ref, "original", { prompt_binding: binding });
    // The editor can change after the outer preflight without changing OSC state.
    expect(value(await runtime.observe_prompt(ref, binding))).toBe(true);
    for (const editor of [
      "› draft",
      "› Explain this codebase",
      "Press Enter to confirm\n›",
    ]) {
      screen = `${editor}\n? for shortcuts`;
      expect(value(await runtime.observe_prompt(ref, binding))).toBe(false);
      expect(value(await send())).toEqual({ sent: false, withdrawn: true });
    }
    expect(writes).toEqual([]);
    screen = "›\n? for shortcuts";
    expect(value(await send())).toEqual({ sent: true });
    expect(writes).toEqual([
      [
        "send",
        "--json",
        ...(state === "idle" ? ["--if", "idle"] : []),
        "--",
        ref.terminal_ref,
        "original",
      ],
    ]);
  },
);

test("kept idle uses hc's write-time condition when work starts after the final prompt check", async () => {
  const raw = client();
  const runtime = value(await HerdrRuntime.create({ client: raw }));
  let state = "idle";
  const typed: string[] = [];
  raw.exec = async (args) => {
    if (args[0] === "get")
      return JSON.stringify({
        address: ref.terminal_ref,
        state: "live",
        status: { state },
        labels: { project: "fixture", assignment: "A-1" },
        foreground: { name: "claude", pid: 10 },
      });
    if (args[0] === "read") return "──────────\n❯\n──────────\n? for shortcuts";
    if (args[0] === "send") {
      if (args[2] === "--if" && args[3] === "idle" && state !== "idle")
        throw new RuntimeFailure(
          "runtime_conflict",
          "fixture condition declined",
        );
      typed.push(args.join(" "));
    }
    return "{}";
  };
  const result = await runtime.wake(ref, "bell", {
    prompt_binding: {
      project_id: "fixture",
      assignment_id: "A-1",
      harness: "claude-code",
    },
    before_send: () => {
      state = "working";
      return true;
    },
  });
  expect(result.ok).toBe(false);
  expect(typed).toEqual([]);
});
