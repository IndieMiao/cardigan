import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Assignment, CommandState, Event, Run } from "@cardigan/domain";
import { defaultRoleDefinition } from "@cardigan/roles";
import { getRoleVersion, Store, writeRole } from "@cardigan/store";
import { afterEach, expect, test, vi } from "vitest";
import {
  ROTATION_DUE_EVENT,
  rotateIdleDeployedRoles,
  STANDING_ROTATION_MAX_DEFER_MINUTES,
  STANDING_ROTATION_QUIET_MINUTES,
  standingRotationDue,
  standingRotationPolicy,
  upgradeDeployedRoles,
} from "./deployment-roles.js";
import { recordDefault } from "./role-provenance.js";

// C-786: the fixture's host_ops pack carries a security revision only when a
// test asks for it.
const revision = vi.hoisted(() => ({ host_ops: 0 }));
vi.mock("@cardigan/roles", async (original) => ({
  ...(await original<typeof import("@cardigan/roles")>()),
  roleSecurityRevision: (id: string) =>
    id === "host_ops" ? revision.host_ops : 0,
}));
afterEach(() => {
  revision.host_ops = 0;
});

const MIN = 60_000;
const policy = { quiet_ms: 30 * MIN, max_defer_ms: 720 * MIN };
const t0 = Date.parse("2026-11-26T08:00:00.000Z");
const at = (minutes: number) => new Date(t0 + minutes * MIN).toISOString();
const ref = {
  machine_id: "local",
  runtime_machine: "local",
  terminal_ref: "t-standing",
  agent_name: "fixture",
} as Assignment["runtime_ref"];
const standing = (over: Partial<Assignment> = {}): Assignment =>
  ({
    id: "A-50",
    scope: "standing",
    role_id: "pm",
    standing_mode: "office",
    role_version: 2,
    status: "active",
    runtime_state: "idle",
    machine_id: "local",
    runtime_ref: ref,
    mcp_token_id: "fixture",
    created_at: at(-600),
    ...over,
  }) as Assignment;
const upgrade = (
  to: number,
  created: string,
  security_revision?: number,
): Event =>
  ({
    id: `E-${to}`,
    seq: to,
    type: "host_role_upgraded",
    actor: { kind: "system", project_id: "fixture" },
    created_at: created,
    payload: {
      role_id: "pm",
      from_version: to - 1,
      to_version: to,
      ...(security_revision === undefined ? {} : { security_revision }),
    },
  }) as Event;
const run = (over: Partial<Run>): Run =>
  ({
    id: "R-1",
    assignment_id: "A-50",
    status: "completed",
    ...over,
  }) as Run;
const state = (events: Event[], runs: Run[] = []) =>
  ({ events, runs }) as unknown as CommandState;
const due = (
  s: CommandState,
  a: Assignment,
  now: number,
  p: Parameters<typeof standingRotationDue>[4] = policy,
) => standingRotationDue(s, a, { role_version: 3 }, at(now), p);

test("C-786: an ordinary upgrade waits while the session is recently active", () => {
  const s = state([upgrade(3, at(0))], [run({ finished_at: at(-5) })]);
  expect(due(s, standing(), 0)).toBeUndefined();
  expect(due(s, standing(), 24)).toBeUndefined();
  expect(due(s, standing(), 25)).toBe("quiet");
});

test("C-786: every kind of activity postpones the quiet rotation", () => {
  const upgraded = [upgrade(3, at(0))];
  for (const s of [
    state(upgraded, [run({ started_at: at(10) })]),
    state(upgraded, [run({ heartbeat_at: at(10) })]),
    state(upgraded, [run({ finished_at: at(10) })]),
  ])
    expect(due(s, standing(), 39)).toBeUndefined();
  expect(
    due(state(upgraded), standing({ last_mcp_activity_at: at(10) }), 39),
  ).toBeUndefined();
  expect(
    due(state(upgraded), standing({ last_mcp_activity_at: at(10) }), 40),
  ).toBe("quiet");
  // Another Assignment's Runs are not this session's activity.
  expect(
    due(
      state(upgraded, [
        run({ assignment_id: "A-51" as never, finished_at: at(10) }),
      ]),
      standing({ last_mcp_activity_at: at(-60) }),
      1,
    ),
  ).toBe("quiet");
});

