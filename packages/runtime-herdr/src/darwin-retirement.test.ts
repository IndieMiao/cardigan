import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { RuntimeRef } from "@cardigan/domain";
import { expect, test, vi } from "vitest";
import { darwinRetirementObservation } from "./darwin-retirement.js";
import type { ExecutionConfig } from "./execution.js";

const target = {
  project_id: "fixture",
  machine_id: "worker",
  session: "fixture",
  generation: "binding",
  fingerprint: "fingerprint",
};
const execution: Extract<ExecutionConfig, { mode: "agent-ssh" }> = {
  mode: "agent-ssh",
  dataDir: "/controller",
  agentRoot: "/worker",
  gid: 42,
  user: "fixture",
  machine: "alias",
  identityFile: "/private/identity",
  knownHostsFile: "/private/hosts",
  target,
  macosCore: { python: "/bin/python3", retiredLaunchdLabel: "fixture" },
  fileHelper: { python: "/bin/python3", path: "/installed/worker-files.py" },
};
const ref: RuntimeRef = {
  machine_id: target.machine_id,
  runtime_machine: "alias",
  terminal_ref: "alias/t1",
  agent_name: "test",
  target,
  launch_generation: { run_id: "R-1", generation: "g1" },
};
const processReceipt = {
  machine: target.fingerprint,
  terminal: "g1",
  pid: 42,
  uid: 1234,
  process_group: 42,
  boot: "boot",
  start: "1:2",
};
const owner = {
  project_id: "fixture",
  assignment_id: "A-1",
  enrolled_process: processReceipt,
};
test("native observation uses only the pinned generation and worker account", async () => {
  const probe = vi.fn(async () => "exited");
  expect(await darwinRetirementObservation(execution, ref, owner, probe)).toBe(
    "exited",
  );
  expect(probe).toHaveBeenCalledWith(
    execution,
    expect.objectContaining({
      platform: "darwin",
      project: target.project_id,
      session: target.session,
      user: "fixture",
      terminal: "t1",
      process: processReceipt,
    }),
  );
  probe.mockClear();
  for (const receipt of [
    { ...processReceipt, machine: "other" },
    { ...processReceipt, terminal: "next" },
  ])
    expect(
      await darwinRetirementObservation(
        execution,
        ref,
        { ...owner, enrolled_process: receipt },
        probe,
      ),
    ).toBe("unknown");
  expect(probe).not.toHaveBeenCalled();
});
test("Darwin kernel identity, PID reuse, kept shell, permission, timeout and changed generation", () => {
  execFileSync("python3", [
    "-IB",
    fileURLToPath(
      new URL("../test-support/darwin-retirement.py", import.meta.url),
    ),
  ]);
});
