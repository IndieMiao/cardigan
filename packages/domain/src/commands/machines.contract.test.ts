import { expect, test } from "vitest";
import {
  assign,
  assignOrDefer,
  autoAssignVerifier,
  type CommandState,
  type Delivery,
  type Machine,
  type MachinePlacement,
  queueRun,
  releaseAssignment,
  saveMachine,
} from "../index.js";
import {
  actor,
  apply,
  assignment,
  fixture,
  human,
  id,
  machine,
  now,
  placement,
  ports,
  role,
  run,
  subject,
  value,
} from "./test-fixtures.js";

const remote: Machine = {
  id: "worker-a",
  label: "Worker A",
  herdr_machine: "worker-a",
  os: "darwin",
  arch: "arm64",
  tags: ["gpu"],
  max_assignments: 1,
  status: "online",
  last_seen: now,
};
const healthy: MachinePlacement = {
  remote_binding: "allowed",
  observation_target_matches: true,
  health: { status: "passed", available: true },
  capabilities: [
    { key: "harness.codex", version: "1.2.3", available: true },
    { key: "godot", version: "4.10", available: true },
  ],
  limit: 4,
  occupied: 0,
};
function state(): CommandState {
  const s = fixture();
  return {
    ...s,
    roles: s.roles.map((r) => ({ ...r, worktree: "none" })),
    read_machine_placement: () =>
      placement([
        ["local", healthy],
        [remote.id, healthy],
      ]),
    assignments: s.assignments.filter((a) => a.id === id("assignment", 4)),
    runs: [],
    work_items: s.work_items.map(({ assignment_id: _id, ...w }) => w),
  };
}
const select = (
  s: CommandState,
  p: Partial<Parameters<typeof assign>[2]> = {},
) =>
  assign(
    s,
    human,
    { work_item_id: id("work_item", 1), role_id: "coder", ...p },
    ports(),
  );

test("machine registration is human-only, project-scoped and audited without granting tools", () => {
  const s = state();
  const params = { machine: remote, operation: "register" as const };
  expect(saveMachine(s, actor(4, "pm"), params, ports()).ok).toBe(false);
  expect(
    saveMachine(s, { kind: "human", project_id: "other" }, params, ports()).ok,
  ).toBe(false);
  expect(
    saveMachine(
      s,
      { kind: "system", project_id: s.project_id },
      params,
      ports(),
    ).ok,
  ).toBe(false);
  const effect = value(saveMachine(s, human, params, ports()));
  expect(effect.events).toMatchObject([
    { type: "machine_registered", actor: human },
  ]);
  expect(effect.token_requests).toEqual([]);
  expect(
    value(select(apply(s, effect), { machine_id: remote.id })).data.machine_id,
  ).toBe(remote.id);
  expect(saveMachine(apply(s, effect), human, params, ports()).ok).toBe(false);
  expect(
    saveMachine(
      s,
      human,
      { ...params, machine: { ...remote, ssh_key: "forbidden" } as Machine },
      ports(),
    ).ok,
  ).toBe(false);
});

test.each([
  [[], {}, "没有登记"],
  [[], { machine_id: "other-project-worker" }, "没有登记"],
  [[remote], { machine_id: "local" }, "没有登记"],
  [[remote], { os: "linux" }, "os=linux"],
  [[remote], { arch: "x64" }, "arch=x64"],
  [[remote], { required_tags: ["simulator"] }, "tag=simulator"],
  [[{ ...remote, status: "offline" as const }], {}, "offline"],
  [[{ ...remote, status: "draining" as const }], {}, "draining"],
] as const)(
  "unavailable machine rejects atomically (%j)",
  (machines, params, reason) => {
    const s = { ...state(), machines };
    const before = JSON.stringify(s);
    expect(select(s, params)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining(reason) },
    });
    expect(JSON.stringify(s)).toBe(before);
  },
);

