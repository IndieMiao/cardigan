import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type EventId,
  type ProjectId,
  queueRun,
  type Runtime,
  recordDecision,
  requestDecision,
  resolveDelegatedDecision,
} from "@cardigan/domain";
import { authenticate, loadCommandState } from "@cardigan/mcp-server";
import { defaultRoleDefinition } from "@cardigan/roles";
import { HerdrRuntime } from "@cardigan/runtime-herdr";
import {
  getRoleVersion,
  listRoleVersions,
  Store,
  tokensForAssignment,
} from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { stopAssignment } from "./assignment.js";
import { humanActor, runCommand } from "./host.js";
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
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

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
  const lastSeq = () =>
    withStore(
      (s) =>
        s.uow.read((tx) => tx.events.listAfter(project, undefined, 0)).at(-1)
          ?.seq ?? 0,
    );
  const seqBefore = lastSeq();
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
  // The dry run consumed no event sequence: the real write is the next one.
  expect(lastSeq()).toBe(seqBefore + 1);
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

test("pm rotate hands a failed delivery pinned to an old Run to the new PM", async () => {
  await bootstrap();
  expect(await run(["pm", "create", "--ops"])).toBe(0);
  expect(await run(["role", "upgrade", "pm", "--from-default"])).toBe(0);
  withStore((s) => {
    const queued = runCommand(s, {
      project_id: project,
      actor: humanActor(project),
      reduce: (state, actor, ports) =>
        queueRun(
          state,
          actor,
          {
            assignment_id: "A-1" as never,
            model: "fixture",
            agent_cli_version: "fixture",
          },
          ports,
        ),
    });
    const note = s.recordNotification({
      project_id: project,
      event_id: lastEvent(s),
      recipient: { kind: "pm_ops" },
      seq: 1,
      kind: "decision",
    }).notification;
    s.moveNotification({
      project_id: project,
      id: note.id,
      event: "bell",
      patch: { run_id: queued.id, attempts: 1 },
    });
    s.moveNotification({
      project_id: project,
      id: note.id,
      event: "deliver_failed",
    });
  });

  expect(await run(["pm", "rotate", "--ops"])).toBe(0);
  expect(printed()).toContain("取消未结束的 Run");
  withStore((s) => {
    const rows = s.listNotifications({ project_id: project });
    // Same seq, random ids: compare without relying on row order.
    expect(rows.map((n) => [n.status, n.recipient])).toEqual(
      expect.arrayContaining([
        ["acked", { kind: "pm_ops" }],
        ["pending", { kind: "assignment", assignment_id: "A-2" }],
      ]),
    );
    expect(rows).toHaveLength(2);
  });
});

test("pm rotate refuses a new version that cannot serve PM items, changing nothing", async () => {
  await bootstrap();
  expect(await run(["role", "upgrade", "pm", "--from-default"])).toBe(0);
  expect(await run(["pm", "create", "--ops"])).toBe(0);
  // A later version drops the triage tool while an item waits for PM Ops.
  const file = join(root, "pm-v3.yaml");
  writeFileSync(
    file,
    OLD_PM.replace(
      "assign, record_decision",
      "assign, record_decision, resolve_delegated_decision",
    ),
  );
  expect(await run(["role", "update", "--file", file])).toBe(0);
  withStore((s) =>
    s.uow.run((tx) =>
      tx.human_actions.put(project, {
        id: "h(1)",
        key: "h(1)",
        requested_by: "human",
        instructions: "登录",
        why_human: "需要人",
        expected_return: "完成",
        blocked_work_items: [],
        status: "open",
        triage: "pm_ops",
      } as never),
    ),
  );
  expect(await run(["pm", "rotate", "--ops"])).toBe(2);
  expect(failed()).toContain("缺少 triage_human_action");
  withStore((s) => {
    const [assignments, action] = s.uow.read((tx) => [
      tx.assignments.list(project),
      tx.human_actions.get(project, "h(1)" as never),
    ]);
    expect(assignments.map((a) => [a.id, a.status])).toEqual([
      ["A-1", "active"],
    ]);
    expect(action?.triage).toBe("pm_ops");
    expect(
      tokensForAssignment(s.database, project, "A-1" as never).some(
        (t) => t.revoked_at === null,
      ),
    ).toBe(true);
  });
});

