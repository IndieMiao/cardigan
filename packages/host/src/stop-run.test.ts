import type { Runtime, RuntimeRef } from "@cardigan/domain";
import { expect, test, vi } from "vitest";
import { stopRunRuntime } from "./stop-run.js";

const ref: RuntimeRef = {
  machine_id: "local",
  runtime_machine: "local",
  terminal_ref: "t1",
  agent_name: "fixture",
};
test.each([
  "alive",
  "unknown",
  "unsupported",
  "missing",
  "throw",
  "wrong-generation",
])(
  "stop retains its fence when descendants are %s, regardless of terminal absence or release success",
  async (state) => {
    const release = vi.fn(async () => ({
      ok: true as const,
      value: undefined,
    }));
    const runtime = {
      status: async () => ({
        ok: false,
        error: { code: "runtime_not_found", message: "gone" },
      }),
      release,
      ...(state === "unsupported"
        ? {}
        : {
            verifyExit: async () => {
              if (state === "throw") throw new Error("unreachable");
              if (state === "missing")
                return {
                  ok: false,
                  error: { code: "runtime_not_found", message: "gone" },
                };
              return {
                ok: true,
                value: {
                  ref:
                    state === "wrong-generation"
                      ? { ...ref, agent_session_id: "other" }
                      : ref,
                  state: state === "wrong-generation" ? "exited" : state,
                },
              };
            },
          }),
    } as Runtime;
    expect(await stopRunRuntime(runtime, ref, () => true)).toBe("unconfirmed");
    expect(release).toHaveBeenCalledOnce();
    expect(await stopRunRuntime(runtime, ref, () => true, true, false)).toBe(
      "not_exited",
    );
  },
);
test("trusted complete-scope evidence settles the same stop without sending another kill", async () => {
  const release = vi.fn();
  const runtime = {
    release,
    verifyExit: async (ref: RuntimeRef) => ({
      ok: true,
      value: { ref, state: "exited" },
    }),
  } as unknown as Runtime;
  expect(await stopRunRuntime(runtime, ref, () => true, true)).toBe("exited");
  expect(release).not.toHaveBeenCalled();
  expect(await stopRunRuntime(runtime, null, () => true)).toBe("unconfirmed");
});