test("producer placement orders by same-card producer worktree, free fraction, preference, then ID", () => {
  const s = state();
  const preferred = {
    id: s.project_id,
    auto_merge_after_minutes: null,
    machine_preference: [remote.id],
  };
  const multi = { ...s, machines: [remote, machine()] };
  expect(value(select(multi)).data.machine_id).toBe("local");
  const tie = { ...multi, project_preferences: [preferred] };
  expect(value(select(tie)).data.machine_id).toBe(remote.id);
  const busy = {
    ...tie,
    read_machine_placement: () =>
      placement([
        [remote.id, { ...healthy, limit: 8, occupied: 6 }],
        ["local", { ...healthy, limit: 2, occupied: 1 }],
      ]),
  };
  expect(value(select(busy)).data.machine_id).toBe("local"); // one free of two beats two of eight
  const previous = {
    ...assignment(8),
    machine_id: remote.id,
    worktree_path: "fixture-tree",
  };
  const [base] = busy.work_items;
  if (!base) throw new Error("Missing producer");
  const item = { ...base, id: previous.work_item_id };
  const onCard = {
    ...busy,
    assignments: [previous],
    work_items: [...busy.work_items, item],
  };
  expect(value(select(onCard)).data.machine_id).toBe(remote.id);
  const full = value(
    select({
      ...onCard,
      read_machine_placement: () =>
        placement([
          [
            remote.id,
            { ...healthy, limit: 1, occupied: 1, pending_assignments: 1 },
          ],
          ["local", healthy],
        ]),
    }),
  );
  expect(full.events.at(-1)?.payload).toMatchObject({
    machine_id: "local",
    candidates: [
      { machine_id: "local" },
      {
        machine_id: remote.id,
        affinity: true,
        occupied: 1,
        pending_assignments: 1,
        remaining_ratio: 0,
      },
    ],
  });
  expect(
    value(
      select({
        ...onCard,
        work_items: [...busy.work_items, { ...item, card_id: id("card", 2) }],
      }),
    ).data.machine_id,
  ).toBe("local");
  expect(
    value(
      select({
        ...busy,
        assignments: [{ ...previous, work_item_id: id("work_item", 2) }],
      }),
    ).data.machine_id,
  ).toBe("local");
  expect(
    value(
      select({
        ...onCard,
        assignments: [{ ...assignment(8), machine_id: remote.id }],
      }),
    ).data.machine_id,
  ).toBe("local");
});

// The remote worker would win the capacity tie-breaker absent the worktree guard.
function preferRemote(): CommandState {
  return {
    ...state(),
    machines: [machine(), remote],
    read_machine_placement: () =>
      placement([
        ["local", { ...healthy, occupied: 3 }],
        [remote.id, healthy],
      ]),
  };
}

test.each(["write", "readonly", undefined] as const)(
  "interactive placement excludes remote for worktree policy %s, without bypassing local requirements",
  (worktree) => {
    const s = {
      ...preferRemote(),
      roles: fixture().roles.map((r) => ({
        ...r,
        ...(worktree ? { worktree } : {}),
      })),
    };
    const reason = worktree
      ? `服务端远程 Git 工作树准备尚未验证（角色工作树策略：${worktree}）`
      : "角色工作树策略未知，无法确定远程 Git 工作树准备要求";
    const params = { work_item_id: id("work_item", 1), role_id: "coder" };
    const e = value(assignOrDefer(s, human, params, ports()));
    expect(e.data).toMatchObject({ machine_id: "local" });
    expect(e.events.at(-1)).toMatchObject({
      type: "machine_selected",
      payload: {
        candidates: [{ machine_id: "local" }],
        excluded: [{ machine_id: remote.id, reasons: [reason] }],
      },
    });
    const gap = value(
      assignOrDefer(
        s,
        actor(4, "pm"),
        { ...params, required_tags: ["gpu"] },
        ports(),
      ),
    );
    expect(gap.events).toMatchObject([
      {
        type: "system_assignment_deferred",
        payload: { reason: expect.stringContaining(reason) },
      },
    ]);
    expect(gap.data).toMatchObject({
      deferred: true,
      reason: expect.stringContaining("tag=gpu"),
    });
    expect(gap.token_requests).toEqual([]);
    expect(gap.changes).toEqual([]);
    expect(value(select(s, { machine_id: remote.id })).data.machine_id).toBe(
      remote.id,
    );
  },
);

