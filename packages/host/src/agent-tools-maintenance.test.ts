import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActionCommand, Machine } from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { afterEach, expect, test, vi } from "vitest";
import {
  agentToolsStale,
  requestAgentToolsMigration,
} from "./agent-tools-maintenance.js";
import { refreshMachineObservations } from "./machine-capabilities.js";

const roots: string[] = [];
const temp = () => {
  const root = mkdtempSync(join(tmpdir(), "agent-tools-maintenance-"));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const machine = "worker-a";
const remote = (root: string) =>
  ({
    mode: "agent-ssh",
    dataDir: root,
    agentRoot: join(root, "work"),
    gid: 900,
    machine,
    user: "cg_fixture",
    identityFile: "/fixture/key",
    knownHostsFile: "/fixture/known_hosts",
    target: {
      project_id: "a",
      machine_id: machine,
      session: "s",
      generation: "g",
      fingerprint: "f".repeat(64),
    },
  }) as const;
const terminal: ActionCommand = {
  target: machine,
  login: "fixture",
  command: "fixture",
  expected_output: "fixture",
  on_failure: "fixture",
};

test("only a definite missing, stale or unrunnable result counts as stale", async () => {
  const root = temp();
  const stale = (output: string, ok = true) =>
    agentToolsStale(remote(root), machine, "linux", undefined, async () => ({
      ok,
      output,
    }));
  expect(await stale("agent-tools ok\n")).toBe(false);
  expect(await stale("agent-tools missing:download-attachment.mjs\n")).toBe(
    true,
  );
  expect(await stale("agent-tools mismatch:upload-evidence.mjs\n")).toBe(true);
  expect(await stale("", false)).toBe(false);
  expect(await stale("private worker output")).toBe(false);
});

test("the migration notice carries the staged, digest-checked command; staging failure has none", async () => {
  const root = temp();
  const store = Store.open({ dataDir: root });
  try {
    store.createProject({ id: "a" });
    const stage = vi.fn(async () => terminal);
    await requestAgentToolsMigration(
      store,
      "a",
      machine,
      remote(root),
      "linux",
      "fixture reason",
      undefined,
      stage,
    );
    expect(stage).toHaveBeenCalledOnce();
    const [action] = store.uow.read((tx) => tx.human_actions.list("a"));
    expect(action).toMatchObject({ status: "open", terminal });
    expect(action?.instructions).toContain("fixture reason");
    expect(action?.instructions).toContain("迁移到 v2");
    expect(action).not.toHaveProperty("helper_upgrade");
    // The same release is one open notice per machine.
    await requestAgentToolsMigration(
      store,
      "a",
      machine,
      remote(root),
      "linux",
      "fixture reason",
      undefined,
      async () => {
        throw new Error("private ssh detail");
      },
    );
    const actions = store.uow.read((tx) => tx.human_actions.list("a"));
    expect(actions).toHaveLength(1);
    expect(JSON.stringify(actions)).not.toContain("private ssh detail");
  } finally {
    store.close();
  }
});

test("machine check stages the tools install for a manually maintained worker", async () => {
  const root = temp();
  const store = Store.open({ dataDir: root });
  try {
    store.createProject({ id: "a" });
    const registered: Machine = {
      id: machine,
      herdr_machine: machine,
      label: "fixture",
      os: "linux",
      arch: "x64",
      tags: [],
      max_assignments: 1,
      status: "online",
      last_seen: new Date().toISOString(),
    };
    store.uow.run((tx) => tx.machines.put("a", registered));
    const stageUpgrade = vi.fn(async () => terminal);
    const observe = (output: string) =>
      refreshMachineObservations({
        store,
        project: "a",
        machine,
        env: { CARDIGAN_CONFIG_DIR: root },
        stageUpgrade,
        target: () => ({ machine: registered, execution: remote(root) }),
        check: async () => ({ blockers: [], launch_enabled: true }),
        probe: async (_execution, _os, command) =>
          Array.isArray(command) && command[1] === "-e"
            ? { ok: true, output }
            : { ok: false, output: "" },
      });
    await observe("agent-tools ok\n");
    expect(stageUpgrade).not.toHaveBeenCalled();
    await observe("agent-tools missing:upload-evidence.mjs\n");
    expect(stageUpgrade).toHaveBeenCalledOnce();
    expect(store.uow.read((tx) => tx.human_actions.list("a"))).toEqual([
      expect.objectContaining({
        status: "open",
        terminal,
        instructions: expect.stringContaining(
          "附件助手 upload-evidence.mjs 缺失",
        ),
      }),
    ]);
  } finally {
    store.close();
  }
});
