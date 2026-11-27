/**
 * C-826 contract: a never-started Assignment whose Run waits for slots moves
 * to a machine where it can start now; started work, explicit placements and
 * recent migrations stay where they are.
 */
import { expect, test } from "vitest";
import type { Assignment, Event, Machine, Run } from "../entities.js";
import type { MachinePlacement } from "../machine-placement.js";
import { cancelledQueueRelease } from "../prelaunch-release.js";
import type { CommandState } from "./core.js";
import { assign } from "./pm.js";
import {
  DEFAULT_QUEUED_MIGRATION_COOLDOWN_MS,
  migrateQueuedRun,
} from "./queued-run-migration.js";
import {
  apply,
  fixture,
  human,
  id,
  now,
  placement,
  ports,
  run,
  value,
} from "./test-fixtures.js";

const system = { kind: "system" as const, project_id: human.project_id };
const A1 = id("assignment", 1);
const W1 = id("work_item", 1);
const R1 = id("run", 1);
const host = (id: string): Machine => ({
  id,
  label: id,
  herdr_machine: id,
  os: "darwin",
  arch: "arm64",
  tags: [],
  max_assignments: 6,
  status: "online",
  last_seen: now,
});
const slots = (limit: number, occupied: number) => ({ limit, occupied });
const healthy = (godot: { limit: number; occupied: number }) =>
  ({
    remote_binding: "allowed",
    observation_target_matches: true,
    health: { status: "passed", available: true },
    capabilities: [
      { key: "harness.codex", version: "1.2.3", available: true },
      { key: "godot", version: "4.4", available: true },
    ],
    limit: 6,
    occupied: 1,
    resources: new Map([["godot", godot]]),
  }) satisfies MachinePlacement;
let seq = 1000;
const event = (
  type: string,
  payload: Record<string, unknown>,
  at = now,
): Event => ({
  id: String(++seq).padStart(26, "0") as never,
  seq,
  card_id: id("card", 1),
  type,
  actor: system,
  payload: payload as never,
  created_at: at,
});
const selected = (assignment: string, extra: Record<string, unknown> = {}) =>
  event("machine_selected", {
    work_item_id: W1,
    assignment_id: assignment,
    machine_id: "cardigan-ci",
    requested: {},
    ...extra,
  });

/** SEN-C-212: godot full on cardigan-ci, free on mac-mini. */
function state(
  a: Partial<Assignment> = {},
  events: Event[] = [selected(A1)],
): CommandState {
  const s = fixture();
  const queued: Run = {
    ...run(1),
    status: "queued",
    queue_reason: "concurrency_limit",
    queue_entered_at: "2025-12-31T21:57:00.000Z",
  };
  return {
    ...s,
    machines: [host("cardigan-ci"), host("mac-mini")],
    roles: s.roles.map((r) => ({
      ...r,
      worktree: "none",
      ...(r.role_id === "coder" ? { required_capabilities: ["godot"] } : {}),
    })),
    read_machine_placement: () =>
      placement([
        ["cardigan-ci", healthy(slots(2, 2))],
        ["mac-mini", healthy(slots(3, 0))],
      ]),
    work_items: s.work_items.map((w) =>
      w.id === W1 ? { ...w, status: "todo" } : w,
    ),
    assignments: s.assignments.map((x) =>
      x.id === A1
        ? ({
            ...x,
            machine_id: "cardigan-ci",
            runtime_state: "not_provisioned",
            session_ref: undefined,
            employee_id: "E-13",
            ...a,
          } as Assignment)
        : x,
    ),
    runs: [queued],
    events,
  };
}
const io = (unreserved = true) => ({
  ...ports(),
  unreservedAssignment: () => unreserved,
});
const migrate = (
  s: CommandState,
  admissible: readonly string[] = ["mac-mini"],
  options: { unreserved?: boolean; actor?: typeof system | typeof human } = {},
) =>
  migrateQueuedRun(
    s,
    options.actor ?? system,
    {
      run_id: R1,
      admissible,
      reason: "godot 名额 2/2 已满",
      queued_at: "2025-12-31T21:57:00.000Z",
    },
    io(options.unreserved),
  );
const refusal = (result: ReturnType<typeof migrate>) => {
  expect(result.ok).toBe(false);
  return result.ok ? "" : result.error.message;
};

