import { expect, test, vi } from "vitest";
import type { HcClient } from "./client.js";
import { HC_RELEASE } from "./hc-version.js";
import { HerdrRuntime } from "./index.js";
import { confirmationVisible } from "./interaction.js";
import { ref, value } from "./test-support.js";

const screen =
  "Would you like to run the following command?\n$ echo synthetic-secret\n› 1. Yes, proceed (y)\n  2. No, and tell Codex what to do differently (esc)\nPress enter to confirm or esc to cancel";
const identity = {
  project_id: "fixture",
  assignment_id: "A-1",
  harness: "codex",
};
test("complete visible approval menu is required; excerpts, prose and oversize remain unknown", () => {
  expect(confirmationVisible(screen)).toBe(true);
  for (const text of [
    "",
    "waiting for approval",
    screen.split("\n").slice(0, -1).join("\n"),
    `Example: ${screen}`,
    "x".repeat(65537),
  ])
    expect(confirmationVisible(text)).toBe(false);
});
async function fixture() {
  let terminal = {
    address: "t1",
    state: "live",
    status: { state: "blocked" },
    labels: {
      project: "fixture",
      assignment: "A-1",
      run: "R-1",
      generation: "one",
    },
  };
  const client: HcClient = {
    available: async () => true,
    async *lines() {},
    exec: vi.fn(async (args) =>
      args[0] === "--version"
        ? `hc ${HC_RELEASE.version}`
        : args[0] === "read"
          ? screen
          : JSON.stringify(terminal),
    ),
  };
  return {
    client,
    runtime: value(await HerdrRuntime.create({ client, session: "isolated" })),
    set: (next: Partial<typeof terminal>) => {
      terminal = { ...terminal, ...next };
    },
    terminal,
  };
}
test("only enums cross the runtime boundary; read has no history or caller-supplied arguments", async () => {
  const f = await fixture();
  const result = await f.runtime.interaction(ref, identity);
  expect(result).toEqual({ ok: true, value: "confirmation" });
  expect(JSON.stringify(result)).not.toContain("synthetic-secret");
  expect(f.client.exec).toHaveBeenCalledWith(["read", "t1", "--lines", "0"]);
  expect(
    vi
      .mocked(f.client.exec)
      .mock.calls.some(([args]) =>
        ["send", "run", "interrupt", "kill"].includes(args[0] ?? ""),
      ),
  ).toBe(false);
});
test("wrong identity or generation rejects before reading; exit and unsupported harness never read", async () => {
  for (const change of [
    { project: "elsewhere" },
    { assignment: "A-2" },
    { generation: "two" },
  ]) {
    const f = await fixture();
    f.set({ labels: { ...f.terminal.labels, ...change } });
    expect(
      (
        await f.runtime.interaction(
          {
            ...ref,
            launch_generation: { run_id: "R-1" as never, generation: "one" },
          },
          identity,
        )
      ).ok,
    ).toBe(false);
    expect(
      vi.mocked(f.client.exec).mock.calls.some(([args]) => args[0] === "read"),
    ).toBe(false);
  }
  const f = await fixture();
  f.set({ state: "finished" });
  expect(await f.runtime.interaction(ref, identity)).toEqual({
    ok: true,
    value: "exited",
  });
  expect(
    vi.mocked(f.client.exec).mock.calls.some(([args]) => args[0] === "read"),
  ).toBe(false);
});
test("mid-read replacement and raw failure output cannot leak or become confirmation", async () => {
  const f = await fixture();
  const original = f.client.exec;
  f.client.exec = vi.fn(async (args) => {
    if (args[0] === "read") {
      f.set({ labels: { ...f.terminal.labels, run: "R-2" } });
      return screen;
    }
    return original(args);
  });
  expect((await f.runtime.interaction(ref, identity)).ok).toBe(false);
  f.client.exec = async () => {
    throw new Error(screen);
  };
  const result = await f.runtime.interaction(ref, identity);
  expect(result).toEqual({
    ok: false,
    error: { code: "runtime_unavailable", message: "交互观察不可用" },
  });
});

test("working processes and other harnesses do not trigger Codex screen matching", async () => {
  const f = await fixture();
  expect(
    await f.runtime.interaction(ref, { ...identity, harness: "pi" }),
  ).toEqual({ ok: true, value: "blocked" });
  f.set({ status: { state: "working" } });
  expect(await f.runtime.interaction(ref, identity)).toEqual({
    ok: true,
    value: "unknown",
  });
  expect(
    vi.mocked(f.client.exec).mock.calls.some(([args]) => args[0] === "read"),
  ).toBe(false);
  expect(confirmationVisible(`${screen}\nTask resumed`)).toBe(false);
});

test("C-541: output comparison ignores spinner time and never exports screen/argv; a replaced terminal is unknown", async () => {
  const f = await fixture();
  const original = f.client.exec;
  let changed = false,
    replace = false;
  f.client.exec = async (args) => {
    if (args[0] !== "read") return original(args);
    if (replace)
      f.set({ labels: { ...f.terminal.labels, run: "replacement" } });
    return `PRIVATE-SCREEN\n✻ Working… (${changed ? "2" : "1"}m • esc to interrupt)`;
  };
  const read = () =>
    f.runtime.terminalActivity(
      ref,
      identity.project_id,
      identity.assignment_id,
    );
  const first = await read();
  changed = true;
  expect(first.ok).toBe(true);
  expect(await read()).toEqual(first);
  expect(JSON.stringify(first)).not.toContain("PRIVATE-SCREEN");
  replace = true;
  expect((await read()).ok).toBe(false);
});