test("external Office rotation issues the same scoped token, moves inbox, and refuses terminal commands", async () => {
  await bootstrap();
  expect(await run(["pm", "create", "--office"])).toBe(0);
  const tokenText = () => {
    const lines = printed().split("\n");
    return lines[lines.findIndex((line) => line.startsWith("token_id：")) + 2];
  };
  const oldToken = tokenText();
  const oldIdentity = withStore((s) => authenticate(s, oldToken));
  const oldTools = withStore(
    (s) =>
      tokensForAssignment(s.database, project, "A-1" as never).at(-1)
        ?.allowed_tools,
  );
  expect(
    await run([
      "employee",
      "add",
      "--name",
      "Office Agent",
      "--title",
      "PM",
      "--role",
      "pm",
    ]),
  ).toBe(0);
  withStore((s) =>
    s.recordNotification({
      project_id: project,
      event_id: lastEvent(s),
      recipient: { kind: "assignment", assignment_id: "A-1" as never },
      seq: 1,
      kind: "decision",
    }),
  );
  expect(
    await run([
      "pm",
      "rotate",
      "--office",
      "--external",
      "--employee",
      "Office Agent",
    ]),
  ).toBe(0);
  const newToken = tokenText();
  expect(newToken).toBeTruthy();
  expect(printed()).toContain("外接身份");
  expect(printed()).not.toContain("assignment start");
  withStore((s) => {
    const identity = authenticate(s, newToken);
    expect(identity.ok).toBe(true);
    expect(oldIdentity.ok).toBe(true);
    if (!identity.ok || !oldIdentity.ok) throw new Error("Invalid identity");
    expect(identity.value.actor.allowed_tools).toEqual(
      oldIdentity.value.actor.allowed_tools,
    );
    expect(identity.value.actor.kind).toBe("assignment");
    expect(authenticate(s, oldToken).ok).toBe(false);
    for (const category of [
      "spending",
      "account",
      "permission",
      "data_deletion",
    ] as const) {
      const q = runCommand(s, {
        project_id: project,
        actor: humanActor(project),
        reduce: (state, actor, ports) =>
          requestDecision(
            state,
            actor,
            {
              category,
              kind: "choose",
              question: "是否继续",
              context: "高风险确认",
              options: [{ key: "yes", description: "继续", impact: "执行" }],
              recommended: "yes",
              decider: "human",
              blocking: false,
              affected_cards: [],
              affected_work_items: [],
            },
            ports,
          ),
      });
      s.uow.run((tx) => {
        const state = loadCommandState(tx, project);
        const answer = {
          decision_id: q.id,
          option: "yes",
          rationale: "转录",
          raw_quote: "同意",
        };
        const ports = {
          clock: { now: () => "2030-01-01T00:00:00.000Z" },
          ids: tx.ids,
        };
        expect(
          recordDecision(state, identity.value.actor, answer, ports).ok,
        ).toBe(false);
        expect(
          resolveDelegatedDecision(state, identity.value.actor, answer, ports)
            .ok,
        ).toBe(false);
      });
    }
    const next = s.uow.read((tx) =>
      tx.assignments.get(project, "A-2" as never),
    );
    expect(next).toMatchObject({
      external: true,
      employee_id: "E-1",
      standing_mode: "office",
      role_version: 1,
    });
    const token = tokensForAssignment(s.database, project, "A-2" as never).at(
      -1,
    );
    expect(token?.allowed_tools).toEqual(oldTools);
    expect(token?.allowed_tools).not.toContain("resolve_delegated_decision");
    expect(token?.allowed_tools).toContain("record_decision");
    expect(
      tokensForAssignment(s.database, project, "A-1" as never).every(
        (t) => t.revoked_at !== null,
      ),
    ).toBe(true);
    expect(s.listNotifications({ project_id: project })[0]).toMatchObject({
      recipient: { kind: "assignment", assignment_id: "A-2" },
      status: "pending",
    });
  });
  for (const args of [
    ["assignment", "start", "A-2"],
    ["pm", "create", "--office"],
    ["pm", "start", "--office"],
  ]) {
    expect(await run(args)).toBe(2);
    expect(failed()).toContain("这是外接 Assignment，没有可以启动的终端");
    expect(failed()).toContain("cardigan inbox");
  }
  withStore((s) => {
    expect(s.uow.read((tx) => tx.runs.list(project))).toEqual([]);
    expect(
      tokensForAssignment(s.database, project, "A-2" as never),
    ).toHaveLength(1);
  });
  expect(
    await run(["pm", "rotate", "--office", "--external", "--employee", "E-1"]),
  ).toBe(0);
  expect(printed()).toContain("没有改动");
  withStore((s) =>
    s.uow.run((tx) => {
      const a = tx.assignments.get(project, "A-2" as never);
      if (!a) throw new Error("Missing Office");
      tx.assignments.put(project, { ...a, status: "suspended" });
    }),
  );
  expect(await run(["pm", "create", "--office"])).toBe(2);
  expect(failed()).toContain("这是外接 Assignment");
});