test("SEN-C-212: the queued Run moves to the machine with a free godot slot, in one transaction", () => {
  const s = state();
  const effect = value(migrate(s));
  const successor = effect.data;
  expect(successor).toMatchObject({
    machine_id: "mac-mini",
    work_item_id: W1,
    employee_id: "E-13",
    role_version: 1,
    status: "active",
    runtime_state: "not_provisioned",
    recovery: { previous_assignment_id: A1, source: "main" },
  });
  const next = apply(s, effect);
  expect(next.runs.find((r) => r.id === R1)?.status).toBe("cancelled");
  expect(next.assignments.find((a) => a.id === A1)).toMatchObject({
    status: "released",
    runtime_state: "released",
    machine_id: "cardigan-ci",
  });
  expect(next.work_items.find((w) => w.id === W1)?.assignment_id).toBe(
    successor.id,
  );
  expect(effect.token_requests).toMatchObject([
    { assignment_id: successor.id },
  ]);
  expect(effect.events.map((e) => [e.type, e.actor.kind])).toEqual([
    ["run_dispatch_aborted", "system"],
    ["assignment_released", "system"],
    ["work_item_assigned", "system"],
    ["machine_selected", "system"],
    ["queued_run_migrated", "system"],
  ]);
  expect(effect.events.at(-1)?.payload).toMatchObject({
    run_id: R1,
    work_item_id: W1,
    from_assignment_id: A1,
    to_assignment_id: successor.id,
    from_machine: "cardigan-ci",
    to_machine: "mac-mini",
    reason: "godot 名额 2/2 已满",
    waited_ms: 2 * 3_600_000 + 3 * 60_000,
  });
  // One timeline line, no PM Ops notice or human item.
  expect(effect.timeline).toHaveLength(1);
  expect(effect.timeline[0]?.body).toBe(
    `${R1} 在 cardigan-ci 排队 2 小时 3 分钟（godot 名额 2/2 已满），已自动改到 mac-mini：${A1} → ${successor.id}`,
  );
  // The dispatcher hands the old owner's bells over through the same proof.
  expect(cancelledQueueRelease(next, id("card", 1), A1)?.type).toBe(
    "assignment_released",
  );
  // A repeated assign keeps the successor instead of reselecting.
  expect(
    value(assign(next, human, { work_item_id: W1, role_id: "coder" }, io()))
      .data.id,
  ).toBe(successor.id);
});

test("only the system migrates, and only when the host found another machine free now", () => {
  expect(refusal(migrate(state(), ["mac-mini"], { actor: human }))).toContain(
    "Only the system",
  );
  expect(refusal(migrate(state(), []))).toContain("主机核对：现在不能开工");
  expect(refusal(migrate(state(), ["cardigan-ci"]))).toContain(
    "当前排队所在机器",
  );
  // The host's admission and the placement facts must agree on free room.
  const full: CommandState = {
    ...state(),
    read_machine_placement: () =>
      placement([
        ["cardigan-ci", healthy(slots(2, 2))],
        ["mac-mini", healthy(slots(3, 3))],
      ]),
  };
  expect(refusal(migrate(full))).toBe("没有现在就能开工的机器");
  expect(refusal(migrate(state(), ["mac-mini"], { unreserved: false }))).toBe(
    `${A1} 正在启动`,
  );
});

test("existing machine filters still apply to the target", () => {
  const s = state();
  for (const variant of [
    {
      ...s,
      machines: [
        host("cardigan-ci"),
        { ...host("mac-mini"), status: "offline" as const },
      ],
    },
    {
      ...s,
      read_machine_placement: () =>
        placement([
          ["cardigan-ci", healthy(slots(2, 2))],
          [
            "mac-mini",
            {
              ...healthy(slots(3, 0)),
              capabilities: [
                { key: "harness.codex", version: "1.2.3", available: true },
              ],
            },
          ],
        ]),
    },
    {
      ...s,
      events: [selected(A1, { requested: { tags: ["gpu"] } })],
    },
  ]) {
    const result = migrate(variant);
    expect(result.ok).toBe(false);
    expect(variant.runs[0]?.status).toBe("queued");
  }
});

test.each([
  [
    "author commits without a backup",
    {
      worktree_path: "/w/A-1",
      branch: "agent/C-1/W-1",
      base_sha: "b".repeat(40),
    },
    [],
  ],
  [
    "a backed-up branch whose worktree is not proven clean",
    {
      worktree_path: "/w/A-1",
      branch: "agent/C-1/W-1",
      base_sha: "b".repeat(40),
    },
    [
      event("assignment_branch_backed_up", {
        assignment_id: A1,
        machine_id: "cardigan-ci",
        branch: "agent/C-1/W-1",
        sha: "c".repeat(40),
        ref: "refs/cardigan/backups/cardigan-ci/agent/C-1/W-1",
      }),
    ],
  ],
  ["an idle session", { runtime_state: "idle", session_ref: "session-1" }, []],
] as const)(
  "an Assignment that already worked stays: %s",
  (_name, a, extra) => {
    const s = state(a as Partial<Assignment>, [selected(A1), ...extra]);
    expect(refusal(migrate(s))).toContain("已开过工");
  },
);

test("a dispatched queue, an explicit or legacy placement and a stopped owner stay", () => {
  const dispatched = state({}, [
    selected(A1),
    event("run_dispatched", { assignment_id: A1, run_id: R1 }),
  ]);
  expect(refusal(migrate(dispatched))).toContain("已开过工");
  expect(refusal(migrate(state({}, [])))).toContain("不是系统按规则选的");
  const legacy = selected(A1);
  const { requested: _r, ...payload } = legacy.payload as Record<
    string,
    unknown
  >;
  expect(
    refusal(migrate(state({}, [{ ...legacy, payload: payload as never }]))),
  ).toContain("不是系统按规则选的");
  const held = state();
  expect(
    refusal(
      migrate({
        ...held,
        cards: held.cards.map((c) => ({
          ...c,
          hold: { by: "human", at: now, reason: "x" } as never,
        })),
      }),
    ),
  ).toContain("已暂停或已结束");
});

