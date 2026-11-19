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
  "same_turn",
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
            : { state: "unknown", confirm_turn_end: async () => ended },
      });
      await expect.poll(() => runtime.diagnostics().queued).toBe(1);
      expect(calls).toHaveLength(1);
      if (mode === "resumed" || mode === "osc_changed") state = "working";
      if (mode === "new_turn") ended = false;
      release.release();
      const send = mode === "done" || mode === "same_turn";
      expect(value(await sending)).toEqual(
        send ? { sent: true } : { sent: false, withdrawn: true },
      );
      expect(calls.slice(1).map((args) => args[0])).toEqual(
        mode === "same_turn"
          ? ["get", "get", "send"]
          : send
            ? ["get", "send"]
            : ["get"],
      );
      if (send)
        expect(calls.at(-1)).toEqual([
          "send",
          "--json",
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
