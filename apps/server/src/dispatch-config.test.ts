import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRunCapacityConfig } from "@cardigan/host";
import { afterEach, beforeEach, expect, test } from "vitest";

let configDir: string;
beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "run-capacity-"));
});
afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});
const write = (text: string) =>
  writeFile(join(configDir, "run-capacity.yaml"), text, { mode: 0o600 });

test("missing file/machine defaults to four; CARDIGAN_CONFIG_DIR is read once per load", async () => {
  expect((await loadRunCapacityConfig({ configDir })).forMachine("local")).toBe(
    4,
  );
  await write("machines:\n  local: 2\n  worker: 6\n");
  const config = await loadRunCapacityConfig({
    env: { CARDIGAN_CONFIG_DIR: configDir },
  });
  expect(config.errors).toEqual([]);
  expect(config.forMachine("local")).toBe(2);
  expect(config.forMachine("worker")).toBe(6);
  expect(config.forMachine("omitted")).toBe(4);
  await write("machines: { local: 5 }\n");
  expect(config.forMachine("local")).toBe(2);
  expect((await loadRunCapacityConfig({ configDir })).forMachine("local")).toBe(
    5,
  );
});

test.each([
  ...[
    "null",
    "[]",
    "1",
    "{godot: null}",
    "{godot: 0}",
    "{godot: -1}",
    "{godot: 1.5}",
    "{godot: '1'}",
    "{godot: 9007199254740992}",
    "{'godot>=4': 1}",
    "{'': 1}",
    "{godot: 1, godot: 2}",
  ].map((resources) => `machines: { local: { resources: ${resources} } }`),
  "machines: { local: 17 }",
  "machines: { local: { limit: 5, max_limit: 4 } }",
  "machines: { local: { max_limit: 0 } }",
  "machines: { local: { max_limit: 1.5 } }",
  "machines: { local: { max_limit: '32' } }",
  "machines: { local: { limit: null } }",
  "machines: { local: { max_limit: null } }",
  "machines: { local: { display_name: '' } }",
  "machines: { local: { display_name: 123 } }",
  'machines: { local: { display_name: "private-value\\nlabel" } }',
  "machines: { local: { extra: private-value } }",
  "machines: { local: 0 }",
  "machines: { local: -1 }",
  "machines: { local: 1.5 }",
  "machines: { local: '4' }",
  "machines: { local: 2, local: 3 }",
  "machines: []",
  "machines: &limits { local: 2 }\nextra: *limits",
  "machines: { local: 2 }\nsecret: private-value",
])(
  "invalid configuration fails closed without echoing input: %s",
  async (source) => {
    await write(source);
    const config = await loadRunCapacityConfig({ configDir });
    expect(config.forMachine("local")).toBe(0);
    expect(config.forMachine("omitted")).toBe(0);
    expect(config.maxForMachine("local")).toBe(0);
    expect(config.displayNameForMachine("local")).toBeUndefined();
    expect(config.errors).toHaveLength(1);
    expect(config.errors.join()).not.toContain("private-value");
  },
);

test("per-machine ceilings and names coexist with legacy defaults and load once", async () => {
  const absent = await loadRunCapacityConfig({ configDir });
  expect(absent.maxForMachine("local")).toBe(16);
  expect(absent.displayNameForMachine("local")).toBeUndefined();
  await write(`machines:
  local: { limit: 24, max_limit: 24, display_name: " Workstation " }
  worker: { limit: 2, max_limit: 8, resources: { android.emulator: 1, custom-tool: 2 } }
  named: { display_name: "Worker" }
  legacy: 16
`);
  const config = await loadRunCapacityConfig({ configDir });
  expect(config.errors).toEqual([]);
  expect(config.forMachine("local")).toBe(24);
  expect(config.maxForMachine("local")).toBe(24);
  expect(config.displayNameForMachine("local")).toBe("Workstation");
  expect(config.maxForMachine("worker")).toBe(8);
  expect([...config.resourcesForMachine("worker")]).toEqual([
    ["android.emulator", 1],
    ["custom-tool", 2],
  ]);
  expect(config.resourcesForMachine("legacy").size).toBe(0);
  expect(config.resourcesForMachine("omitted").size).toBe(0);
  expect(config.forMachine("named")).toBe(4);
  expect(config.maxForMachine("legacy")).toBe(16);
  expect(config.maxForMachine("omitted")).toBe(16);
  await write("machines: {}\n");
  expect(config.maxForMachine("local")).toBe(24);
  expect(
    (await loadRunCapacityConfig({ configDir })).maxForMachine("local"),
  ).toBe(16);
});