test("the same work item does not move back and forth: it cools down, then any machine may take it", () => {
  const first = state();
  const moved = apply(first, value(migrate(first)));
  const successor = moved.work_items.find((w) => w.id === W1)?.assignment_id;
  if (!successor) throw new Error("Missing successor");
  // The successor now waits on mac-mini while cardigan-ci frees up.
  const waiting: CommandState = {
    ...moved,
    runs: [
      ...moved.runs,
      {
        ...run(2),
        assignment_id: successor,
        status: "queued",
        queue_reason: "concurrency_limit",
      },
    ],
    read_machine_placement: () =>
      placement([
        ["cardigan-ci", healthy(slots(2, 0))],
        ["mac-mini", healthy(slots(3, 3))],
      ]),
  };
  const again = (at: string) =>
    migrateQueuedRun(
      waiting,
      system,
      {
        run_id: id("run", 2),
        admissible: ["cardigan-ci"],
        reason: "godot 名额 3/3 已满",
        queued_at: now,
      },
      { ...io(), clock: { now: () => at } },
    );
  const at = (ms: number) => new Date(Date.parse(now) + ms).toISOString();
  expect(refusal(again(now))).toBe(`${W1} 刚迁移过，冷却中`);
  expect(refusal(again(at(DEFAULT_QUEUED_MIGRATION_COOLDOWN_MS - 1)))).toBe(
    `${W1} 刚迁移过，冷却中`,
  );
  // After the cooldown the machine it left is a candidate again (no dead wait).
  const back = value(again(at(DEFAULT_QUEUED_MIGRATION_COOLDOWN_MS)));
  expect(back.data).toMatchObject({
    machine_id: "cardigan-ci",
    recovery: { previous_assignment_id: successor },
  });
});

test("C-826#10: a resource another project reserved exclusively is not free now", () => {
  // cardigan-ci's godot is reserved by another project; mac-mini's is busy.
  const reserved = (s: CommandState): CommandState => ({
    ...s,
    read_machine_placement: () =>
      placement([
        ["cardigan-ci", { ...healthy(slots(2, 0)), reserved: ["godot"] }],
        ["mac-mini", healthy(slots(3, 3))],
      ]),
  });
  const queuedOnMini = reserved({
    ...state(),
    assignments: state().assignments.map((a) =>
      a.id === A1 ? { ...a, machine_id: "mac-mini" } : a,
    ),
  });
  expect(refusal(migrate(queuedOnMini, ["cardigan-ci"]))).toBe(
    "没有现在就能开工的机器",
  );
  // Assignment-time selection: the reserved machine is not chosen even
  // though its slots are free; when all are busy it ranks after a full one.
  const fresh: CommandState = reserved({
    ...state(),
    assignments: state().assignments.filter((a) => a.id !== A1),
    work_items: state().work_items.map(({ assignment_id: _a, ...w }) => w),
    runs: [],
  });
  const chosen = value(
    assign(fresh, human, { work_item_id: W1, role_id: "coder" }, io()),
  );
  expect(chosen.data.machine_id).toBe("mac-mini");
  expect(chosen.events.at(-1)?.payload).toMatchObject({
    candidates: [
      { machine_id: "mac-mini", remaining_ratio: 0 },
      {
        machine_id: "cardigan-ci",
        remaining_ratio: 0,
        reserved: ["godot"],
        full: ["godot 被其它项目预约独占"],
      },
    ],
  });
  // An alternative is blocked only when every verified option is reserved.
  const any = (reservedKeys: string[]): CommandState => ({
    ...fresh,
    roles: fresh.roles.map((r) =>
      r.role_id === "coder"
        ? { ...r, required_capabilities: ["android.any"] }
        : r,
    ),
    read_machine_placement: () => {
      const android = {
        ...healthy(slots(2, 0)),
        capabilities: [
          { key: "harness.codex", version: "1.2.3", available: true },
          { key: "android.any", version: null, available: true },
          { key: "android.emulator", version: null, available: true },
          { key: "android.device", version: null, available: true },
        ],
        resources: new Map(),
      };
      return placement([
        ["cardigan-ci", { ...android, occupied: 0, reserved: reservedKeys }],
        ["mac-mini", { ...android, occupied: 3 }],
      ]);
    },
  });
  const pick = (keys: string[]) =>
    value(
      assign(any(keys), human, { work_item_id: W1, role_id: "coder" }, io()),
    ).data.machine_id;
  expect(pick(["android.emulator"])).toBe("cardigan-ci");
  expect(pick(["android.emulator", "android.device"])).toBe("mac-mini");
});