test.each(["write", "readonly", undefined] as const)(
  "a preparation attested for one worker only admits known worktree policy %s",
  (worktree) => {
    const base = preferRemote();
    const ready: MachinePlacement = {
      ...healthy,
      worktree_preparation: "verified",
    };
    const target: CommandState = {
      ...base,
      roles: fixture().roles.map((r) => ({
        ...r,
        ...(worktree && { worktree }),
      })),
      machines: [machine(), remote, { ...remote, id: "worker-b" }],
      read_machine_placement: () =>
        placement([
          ["local", { ...healthy, occupied: 3 }],
          [remote.id, ready],
          ["worker-b", healthy],
        ]),
    };
    const selected = value(select(target));
    if (!worktree) {
      expect(selected.data.machine_id).toBe("local");
      expect(selected.events.at(-1)?.payload).toMatchObject({
        excluded: [
          {
            machine_id: remote.id,
            reasons: [expect.stringContaining("策略未知")],
          },
          {
            machine_id: "worker-b",
            reasons: [expect.stringContaining("策略未知")],
          },
        ],
      });
      return;
    }
    expect(selected.data.machine_id).toBe(remote.id);
    expect(selected.events.at(-1)?.payload).toMatchObject({
      excluded: [
        {
          machine_id: "worker-b",
          reasons: [expect.stringContaining("尚未验证")],
        },
      ],
    });
    const bound = apply(target, selected);
    const repeated = value(
      select({ ...bound, read_machine_placement: () => placement() }),
    );
    expect(repeated.data).toEqual(selected.data);
    expect(repeated.events).toEqual([]);
  },
);

test("implicit placement uses the requested role version and does not move an existing assignment", () => {
  const s = preferRemote();
  const target: CommandState = {
    ...s,
    roles: [
      ...s.roles,
      ...s.roles
        .filter((r) => r.role_id === "coder")
        .map((r) => ({ ...r, role_version: 2, worktree: "write" as const })),
    ],
  };
  expect(value(select(target)).data).toMatchObject({
    role_version: 2,
    machine_id: "local",
  });
  const pinned = value(select(target, { role_version: 1 }));
  expect(pinned.data).toMatchObject({ role_version: 1, machine_id: remote.id });
  const repeated = value(select(apply(target, pinned)));
  expect(repeated.data).toEqual(pinned.data);
  expect(repeated.events).toEqual([]);
});

test("selection records sorted scores and exclusions, never redeems an unverified tag or an expired proof", () => {
  const s = state();
  const stale = { ...remote, id: "stale", tags: ["godot"] };
  const multi = {
    ...s,
    machines: [stale, remote, machine()],
    roles: s.roles.map((r) => ({
      ...r,
      required_capabilities: ["godot>=4.9"],
    })),
    work_items: s.work_items.map((w) => ({
      ...w,
      requirements: { capabilities: ["godot=4.10.0"] },
    })),
    read_machine_placement: () =>
      placement([
        [remote.id, healthy],
        ["local", { ...healthy, capabilities: [] }],
        [
          stale.id,
          {
            ...healthy,
            capabilities: [{ key: "godot", version: "4.11", available: false }],
          },
        ],
      ]),
  };
  const e = value(select(multi));
  expect(e.events.at(-1)).toMatchObject({
    type: "machine_selected",
    card_id: id("card", 1),
    actor: human,
    payload: {
      work_item_id: id("work_item", 1),
      assignment_id: e.data.id,
      machine_id: remote.id,
      candidates: [{ machine_id: remote.id, remaining_ratio: 1 }],
      excluded: [
        {
          machine_id: "local",
          reasons: expect.arrayContaining(["godot=4.10.0：未验证"]),
        },
        {
          machine_id: "stale",
          reasons: expect.arrayContaining(["godot>=4.9：已过期"]),
        },
      ],
    },
  });
  const tooOld = {
    ...multi,
    read_machine_placement: () =>
      placement([
        [
          remote.id,
          {
            ...healthy,
            capabilities: [{ key: "godot", version: "4.8", available: true }],
          },
        ],
      ]),
  };
  expect(select(tooOld)).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("godot>=4.9：版本不满足") },
  });
  const explicit = value(select(tooOld, { machine_id: remote.id }));
  expect(explicit.events.map((e) => e.type)).toEqual(["work_item_assigned"]);
  expect(
    select(
      { ...multi, machines: [remote] },
      { machine_id: remote.id, os: "linux" },
    ).ok,
  ).toBe(false);
});