test.each(["writable", "symlink", "directory", "parent"])(
  "refuses unsafe %s configuration",
  async (kind) => {
    const file = join(configDir, "run-capacity.yaml");
    if (kind === "directory") await mkdir(file);
    else if (kind === "symlink") {
      await writeFile(join(configDir, "source"), "machines: {}\n");
      await symlink(join(configDir, "source"), file);
    } else {
      await write("machines: {}\n");
      await chmod(
        kind === "parent" ? configDir : file,
        kind === "parent" ? 0o770 : 0o666,
      );
    }
    expect((await loadRunCapacityConfig({ configDir })).errors).toHaveLength(1);
  },
);

test("Q-88 loads a configurable cancellation grace once, defaulting to 60 minutes", async () => {
  expect(
    (await loadRunCapacityConfig({ configDir })).inactiveCancelAfterMs,
  ).toBe(60 * 60_000);
  await write("machines: { local: 4 }\ninactive_cancel_after_minutes: 45\n");
  const config = await loadRunCapacityConfig({ configDir });
  expect(config.errors).toEqual([]);
  expect(config.inactiveCancelAfterMs).toBe(45 * 60_000);
  await write("machines: { local: 4 }\ninactive_cancel_after_minutes: 60\n");
  expect(config.inactiveCancelAfterMs).toBe(45 * 60_000);
  expect(
    (await loadRunCapacityConfig({ configDir })).inactiveCancelAfterMs,
  ).toBe(60 * 60_000);
});

test("C-475: inbox escalation has a separate read-on-start threshold", async () => {
  expect((await loadRunCapacityConfig({ configDir })).inboxStallAfterMs).toBe(
    120 * 60_000,
  );
  await write("machines: {}\ninbox_stall_after_minutes: 30\n");
  expect(await loadRunCapacityConfig({ configDir })).toMatchObject({
    errors: [],
    inboxStallAfterMs: 30 * 60_000,
    inactiveCancelAfterMs: 60 * 60_000,
  });
  await write("machines: {}\ninbox_stall_after_minutes: -1\n");
  expect((await loadRunCapacityConfig({ configDir })).errors).toHaveLength(1);
});

test.each(["0", "-1", "1.5", "'30'", "null", "35792"])(
  "invalid inactivity grace %s disables destructive recovery",
  async (value) => {
    await write(
      `machines: { local: 4 }\ninactive_cancel_after_minutes: ${value}\n`,
    );
    const config = await loadRunCapacityConfig({ configDir });
    expect(config.errors).toHaveLength(1);
    expect(config.inactiveCancelAfterMs).toBeNull();
  },
);

test("project quotas only narrow configured machine and resource ceilings", async () => {
  await write(`machines:
  worker:
    resources: { renderer: 2 }
    projects: { example: { limit: 0, resources: { renderer: 1 } } }
`);
  const cfg = await loadRunCapacityConfig({ configDir });
  expect(cfg.errors).toEqual([]);
  expect(cfg.projectQuota("worker", "example")).toEqual({
    limit: 0,
    resources: new Map([["renderer", 1]]),
  });
  expect(cfg.projectQuota("other", "example")).toBeUndefined();
  expect(cfg.projectQuota("worker", "other")).toBeUndefined();
});

test.each([
  "{ limit: -1 }",
  "{ limit: '2' }",
  "{ limit: 17 }",
  "{ resources: { renderer: 2 } }",
  "{ resources: { unknown: 1 } }",
  "{ typo: private-value }",
])("invalid project quota fails closed: %s", async (quota) => {
  await write(
    `machines: { worker: { resources: { renderer: 1 }, projects: { sample: ${quota} } } }`,
  );
  const cfg = await loadRunCapacityConfig({ configDir });
  expect(cfg.forMachine("worker")).toBe(0);
  expect(cfg.errors).toHaveLength(1);
  expect(cfg.errors.join()).not.toContain("private-value");
});

test("C-527: queued re-evaluation defaults to five minutes and accepts a positive whole-minute override", async () => {
  expect(
    (await loadRunCapacityConfig({ configDir })).queuedRecheckAfterMs,
  ).toBe(300_000);
  await write("machines: {}\nqueued_recheck_after_minutes: 2\n");
  expect(await loadRunCapacityConfig({ configDir })).toMatchObject({
    errors: [],
    queuedRecheckAfterMs: 120_000,
  });
  await write("machines: {}\nqueued_recheck_after_minutes: 0\n");
  expect((await loadRunCapacityConfig({ configDir })).errors).toHaveLength(1);
});