test("external rotation rolls back new tokens, identity and inbox on a late failure", async () => {
  await bootstrap();
  expect(await run(["pm", "create", "--office"])).toBe(0);
  withStore((s) => {
    const before = s.uow.read((tx) => tx.assignments.list(project));
    const tokens = tokensForAssignment(s.database, project, "A-1" as never);
    expect(() =>
      rotateStandingPmInStore(s, project, "office", {
        external: true,
        beforeCommit: () => {
          throw new Error("rollback");
        },
      }),
    ).toThrow("rollback");
    expect(s.uow.read((tx) => tx.assignments.list(project))).toEqual(before);
    expect(tokensForAssignment(s.database, project, "A-1" as never)).toEqual(
      tokens,
    );
    expect(tokensForAssignment(s.database, project, "A-2" as never)).toEqual(
      [],
    );
  });
});

test.each(["cli", "reusable"])(
  "external Office stop through %s preserves identity and token",
  async (entry) => {
    await bootstrap();
    expect(await run(["pm", "create", "--office"])).toBe(0);
    expect(await run(["pm", "rotate", "--office", "--external"])).toBe(0);
    const lines = printed().split("\n");
    const token =
      lines[lines.findIndex((line) => line.startsWith("token_id：")) + 2];
    const connect = vi
      .spyOn(HerdrRuntime, "create")
      .mockImplementation(async () => {
        throw new Error("must not connect");
      });
    const release = vi.fn(async () => {
      throw new Error("must not release");
    });
    const store = Store.open({ dataDir: join(root, "data") });
    try {
      const snapshot = () => ({
        state: store.uow.read((tx) => loadCommandState(tx, project)),
        tokens: tokensForAssignment(store.database, project, "A-2" as never),
      });
      const before = snapshot();
      expect(authenticate(store, token).ok).toBe(true);
      if (entry === "cli") {
        expect(await run(["assignment", "stop", "A-2"])).toBe(2);
        expect(failed()).toContain("没有可以停止的终端");
        expect(failed()).toContain("cardigan inbox");
      } else {
        await expect(
          stopAssignment({
            store,
            project_id: project,
            assignment_id: "A-2" as never,
            runtime: { release } as unknown as Runtime,
          }),
        ).rejects.toThrow("没有可以停止的终端");
      }
      expect(snapshot()).toEqual(before);
      expect(authenticate(store, token).ok).toBe(true);
      expect(connect).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  },
);

test("batch pm start skips external Office and continues to ordinary Ops", async () => {
  await bootstrap();
  expect(await run(["pm", "create", "--office"])).toBe(0);
  expect(await run(["pm", "rotate", "--office", "--external"])).toBe(0);
  const calls: string[] = [];
  const hooks = {
    start: async (options: { assignment_id: string }) => {
      calls.push(options.assignment_id);
      return 0;
    },
  };
  // An external-only project has no managed terminal to start.
  expect(await main(["pm", "start"], io, hooks)).toBe(0);
  expect(calls).toEqual([]);
  expect(printed()).toContain("cardigan inbox");
  expect(await run(["pm", "create", "--ops"])).toBe(0);
  for (const flags of [[], ["--office", "--ops"], ["--ops"]]) {
    calls.length = 0;
    output = [];
    expect(await main(["pm", "start", ...flags], io, hooks)).toBe(0);
    expect(calls).toEqual(["A-3"]);
    expect(printed()).toContain("已启动 1 个常驻 PM");
    if (!flags.includes("--ops") || flags.includes("--office"))
      expect(printed()).toContain("外接身份，跳过终端启动");
  }
  calls.length = 0;
  expect(await main(["pm", "start", "--office"], io, hooks)).toBe(2);
  expect(calls).toEqual([]);
  expect(failed()).toContain("没有可以启动的终端");
});