test.each([
  [{ worktree_preparation: "expired" }, "准备证据已过期"],
  [{ worktree_preparation: "invalid" }, "准备证据无效"],
  [{ limit: 0 }, "容量配置不可用"],
  [{ remote_binding: "disabled" }, "allow_remote_launch"],
  [{ remote_binding: "platform_mismatch" }, "OS 或架构与机器登记不一致"],
  [{ health: null }, "缺少健康快照"],
  [
    { health: { status: "passed", available: false, launch_enabled: true } },
    "已过期",
  ],
  [
    { health: { status: "failed", available: false, launch_enabled: true } },
    "未通过",
  ],
] as const)(
  "implicit remote placement requires fresh trusted evidence (%j)",
  (patch, reason) => {
    const base = state();
    const s: CommandState = {
      ...base,
      roles: base.roles.map((r) => ({ ...r, worktree: "write" })),
      machines: [remote],
      read_machine_placement: () =>
        placement([
          [
            remote.id,
            { ...healthy, worktree_preparation: "verified", ...patch },
          ],
        ]),
    };
    expect(select(s)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining(reason) },
    });
    expect(value(select(s, { machine_id: remote.id })).data.machine_id).toBe(
      remote.id,
    );
  },
);

test("repeated assignments stay fixed even after health changes; release cannot reassign", () => {
  const effect = value(select({ ...state(), machines: [remote] }));
  const s = apply(state(), effect);
  expect(value(select({ ...s, machines: [] })).data.machine_id).toBe(remote.id);
  expect(select(s, { machine_id: "local" })).toMatchObject({
    ok: false,
    error: { code: "invariant_violation" },
  });
  expect(
    select({
      ...s,
      assignments: s.assignments.map((a) => ({ ...a, status: "released" })),
    }).ok,
  ).toBe(false);
  const cause = effect.events[0];
  if (!cause) throw new Error("missing assignment event");
  // P2b-01 registers remote targets but cannot start them through local runtime.
  expect(
    queueRun(
      s,
      { kind: "system", project_id: s.project_id },
      {
        assignment_id: effect.data.id,
        kind: "initial",
        model: "fixture",
        agent_cli_version: "fixture",
        trigger_event_id: cause.id,
      },
      ports(),
    ).ok,
  ).toBe(false);
});

test.each([
  "missing_tags",
  "prefer_control",
  "full_control",
  "specific_capability",
])(
  "automatic verifiers use the shared selection and deferral policy: %s",
  (scenario) => {
    const s = state();
    const delivery: Delivery = {
      id: id("delivery", 1),
      work_item_id: id("work_item", 1),
      run_id: id("run", 1),
      kind: "code",
      summary: "Fixture",
      subject,
      evidence: [],
      attachments: [],
      known_gaps: [],
      requested_verifiers: [id("work_item", 2)],
      status: "submitted",
    };
    const target: CommandState = {
      ...s,
      machines:
        scenario !== "missing_tags"
          ? [...(s.machines ?? []), remote]
          : (s.machines ?? []),
      roles: s.roles.map((r) => ({
        ...r,
        ...(scenario === "specific_capability"
          ? { required_capabilities: ["godot"] }
          : {}),
        required_machine_tags: scenario === "missing_tags" ? ["gpu"] : [],
      })),
      project_preferences: [
        {
          id: s.project_id,
          auto_merge_after_minutes: null,
          system_auto_assign_verifiers: true,
        },
      ],
      read_machine_placement: () =>
        placement([
          [
            "local",
            { ...healthy, occupied: scenario === "full_control" ? 4 : 3 },
          ],
          [remote.id, healthy],
        ]),
      deliveries: [delivery],
      employees: [
        {
          id: id("employee", 1),
          name: "Reviewer",
          title: "Reviewer",
          bio: "",
          avatar: null,
          role_id: "reviewer",
          launch_profile_ref: null,
          status: "active",
          created_at: now,
          updated_at: now,
        },
      ],
    };
    const effect = value(
      autoAssignVerifier(
        target,
        { kind: "system", project_id: s.project_id },
        { work_item_id: id("work_item", 2) },
        ports(),
      ),
    );
    if (scenario !== "missing_tags") {
      expect(effect.data?.machine_id).toBe(
        scenario === "prefer_control" ? "local" : remote.id,
      );
      expect(effect.events.at(-1)?.type).toBe("machine_selected");
      return;
    }
    expect(effect.data).toBeNull();
    expect(effect.token_requests).toEqual([]);
    expect(effect.changes.some((c) => c.collection === "assignments")).toBe(
      false,
    );
    expect(effect.events).toMatchObject([
      { type: "system_assignment_deferred" },
    ]);
  },
);

