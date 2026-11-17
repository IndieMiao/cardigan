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
