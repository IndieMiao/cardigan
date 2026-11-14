import { expect, test } from "vitest";
import {
  assign,
  autoAssignVerifier,
  type CommandState,
  type Delivery,
  type Machine,
  queueRun,
  saveMachine,
} from "../index.js";
import {
  actor,
  apply,
  fixture,
  human,
  id,
  now,
  ports,
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
function state(): CommandState {
  const s = fixture();
  return {
    ...s,
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

test("selection requires a unique capability match and ignores capacity/display limits", () => {
  const s = state();
  const multi = { ...s, machines: [...(s.machines ?? []), remote] };
  expect(select(multi)).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("多个候选") },
  });
  expect(
    value(
      select(multi, { os: "darwin", arch: "arm64", required_tags: ["gpu"] }),
    ).data.machine_id,
  ).toBe(remote.id);
  expect(
    value(select({ ...multi, machines: [{ ...remote, max_assignments: 0 }] }))
      .data.machine_id,
  ).toBe(remote.id);
  const required = {
    ...s,
    roles: s.roles.map((r) => ({ ...r, required_machine_tags: ["gpu"] })),
  };
  expect(select(required).ok).toBe(false);
  expect(
    value(select({ ...required, machines: [remote] })).data.machine_id,
  ).toBe(remote.id);
});

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

test.each(["missing_tags", "ambiguous"])(
  "automatic verifiers defer to PM when machine selection is %s",
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
        scenario === "ambiguous"
          ? [...(s.machines ?? []), remote]
          : (s.machines ?? []),
      roles: s.roles.map((r) => ({
        ...r,
        required_machine_tags: scenario === "missing_tags" ? ["gpu"] : [],
      })),
      project_preferences: [
        {
          id: s.project_id,
          auto_merge_after_minutes: null,
          system_auto_assign_verifiers: true,
        },
      ],
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