test("an implicit interactive request hands an actionable gap to Ops once; explicit and unauthorized failures are atomic", () => {
  const s = {
    ...state(),
    machines: [remote],
    read_machine_placement: () => placement(),
  };
  const params = { work_item_id: id("work_item", 1), role_id: "coder" };
  const effect = value(assignOrDefer(s, human, params, ports()));
  expect(effect.events).toMatchObject([
    {
      type: "system_assignment_deferred",
      actor: human,
      payload: {
        interactive: true,
        reason: expect.stringContaining("allow_remote_launch"),
      },
    },
  ]);
  expect(effect.token_requests).toEqual([]);
  expect(effect.changes).toEqual([]);
  expect(
    value(assignOrDefer(apply(s, effect), human, params, ports())).events,
  ).toEqual([]);
  expect(assignOrDefer(s, actor(), params, ports()).ok).toBe(false);
  expect(
    assignOrDefer(s, human, { ...params, machine_id: "unregistered" }, ports())
      .ok,
  ).toBe(false);
});

test("MC-4 ranks by the tightest required slot without moving an existing assignment", () => {
  const s = state();
  const slots = (limit: number, occupied: number) => ({ limit, occupied });
  const multi: CommandState = {
    ...s,
    machines: [machine(), remote],
    roles: s.roles.map((r) => ({ ...r, required_capabilities: ["godot>=4"] })),
    read_machine_placement: () =>
      placement([
        [
          "local",
          {
            ...healthy,
            limit: 10,
            occupied: 1,
            resources: new Map([["godot", slots(4, 3)]]),
          },
        ],
        [
          remote.id,
          {
            ...healthy,
            occupied: 2,
            resources: new Map([["blender", slots(1, 1)]]),
          },
        ],
      ]),
  };
  const selected = value(select(multi));
  expect(selected.data.machine_id).toBe(remote.id);
  expect(selected.events.at(-1)?.payload).toMatchObject({
    candidates: [
      { machine_id: remote.id, remaining_ratio: 0.5 },
      {
        machine_id: "local",
        remaining_ratio: 0.25,
        resources: [{ key: "godot", limit: 4, occupied: 3 }],
      },
    ],
  });
  const bound = apply(multi, selected);
  expect(
    value(select({ ...bound, read_machine_placement: () => placement() })).data
      .machine_id,
  ).toBe(remote.id);
});

