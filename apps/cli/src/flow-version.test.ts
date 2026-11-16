import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCommandState } from "@cardigan/mcp-server";
import { Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test } from "vitest";
import { main } from "./index.js";
import type { CliIo } from "./io.js";
import { registerTemplateRoles } from "./template-fixtures.js";

const project = "flow-fixture";
let dir: string, store: Store, io: CliIo, output: string[], errors: string[];
const run = (args: string[]) => {
  output = [];
  errors = [];
  return main(args, io);
};
const snapshot = () => store.uow.read((tx) => loadCommandState(tx, project));

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "cardigan-flow-"));
  store = Store.open({ dataDir: dir });
  store.createProject({ id: project });
  registerTemplateRoles(store, project);
  io = {
    env: { CARDIGAN_DATA_DIR: dir },
    cwd: dir,
    platform: "linux",
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
    signals: { on: () => undefined, off: () => undefined },
    spawnInherit: () => {
      throw new Error("No Agent needed");
    },
    captureCommand: async () => {
      throw new Error("No Git needed");
    },
  };
  for (let i = 0; i < 2; i++)
    expect(
      await run([
        "card",
        "create",
        "--title",
        "Flow",
        "--goal",
        "Fix version",
        "--acceptance",
        "Fixed",
        "--repo",
        "example/repo",
      ]),
    ).toBe(0);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("new cards use version 1 and human preference get/set preserves historical cards", async () => {
  expect(snapshot().cards.map((c) => c.flow_version)).toEqual([1, 1]);
  expect(await run(["preference", "get", "flow-version"])).toBe(0);
  expect(output.join("\n")).toContain("flow-version: 1");
  const before = snapshot();
  expect(await run(["preference", "set", "flow-version", "1"])).toBe(0);
  expect(snapshot()).toEqual(before);
  expect(await run(["card", "flow-upgrade", "C-1", "C-2", "--to=1"])).toBe(0);
  expect(output).toEqual(["卡片 C-1 流程版本：1", "卡片 C-2 流程版本：1"]);
  expect(snapshot()).toEqual(before);
});

test.each(["0", "6", "7", "1.5", "-1", "NaN", "Infinity", "1e0", "off", ""])(
  "rejects invalid or unreleased CLI flow %s without writing",
  async (version) => {
    const before = snapshot();
    expect(await run(["preference", "set", "flow-version", version])).toBe(2);
    expect(await run(["card", "flow-upgrade", "C-1", "--to", version])).toBe(2);
    expect(snapshot()).toEqual(before);
  },
);

test.each([
  ["C-1"],
  ["--to", "1"],
  ["bad", "--to", "1"],
  ["C-1", "C-1", "--to", "1"],
  ["C-1", "--to", "1", "--to", "1"],
  ["C-1", "--to", "1", "--unknown", "1"],
  ["C-1", "--to"],
])("flow-upgrade validates card IDs and flags: %s", async (...args) => {
  const before = snapshot();
  expect(await run(["card", "flow-upgrade", ...args])).toBe(2);
  expect(snapshot()).toEqual(before);
});

test("batch upgrade rolls back all changes on an unsafe card then writes one audit per changed card", async () => {
  // Downgrades remain restricted to cards that have not started work.
  store.uow.run((tx) => {
    for (const c of tx.cards.list(project))
      tx.cards.put(project, {
        ...c,
        flow_version: 2,
        status: c.id === "C-1" ? "todo" : "awaiting_merge",
      });
  });
  const before = snapshot();
  expect(await run(["card", "flow-upgrade", "C-1", "C-2", "--to", "1"])).toBe(
    2,
  );
  expect(errors.join("\n")).toContain("待合并");
  expect(snapshot()).toEqual(before);
  store.uow.run((tx) => {
    const c = tx.cards.list(project).find((c) => c.id === "C-2");
    if (!c) throw new Error("Missing card");
    tx.cards.put(project, { ...c, status: "todo" });
  });
  expect(
    await run([
      "card",
      "flow-upgrade",
      "C-1",
      "C-2",
      "--to",
      "1",
      "--project",
      project,
    ]),
  ).toBe(0);
  expect(snapshot().cards.map((c) => c.flow_version)).toEqual([1, 1]);
  expect(
    snapshot().events.filter((e) => e.type === "card_flow_upgraded"),
  ).toHaveLength(2);
  const after = snapshot();
  expect(await run(["card", "flow-upgrade", "C-1", "C-2", "--to", "1"])).toBe(
    0,
  );
  expect(snapshot()).toEqual(after);
});

test("ordinary create/update flags cannot override flow; help advertises the human command", async () => {
  const before = snapshot();
  expect(await run(["card", "update", "C-1", "--flow-version", "1"])).toBe(2);
  expect(snapshot()).toEqual(before);
  expect(await run(["card", "flow-upgrade", "--help"])).toBe(0);
  expect(output.join("\n")).toContain("flow-upgrade");
});

test("human selects version 2 for new cards and explicitly upgrades an old card", async () => {
  expect(await run(["preference", "set", "flow-version", "2"])).toBe(0);
  expect(snapshot().cards.map((c) => c.flow_version)).toEqual([1, 1]);
  expect(
    await run([
      "card",
      "create",
      "--title",
      "Version 2",
      "--goal",
      "Fixed version",
      "--acceptance",
      "Fixed",
      "--repo",
      "example/repo",
    ]),
  ).toBe(0);
  expect(snapshot().cards.map((c) => c.flow_version)).toEqual([1, 1, 2]);
  expect(await run(["card", "flow-upgrade", "C-1", "--to", "2"])).toBe(0);
  expect(snapshot().cards.map((c) => c.flow_version)).toEqual([2, 1, 2]);
  expect(await run(["preference", "set", "flow-version", "1"])).toBe(0);
  expect(snapshot().cards.map((c) => c.flow_version)).toEqual([2, 1, 2]);
});

test.each([4, 5])(
  "CLI flow %i requires explicit release paths and preserves the store on rejection",
  async (version) => {
    for (const policy of [
      undefined,
      null,
      {},
      { role_rule_paths: ["AGENTS.md"] },
    ]) {
      store.uow.run((tx) => {
        const existing = tx.project_preferences.get(project, project);
        const { system_merge_shadow_policy: _policy, ...base } = existing ?? {
          id: project,
          auto_merge_after_minutes: null,
        };
        const legacy = JSON.parse(
          JSON.stringify({
            ...base,
            flow_version: 1,
            ...(policy === undefined
              ? {}
              : { system_merge_shadow_policy: policy }),
          }),
        );
        tx.project_preferences.put(project, legacy);
      });
      const before = snapshot();
      expect(
        await run(["preference", "set", "flow-version", String(version)]),
      ).not.toBe(0);
      expect(errors.join("\n")).toContain(
        "启用系统合并前须由人显式设置发布路径",
      );
      expect(snapshot()).toEqual(before);
    }
    expect(
      await run([
        "preference",
        "set",
        "system-merge-shadow-policy",
        '{"role_rule_paths":[],"release_paths":[]}',
      ]),
    ).toBe(0);
    expect(
      await run(["preference", "set", "flow-version", String(version)]),
    ).toBe(0);
    expect(snapshot().project_preferences?.[0]?.flow_version).toBe(version);
  },
);
