import { expect, test } from "vitest";
import type { RuntimeRef } from "./entities.js";
import { runtimeExitMatches } from "./runtime-port.js";

const ref: RuntimeRef = {
  machine_id: "local",
  runtime_machine: "local",
  terminal_ref: "t1",
  agent_name: "coder-a1",
  worktree_path: "/fixture/worktree",
  branch: "agent/fixture",
  agent_session_id: "first",
  target: {
    project_id: "fixture",
    machine_id: "local",
    session: "isolated",
    generation: "one",
    fingerprint: "first",
  },
};
test("only full-scope exit for the exact original target and launch identity authorizes cleanup", () => {
  const target = ref.target;
  if (!target) throw new Error("Missing fixture target");
  expect(runtimeExitMatches({ ref, state: "exited" }, ref)).toBe(true);
  for (const state of ["unknown", "alive"] as const)
    expect(runtimeExitMatches({ ref, state }, ref)).toBe(false);
  for (const key of [
    "machine_id",
    "runtime_machine",
    "terminal_ref",
    "agent_name",
    "worktree_path",
    "branch",
    "agent_session_id",
  ] as const)
    expect(
      runtimeExitMatches(
        { ref: { ...ref, [key]: "changed" }, state: "exited" },
        ref,
      ),
    ).toBe(false);
  for (const key of [
    "project_id",
    "machine_id",
    "session",
    "generation",
    "fingerprint",
  ] as const)
    expect(
      runtimeExitMatches(
        {
          ref: { ...ref, target: { ...target, [key]: "changed" } },
          state: "exited",
        },
        ref,
      ),
    ).toBe(false);
  const { target: _target, ...legacy } = ref;
  expect(runtimeExitMatches({ ref: legacy, state: "exited" }, ref)).toBe(false);
});