test("C-786: no live session rotates at once; its next wake starts a new one anyway", () => {
  const s = state([upgrade(3, at(0))], [run({ finished_at: at(-1) })]);
  expect(due(s, standing({ runtime_ref: null }), 0)).toBe("no_session");
});

test("C-786: a busy-all-day session still rotates once the oldest upgrade waited the cap", () => {
  const s = state(
    [upgrade(3, at(0))],
    [
      run({ finished_at: at(719) }),
      run({ id: "R-2" as never, heartbeat_at: at(700) }),
    ],
  );
  expect(due(s, standing(), 719)).toBeUndefined();
  expect(due(s, standing(), 720)).toBe("max_defer");
  // Two deployments collapse into one rotation, counted from the first.
  const two = state(
    [upgrade(3, at(0)), upgrade(4, at(600))],
    [run({ finished_at: at(719) })],
  );
  expect(
    standingRotationDue(two, standing(), { role_version: 4 }, at(720), policy),
  ).toBe("max_defer");
});

test("C-786: a raised security revision never waits", () => {
  const busy = [run({ finished_at: at(0) })];
  expect(due(state([upgrade(3, at(0), 1)], busy), standing(), 0)).toBe(
    "security",
  );
  // The pinned version already carries that revision: an ordinary upgrade.
  expect(
    due(
      state([upgrade(2, at(-60), 1), upgrade(3, at(0), 1)], busy),
      standing(),
      0,
    ),
  ).toBeUndefined();
  expect(
    due(
      state([upgrade(2, at(-60), 1), upgrade(3, at(0), 2)], busy),
      standing(),
      0,
    ),
  ).toBe("security");
  // Any upgrade between the pinned and the target version counts.
  expect(
    standingRotationDue(
      state([upgrade(3, at(0), 1), upgrade(4, at(1))], busy),
      standing(),
      { role_version: 4 },
      at(1),
      policy,
    ),
  ).toBe("security");
  // Not an audit from the system, or for another role: ignored.
  const forged = {
    ...upgrade(3, at(0), 5),
    actor: { kind: "human", project_id: "fixture" },
  } as Event;
  const other = {
    ...upgrade(3, at(0), 5),
    payload: { role_id: "coder", to_version: 3, security_revision: 5 },
  } as Event;
  expect(
    due(state([upgrade(3, at(0)), forged, other], busy), standing(), 0),
  ).toBeUndefined();
});

test("C-786: quiet 0 is the switch back to rotating as soon as the Run ends", () => {
  const s = state([upgrade(3, at(0))], [run({ finished_at: at(0) })]);
  expect(due(s, standing(), 0, { quiet_ms: 0, max_defer_ms: MIN })).toBe(
    "immediate",
  );
});

test("C-786: the policy reads host settings and keeps its defaults for bad values", () => {
  expect(standingRotationPolicy({})).toEqual({
    quiet_ms: STANDING_ROTATION_QUIET_MINUTES * MIN,
    max_defer_ms: STANDING_ROTATION_MAX_DEFER_MINUTES * MIN,
  });
  expect(
    standingRotationPolicy({
      CARDIGAN_STANDING_ROTATION_QUIET_MINUTES: "0",
      CARDIGAN_STANDING_ROTATION_MAX_DEFER_MINUTES: "60",
    }),
  ).toEqual({ quiet_ms: 0, max_defer_ms: 60 * MIN });
  for (const bad of ["-1", "1.5", "abc", "", "99999999"])
    expect(
      standingRotationPolicy({
        CARDIGAN_STANDING_ROTATION_QUIET_MINUTES: bad,
        CARDIGAN_STANDING_ROTATION_MAX_DEFER_MINUTES: bad,
      }),
    ).toEqual(standingRotationPolicy({}));
  expect(
    standingRotationPolicy({
      CARDIGAN_STANDING_ROTATION_MAX_DEFER_MINUTES: "0",
    }).max_defer_ms,
  ).toBe(STANDING_ROTATION_MAX_DEFER_MINUTES * MIN);
});

