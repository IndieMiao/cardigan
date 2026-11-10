import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventId, ProjectId } from "@cardigan/domain";
import { defaultRoleDefinition } from "@cardigan/roles";
import {
  getRoleVersion,
  listRoleVersions,
  Store,
  tokensForAssignment,
} from "@cardigan/store";
import { afterEach, beforeEach, expect, test } from "vitest";
import { main } from "./index.js";
import type { CliIo } from "./io.js";
import { rotateStandingPmInStore } from "./pm-rotate.js";

const project = "p-rotate" as ProjectId;
let root: string;
let output: string[];
let errors: string[];
let io: CliIo;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cardigan-pm-rotate-"));
  output = [];
  errors = [];
  io = {
    env: { CARDIGAN_DATA_DIR: join(root, "data") },
    cwd: root,
    platform: "linux",
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
    signals: { on: () => undefined, off: () => undefined },
    spawnInherit: () => {
      throw new Error("must not spawn");
    },
    captureCommand: async () => ({ code: 1, stdout: "", stderr: "" }),
  };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function run(argv: string[]): Promise<number> {
  output = [];
  errors = [];
  return main(argv, io);
}
const printed = () => output.join("\n");
const lastEvent = (s: Store): EventId => {
  const event = s.uow
    .read((tx) => tx.events.listAfter(project, undefined, 0))
    .at(-1);
  if (!event) throw new Error("no project event");
  return event.id;
};
const failed = () => errors.join("\n");
function withStore<T>(work: (store: Store) => T): T {
  const store = Store.open({ dataDir: join(root, "data") });
  try {
    return work(store);
  } finally {
    store.close();
  }
}

/** An old project pm, without the delegation tools, with its own launch fields. */
const OLD_PM = `role_id: pm
display_name: 项目经理
kind: standing
instructions: |
  旧版 PM 说明。
harness: claude-code
launch_profile_ref: claude-pm
allowed_tools: [whoami, get_card, get_updates, ack_events, create_card, assign, record_decision]
capabilities: [verify]
abilities: [规划]
worktree: readonly
required_machine_tags: [gpu]
`;

async function bootstrap(): Promise<void> {
  expect(await run(["init"])).toBe(0);
  expect(await run(["project", "create", project])).toBe(0);
  const file = join(root, "pm.yaml");
  writeFileSync(file, OLD_PM);
  expect(await run(["role", "add", "--file", file])).toBe(0);
}

test("role upgrade --from-default appends the pack policy and keeps project fields", async () => {
  await bootstrap();
  expect(
    await run(["role", "upgrade", "pm", "--from-default", "--dry-run"]),
  ).toBe(0);
  expect(printed()).toContain("新增工具：");
  expect(printed()).toContain("resolve_delegated_decision");
  expect(printed()).toContain("【注意：以下变化会放宽权限】");
  expect(printed()).toContain("--dry-run：只打印变化，没有写入");
  expect(
    withStore((s) => s.uow.read((tx) => getRoleVersion(tx, project, "pm")))
      ?.version,
  ).toBe(1);

  expect(await run(["role", "upgrade", "pm", "--from-default"])).toBe(0);
  expect(printed()).toContain("已按默认角色包升级 pm 到 v2");
  const pack = defaultRoleDefinition("pm", {
    harness: "claude-code",
    launch_profile_ref: "claude-pm",
  });
  const upgraded = withStore((s) =>
    s.uow.read((tx) => getRoleVersion(tx, project, "pm")),
  );
  expect(upgraded).toMatchObject({
    version: 2,
    instructions: pack.instructions,
    allowed_tools: [...pack.allowed_tools],
    capabilities: [...pack.capabilities],
    kind: pack.kind,
    worktree: pack.worktree,
    harness: "claude-code",
    launch_profile_ref: "claude-pm",
    display_name: "项目经理",
    abilities: ["规划"],
    required_machine_tags: ["gpu"],
  });

  expect(await run(["role", "upgrade", "pm", "--from-default"])).toBe(0);
  expect(printed()).toContain("已是默认包内容");
  expect(
    withStore((s) => s.uow.read((tx) => listRoleVersions(tx, project))).filter(
      (r) => r.role_id === "pm",
    ),
  ).toHaveLength(2);
});