test.each([
  [undefined, [], "启动配置未知"],
  ["claude-code", [], "harness.claude-code：未验证"],
  [
    "claude-code",
    [{ available: false, version: "2.0" }],
    "harness.claude-code：已过期",
  ],
  [
    "claude-code",
    [{ available: true, version: null }],
    "harness.claude-code：缺少版本",
  ],
] as const)(
  "remote launch requires fresh version evidence; local keeps registry rules (%s, %j)",
  (harness, proof, reason) => {
    const worker = {
      ...healthy,
      capabilities: [
        ...healthy.capabilities,
        ...proof.map((c) => ({ ...c, key: "harness.claude-code" })),
      ],
    };
    const effect = value(
      select({
        ...preferRemote(),
        read_machine_placement: () => ({
          harness,
          machines: new Map([[remote.id, worker]]),
        }),
      }),
    );
    expect(effect.data.machine_id).toBe("local");
    expect(effect.events.at(-1)).toMatchObject({
      type: "machine_selected",
      payload: {
        excluded: [
          { machine_id: remote.id, reasons: [expect.stringContaining(reason)] },
        ],
      },
    });
  },
);

test("only a released pre-Run snapshot failure can reselect a different machine for the same item", () => {
  const io = ports();
  const base = preferRemote();
  const ops = {
    ...actor(4, "pm"),
    allowed_tools: ["release_assignment", "assign"] as const,
  };
  const s: CommandState = {
    ...base,
    assignments: base.assignments.map((a) =>
      a.scope === "standing" ? { ...a, standing_mode: "ops" } : a,
    ),
    work_items: base.work_items.map((w) =>
      w.kind === "produce" ? { ...w, status: "todo" } : w,
    ),
  };
  const params = { role_id: "coder", work_item_id: id("work_item", 1) };
  const first = value(assign(s, human, params, io));
  expect(first.data.machine_id).toBe(remote.id);
  const before = apply(s, first),
    card = id("card", 1);
  const failure = {
    id: io.ids.nextEventId(),
    seq: io.ids.nextEventSequence(s.project_id, card),
    card_id: card,
    created_at: now,
    type: "bell_delivery_failed",
    actor: { kind: "system" as const, project_id: s.project_id },
    payload: { assignment_id: first.data.id, reason: "snapshot_unavailable" },
  };
  const failed = { ...before, events: [...before.events, failure] };
  expect(value(assign(failed, human, params, io)).data.id).toBe(first.data.id);
  const release = value(
    releaseAssignment(failed, ops, { assignment_id: first.data.id }, io),
  );
  const released = apply(failed, release);
  const reassign = (state: CommandState) => assign(state, ops, params, io);
  for (const events of [
    before.events,
    [...before.events, ...release.events],
    [...before.events, { ...failure, actor: human }, ...release.events],
    [
      ...released.events.filter((e) => e.id !== failure.id),
      { ...failure, seq: 99 },
    ],
  ]) {
    expect(reassign({ ...released, events }).ok).toBe(false);
  }
  expect(
    reassign({
      ...released,
      runs: [{ ...run(), assignment_id: first.data.id, status: "completed" }],
    }).ok,
  ).toBe(false);
  expect(
    assign(released, human, { ...params, machine_id: "local" }, io).ok,
  ).toBe(false);
  expect(
    value(assignOrDefer({ ...released, machines: [remote] }, human, params, io))
      .token_requests,
  ).toEqual([]);
  const recovered = value(
    reassign({
      ...released,
      roles: [...released.roles, { ...role("coder"), role_version: 2 }],
    }),
  );
  expect(recovered.data).toMatchObject({
    machine_id: "local",
    work_item_id: params.work_item_id,
    role_version: 1,
    recovery: { previous_assignment_id: first.data.id, source: "main" },
  });
  expect(recovered.data.id).not.toBe(first.data.id);
  expect(recovered.events.at(-1)).toMatchObject({
    type: "machine_selected",
    payload: {
      excluded: [
        {
          machine_id: remote.id,
          reasons: [expect.stringContaining("上次首发")],
        },
      ],
    },
  });
  const next = apply(released, recovered);
  expect(next.assignments.find((a) => a.id === first.data.id)).toMatchObject({
    status: "released",
    machine_id: remote.id,
  });
  expect(
    next.work_items.find((w) => w.id === params.work_item_id)?.assignment_id,
  ).toBe(recovered.data.id);
  expect(
    next.work_items.find((w) => w.kind === "verify")?.target_work_item_id,
  ).toBe(params.work_item_id);
  expect(value(reassign(next)).events).toEqual([]);
});