/** A live, recently active standing host_ops session and a deployed upgrade. */
async function deployedUpgrade(recentActivity: string) {
  const dataDir = await mkdtemp(join(tmpdir(), "cg-standing-rotation-"));
  const store = Store.open({ dataDir });
  const project = "fixture";
  store.createProject({ id: project });
  const next = defaultRoleDefinition("host_ops", {
    harness: "codex",
    launch_profile_ref: "fixture",
  });
  const old = { ...next, instructions: "Earlier default instructions" };
  const a: Assignment = {
    id: "A-50" as never,
    scope: "standing",
    role_id: "host_ops",
    role_version: 1,
    status: "active",
    runtime_state: "idle",
    machine_id: "local",
    runtime_ref: ref,
    mcp_token_id: "fixture",
    created_at: "2026-01-01T00:00:00.000Z",
    last_mcp_activity_at: recentActivity,
  };
  store.uow.run((tx) => {
    writeRole(
      tx,
      project,
      { ...old, core_prompt: "", version: 1 },
      { mode: "add" },
    );
    tx.assignments.put(project, a);
    recordDefault(
      tx,
      project,
      "host_ops",
      old,
      "pack",
      "2026-01-01T00:00:00.000Z",
    );
  });
  upgradeDeployedRoles(store, project, ["host_ops"], {}, new Set(["fixture"]));
  const read = () =>
    store.uow.read((tx) => ({
      assignment: tx.assignments.get(project, a.id),
      role: getRoleVersion(tx, project, "host_ops"),
      events: tx.events.listAfter(project, undefined, 0),
    }));
  return {
    store,
    project,
    read,
    close: async () => {
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

test("C-786: a deployment keeps an active standing session until it is quiet", async () => {
  const f = await deployedUpgrade(new Date().toISOString());
  try {
    const upgraded = f.read();
    expect(upgraded.role?.version).toBe(2);
    expect(
      upgraded.events.find((e) => e.type === "host_role_upgraded")?.payload,
    ).not.toHaveProperty("security_revision");
    // The deployment's own pass and later maintenance ticks keep the session.
    rotateIdleDeployedRoles(f.store, f.project);
    expect(f.read().assignment?.status).toBe("active");
    const later = new Date(Date.now() + 31 * MIN).toISOString();
    rotateIdleDeployedRoles(f.store, f.project, undefined, undefined, policy, {
      now: () => later,
    });
    const after = f.read();
    expect(after.assignment?.status).toBe("released");
    expect(
      after.events.filter((e) => e.type === ROTATION_DUE_EVENT),
    ).toMatchObject([
      {
        actor: { kind: "system" },
        payload: {
          role_id: "host_ops",
          previous_assignment_id: "A-50",
          from_version: 1,
          to_version: 2,
          trigger: "quiet",
        },
      },
    ]);
  } finally {
    await f.close();
  }
});

test("C-786: a security revision in the deployed pack rotates the active session at once", async () => {
  revision.host_ops = 1;
  const f = await deployedUpgrade(new Date().toISOString());
  try {
    const after = f.read();
    expect(
      after.events.find((e) => e.type === "host_role_upgraded")?.payload,
    ).toMatchObject({ to_version: 2, security_revision: 1 });
    expect(after.assignment?.status).toBe("released");
    expect(
      after.events.find((e) => e.type === ROTATION_DUE_EVENT)?.payload,
    ).toMatchObject({ trigger: "security" });
  } finally {
    await f.close();
  }
});