test("role upgrade rejects non-default roles and missing --from-default in Chinese", async () => {
  await bootstrap();
  expect(await run(["role", "upgrade", "ops-helper", "--from-default"])).toBe(
    2,
  );
  expect(failed()).toContain("不是默认角色包里的角色");
  expect(await run(["role", "upgrade", "pm"])).toBe(2);
  expect(failed()).toContain("--from-default");
  expect(await run(["role", "upgrade", "coder", "--from-default"])).toBe(2);
  expect(failed()).toContain("还没有角色 coder");
});

test("pm rotate moves Ops to the newest pm version in one transaction", async () => {
  await bootstrap();
  expect(await run(["pm", "create", "--ops"])).toBe(0);
  expect(await run(["pm", "rotate", "--ops"])).toBe(0);
  expect(printed()).toContain("已是最新版本 pm v1");

  expect(await run(["role", "upgrade", "pm", "--from-default"])).toBe(0);
  withStore((s) =>
    s.recordNotification({
      project_id: project,
      event_id: lastEvent(s),
      recipient: { kind: "assignment", assignment_id: "A-1" as never },
      seq: 1,
      kind: "decision",
    }),
  );

  expect(await run(["pm", "rotate", "--ops"])).toBe(0);
  expect(printed()).toContain("已把 PM Ops 从 A-1（pm v1）换到 A-2（pm v2）");
  expect(printed()).toContain("没有事项转回给人");
  expect(printed()).toContain("cardigan assignment start A-2");
  withStore((s) => {
    const [old, next] = s.uow.read((tx) => [
      tx.assignments.get(project, "A-1" as never),
      tx.assignments.get(project, "A-2" as never),
    ]);
    expect(old).toMatchObject({ status: "released" });
    expect(next).toMatchObject({
      status: "active",
      scope: "standing",
      standing_mode: "ops",
      role_version: 2,
    });
    const tokens = tokensForAssignment(s.database, project, "A-1" as never);
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.every((t) => t.revoked_at !== null)).toBe(true);
    const [note] = s.listNotifications({ project_id: project });
    expect(note?.recipient).toEqual({
      kind: "assignment",
      assignment_id: "A-2",
    });
  });

  expect(await run(["pm", "rotate", "--ops"])).toBe(0);
  expect(printed()).toContain("PM Ops（A-2）已是最新版本 pm v2");
});

test("pm rotate rolls back everything when a late step fails", async () => {
  await bootstrap();
  expect(await run(["pm", "create", "--ops"])).toBe(0);
  expect(await run(["role", "upgrade", "pm", "--from-default"])).toBe(0);
  withStore((s) => {
    s.recordNotification({
      project_id: project,
      event_id: lastEvent(s),
      recipient: { kind: "assignment", assignment_id: "A-1" as never },
      seq: 1,
      kind: "decision",
    });
    expect(() =>
      rotateStandingPmInStore(s, project, "ops", {
        beforeCommit: () => {
          throw new Error("boom");
        },
      }),
    ).toThrow("boom");
    const assignments = s.uow.read((tx) => tx.assignments.list(project));
    expect(assignments.map((a) => [a.id, a.status])).toEqual([
      ["A-1", "active"],
    ]);
    expect(
      tokensForAssignment(s.database, project, "A-1" as never).some(
        (t) => t.revoked_at === null,
      ),
    ).toBe(true);
    expect(s.listNotifications({ project_id: project })[0]?.recipient).toEqual({
      kind: "assignment",
      assignment_id: "A-1",
    });
  });
});

test("pm rotate needs exactly one mode and an active standing PM", async () => {
  await bootstrap();
  expect(await run(["pm", "rotate"])).toBe(2);
  expect(failed()).toContain("必须二选一");
  expect(await run(["pm", "rotate", "--office", "--ops"])).toBe(2);
  expect(await run(["pm", "rotate", "--office"])).toBe(2);
  expect(failed()).toContain("没有在岗的 PM Office");
});
