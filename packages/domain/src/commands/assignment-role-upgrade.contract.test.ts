import { expect, test } from "vitest";
import {
  beginIdleAssignmentRoleUpgrade,
  finishIdleAssignmentRoleUpgrade,
} from "./assignment-role-upgrade.js";
import { upgradeCardFlow } from "./flow.js";
import { queueRun } from "./launch.js";
import { actor, apply, fixture, human, ports, value } from "./test-fixtures.js";

const system = { kind: "system" as const, project_id: human.project_id };
function setup() {
  const base = fixture();
  const owner = {
    ...base.assignments[0]!,
    employee_id: "E-1" as never,
    worktree_path: "/synthetic/worktree",
    branch: "agent/feature",
    session_ref: "old-session",
    base_sha: "a".repeat(40),
  };
  return {
    ...base,
    assignments: [owner],
    runs: [],
    roles: [
      {
        ...base.roles[0]!,
        allowed_tools: base.roles[0]!.allowed_tools.filter(
          (t) => !["request_check", "get_check_log"].includes(t),
        ),
      },
      { ...base.roles[0]!, role_version: 2 },
    ],
  };
}
test("idle role upgrade preserves the owner and work, fences launches until exit, and records one replacement", () => {
  const state = setup(),
    owner = state.assignments[0]!,
    io = ports();
  const start = value(
    beginIdleAssignmentRoleUpgrade(state, system, owner.id, io),
  );
  const pending = apply(state, start);
  expect(start.data.role_version).toBe(1);
  expect(
    queueRun(
      pending,
      system,
      {
        assignment_id: owner.id,
        kind: "initial",
        model: "fixture",
        agent_cli_version: "1",
      },
      io,
    ),
  ).toMatchObject({ ok: false });
  const finish = value(
    finishIdleAssignmentRoleUpgrade(pending, system, owner.id, io),
  );
  expect(finish.data).toMatchObject({
    id: owner.id,
    employee_id: owner.employee_id,
    role_version: 2,
    worktree_path: owner.worktree_path,
    branch: owner.branch,
    base_sha: owner.base_sha,
    runtime_ref: null,
    runtime_state: "not_provisioned",
  });
  expect(finish.data.session_ref).toBeUndefined();
  expect(finish.events).toMatchObject([
    {
      type: "session_replaced",
      payload: {
        reason: "default_role_upgraded",
        from_version: 1,
        to_version: 2,
      },
    },
  ]);
  expect(
    value(
      finishIdleAssignmentRoleUpgrade(
        apply(pending, finish),
        system,
        owner.id,
        io,
      ),
    ).events,
  ).toEqual([]);
});
test.each(["queued", "dispatched", "acked", "running", "unknown"] as const)(
  "a %s Run keeps its pinned version",
  (status) => {
    const state = setup(),
      run = fixture().runs[0]!;
    expect(
      beginIdleAssignmentRoleUpgrade(
        { ...state, runs: [{ ...run, status }] },
        system,
        state.assignments[0]!.id,
        ports(),
      ),
    ).toMatchObject({ ok: false, error: { code: "illegal_transition" } });
  },
);
test("only the system can upgrade, and external or released owners stay unchanged", () => {
  const state = setup(),
    owner = state.assignments[0]!;
  for (const caller of [human, actor()])
    expect(
      beginIdleAssignmentRoleUpgrade(state, caller, owner.id, ports()).ok,
    ).toBe(false);
  for (const patch of [{ external: true }, { status: "released" as const }])
    expect(
      beginIdleAssignmentRoleUpgrade(
        { ...state, assignments: [{ ...owner, ...patch }] },
        system,
        owner.id,
        ports(),
      ).ok,
    ).toBe(false);
});
test("flow upgrade refuses a pinned producer missing precheck tools and succeeds after role retirement", () => {
  const state = setup(),
    owner = state.assignments[0]!,
    io = ports();
  const input = { card_id: state.cards[0]!.id, to: 5 };
  expect(upgradeCardFlow(state, human, input, io)).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining(owner.id) },
  });
  const pending = apply(
    state,
    value(beginIdleAssignmentRoleUpgrade(state, system, owner.id, io)),
  );
  const upgraded = apply(
    pending,
    value(finishIdleAssignmentRoleUpgrade(pending, system, owner.id, io)),
  );
  expect(upgradeCardFlow(upgraded, human, input, io).ok).toBe(true);
});
