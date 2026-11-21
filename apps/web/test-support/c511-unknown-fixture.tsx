import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import {
  ApiError,
  type ExecutionCapacity,
  type MachineCheckJob,
  type MachineView,
} from "../src/api.js";
import { fakeClient, NOW } from "../src/testing/fixtures.js";
import { fixtureMachines } from "../src/testing/machines-fixture.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/components/ui/theme.css";
import { settingsPanels } from "./settings-panels-data.js";

// C-511 Q-1048 evidence: the synthetic machines of the unit tests (本机,
// 构建机, Mac mini) and one capacity record. `?scene=` picks what the
// machine writes answer; every reply is lost in the page (TypeError), no
// backend, host or production record is touched.
//   lost     立即检查 / 排空 replies lost, reads unchanged
//   running  立即检查 reply lost, the next read shows another project's check
//   stale    Q-1076: 立即检查's reply (job A) waits for `__c511.releaseA()`;
//            with `__c511.b` the reads show job B running on this project,
//            with `__c511.fail` they fail (500). A's progress ends at once,
//            B's never does.
//   r4       Q-1083: as stale, but with `__c511.aDone` the reads show job A
//            already passed and A's progress read fails (503).
//   p1       Q-1083: 立即检查 answers job A at once, A's progress fails
//            (SSH); with `__c511.b` the reads show job B running (MCP).
//   p1c      Q-1085: 立即检查's reply (A) waits for `releaseA()`; reads
//            follow `__c511.read` ("a": A running, "b": B running,
//            "bdone": B passed); A's progress fails on `failA()`, B's
//            passes on `passB()`. Q-1088: with `__c511.bFail` B fails
//            (MCP) instead, in its record and its progress.
Date.now = () => new Date(NOW).getTime();
// Each scene starts without an unknown write kept from the previous one.
window.sessionStorage.clear();
const scene = new URLSearchParams(location.search).get("scene") ?? "lost";
const machines = new Map(fixtureMachines.map((m) => [m.id, m]));
const local = machines.get("local") as MachineView;
const running: MachineView = {
  ...local,
  bindings: local.bindings.map((b) =>
    b.project_id === "peer"
      ? {
          ...b,
          last_requested_check: {
            id: "chk-peer",
            kind: "machine",
            status: "running",
            step: "ssh",
            checked_at: NOW,
            failed_steps: [],
          },
        }
      : b,
  ),
};
let sent = false;
const hooks = {
  b: false,
  fail: false,
  aDone: false,
  bFail: false,
  read: "",
  releaseA: () => {},
  failA: () => {},
  passB: () => {},
};
Object.assign(window, { __c511: hooks });
const check = (patch: Partial<MachineCheckJob>): MachineCheckJob => ({
  id: "chk-a",
  project_id: "p-1",
  machine_id: "local",
  kind: "machine",
  status: "running",
  step: "queued",
  started_at: NOW,
  checked_at: NOW,
  failed_steps: [],
  ...patch,
});
/** 本机 with this project's latest explicit check replaced. */
const onLocal = (
  id: string,
  status: "running" | "passed" | "failed",
  step: string,
  failed_steps: string[] = [],
): MachineView => ({
  ...local,
  bindings: local.bindings.map((b) =>
    b.project_id === "p-1"
      ? {
          ...b,
          last_requested_check: {
            id,
            kind: "machine",
            status,
            step,
            checked_at: NOW,
            failed_steps,
          },
        }
      : b,
  ),
});
const withB = onLocal("chk-b", "running", "ssh");
const capacity: ExecutionCapacity = {
  agents: [
    {
      machine_id: "local",
      label: "本机",
      running: 2,
      total_running: 3,
      limit: 6,
      max_limit: 16,
      queued: 1,
      merge_check_slots: 0,
    },
  ],
  merge_checks: [],
  merge_config_invalid: false,
};
const client = fakeClient({
  ...settingsPanels,
  executionCapacity: async () => capacity,
  machines: async () => ({ machines: [...machines.values()] }),
  machine: async (_p: string, id: string) => {
    if (scene === "stale" && id === "local") {
      if (hooks.fail)
        throw new ApiError(500, "internal", "synthetic server error");
      if (hooks.b) return { machine: withB };
    }
    if (scene === "r4" && id === "local" && hooks.aDone)
      return { machine: onLocal("chk-a", "passed", "finished") };
    if (scene === "p1" && id === "local" && hooks.b)
      return { machine: onLocal("chk-b", "running", "mcp") };
    if (scene === "p1c" && id === "local" && hooks.read)
      return {
        machine:
          hooks.read === "a"
            ? onLocal("chk-a", "running", "ssh")
            : hooks.read === "b"
              ? onLocal("chk-b", "running", "mcp")
              : hooks.bFail
                ? onLocal("chk-b", "failed", "finished", ["mcp"])
                : onLocal("chk-b", "passed", "finished"),
      };
    return {
      machine:
        id === "local" && sent && scene === "running"
          ? running
          : (machines.get(id) as MachineView),
    };
  },
  setRunLimit: async () => {},
  checkMachine: async () => {
    sent = true;
    if (scene === "p1") return { check: check({}) };
    if (scene === "stale" || scene === "r4" || scene === "p1c")
      return new Promise<{ check: MachineCheckJob }>((resolve) => {
        hooks.releaseA = () => resolve({ check: check({}) });
      });
    throw new TypeError("synthetic lost reply");
  },
  machineCheck: (_p: string, _m: string, id: string) =>
    scene === "p1c"
      ? new Promise<{ check: MachineCheckJob }>((resolve) => {
          if (id === "chk-a")
            hooks.failA = () =>
              resolve({
                check: check({
                  status: "failed",
                  step: "finished",
                  failed_steps: ["ssh"],
                }),
              });
          else
            hooks.passB = () =>
              resolve({
                check: check({
                  id: "chk-b",
                  status: hooks.bFail ? "failed" : "passed",
                  step: "finished",
                  failed_steps: hooks.bFail ? ["mcp"] : [],
                }),
              });
        })
      : id !== "chk-a"
        ? new Promise(() => {})
        : scene === "stale"
          ? Promise.resolve({
              check: check({ status: "passed", step: "finished" }),
            })
          : scene === "r4"
            ? Promise.reject(
                new ApiError(503, "unavailable", "synthetic progress failure"),
              )
            : scene === "p1"
              ? Promise.resolve({
                  check: check({
                    status: "failed",
                    step: "finished",
                    failed_steps: ["ssh"],
                  }),
                })
              : new Promise(() => {}),
  setMachineDrain: async () => {
    sent = true;
    throw new TypeError("synthetic lost reply");
  },
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing screenshot fixture root");
createRoot(root).render(<App client={client} />);
