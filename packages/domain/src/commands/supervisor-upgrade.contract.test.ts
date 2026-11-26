import { expect, test } from "vitest";
import {
  reconcileSupervisorNotice,
  recordSupervisorUpgrade,
  supervisorUpgradeState,
} from "./deployment.js";
import { listNeedsYou } from "./queries.js";
import { actor, apply, fixture, human, ports, value } from "./test-fixtures.js";

const from = "a".repeat(40);
const to = "b".repeat(40);
const attempt = "0b5c8f9e-1a2b-4c3d-8e9f-0a1b2c3d4e5f";

test("C-767: an automatic supervisor change records once and opens no human action", () => {
  const io = ports();
  let state = fixture();
  const system = { kind: "system" as const, project_id: state.project_id };
  const input = {
    supervisor: from,
    main: to,
    affected: ["packages/host"],
    automatic: true,
  };
  const auto = value(reconcileSupervisorNotice(state, system, input, io));
  expect(auto.events.map((e) => e.type)).toEqual([
    "host_deployment_supervisor_change",
  ]);
  expect(auto.events[0]?.payload).toMatchObject({ automatic: true });
  expect(auto.changes).toEqual([]);
  state = apply(state, auto);
  expect(state.human_actions).toEqual([]);
  // Once per running supervisor, even when main moves on.
  expect(
    value(
      reconcileSupervisorNotice(
        state,
        system,
        { ...input, main: "c".repeat(40) },
        io,
      ),
    ).events,
  ).toEqual([]);
  // The automatic record never consumes the human reminder (switch off later).
  const manual = value(
    reconcileSupervisorNotice(
      state,
      system,
      { supervisor: from, main: to, affected: ["packages/host"] },
      io,
    ),
  );
  expect(manual.events.map((e) => e.type)).toEqual([
    "host_deployment_action_requested",
    "human_action_requested",
    "host_deployment_supervisor_change",
  ]);
});

test("C-767: only the system records upgrade stages; a failure or rollback opens Needs You once and blocks further attempts", () => {
  const io = ports();
  let state = fixture();
  const system = { kind: "system" as const, project_id: state.project_id };
  const record = (
    status: Parameters<typeof recordSupervisorUpgrade>[2]["status"],
    extra: Partial<Parameters<typeof recordSupervisorUpgrade>[2]> = {},
  ) => ({ attempt, from, to, status, summary: "说明", ...extra });
  for (const caller of [
    human,
    actor(1, "coder"),
    actor(4, "pm"),
    actor(5, "host_ops"),
    { ...system, project_id: "other" },
  ])
    expect(
      recordSupervisorUpgrade(state, caller, record("started"), io).ok,
    ).toBe(false);
  for (const bad of [
    record("started", { to: from }),
    record("started", { from: "main" }),
    record("started", { attempt: "1" }),
    record("started", { summary: " " }),
    record("started", { status: "deployed" as never }),
  ])
    expect(recordSupervisorUpgrade(state, system, bad, io).ok).toBe(false);
  // Every later stage needs the started record of the same versions.
  expect(
    recordSupervisorUpgrade(state, system, record("rolled_back"), io).ok,
  ).toBe(false);
  expect(supervisorUpgradeState(state.events, state.project_id, from)).toEqual({
    blocked: false,
  });
  state = apply(
    state,
    value(recordSupervisorUpgrade(state, system, record("started"), io)),
  );
  expect(
    recordSupervisorUpgrade(
      state,
      system,
      record("restarting", { to: "c".repeat(40) }),
      io,
    ).ok,
  ).toBe(false);
  const restarting = value(
    recordSupervisorUpgrade(state, system, record("restarting"), io),
  );
  expect(restarting.changes).toEqual([]);
  state = apply(state, restarting);
  expect(
    supervisorUpgradeState(state.events, state.project_id, from),
  ).toMatchObject({
    blocked: false,
    active: { attempt, status: "restarting" },
  });
  const rolled = value(
    recordSupervisorUpgrade(state, system, record("rolled_back"), io),
  );
  expect(rolled.events.map((e) => e.type)).toEqual([
    "host_deployment_action_requested",
    "human_action_requested",
    "host_supervisor_upgrade",
  ]);
  state = apply(state, rolled);
  const [action] = state.human_actions;
  expect(action?.status).toBe("open");
  expect(action?.instructions).toContain("已用备份回滚");
  expect(
    value(listNeedsYou(state, human)).data.human_actions.map((h) => h.id),
  ).toContain(action?.id);
  // A terminal record is final: repeats and later stages are no-ops.
  for (const status of ["rolled_back", "failed", "completed"] as const)
    expect(
      value(recordSupervisorUpgrade(state, system, record(status), io)).events,
    ).toEqual([]);
  expect(supervisorUpgradeState(state.events, state.project_id, from)).toEqual({
    blocked: true,
  });
  // Another running version is not blocked by this one's failure.
  expect(
    supervisorUpgradeState(state.events, state.project_id, to).blocked,
  ).toBe(false);
});

test("C-767: a completed upgrade is recorded without Needs You", () => {
  const io = ports();
  let state = fixture();
  const system = { kind: "system" as const, project_id: state.project_id };
  for (const status of ["started", "restarting", "completed"] as const)
    state = apply(
      state,
      value(
        recordSupervisorUpgrade(
          state,
          system,
          { attempt, from, to, status, summary: "ok" },
          io,
        ),
      ),
    );
  expect(state.human_actions).toEqual([]);
  expect(supervisorUpgradeState(state.events, state.project_id, from)).toEqual({
    blocked: false,
  });
});

test("C-770: after a failed or rolled-back attempt the human reminder reuses its Needs You item", () => {
  const io = ports();
  let state = fixture();
  const system = { kind: "system" as const, project_id: state.project_id };
  const manual = { supervisor: from, main: to, affected: ["packages/host"] };
  // A reminder opened while the switch was still off.
  state = apply(
    state,
    value(reconcileSupervisorNotice(state, system, manual, io)),
  );
  const [reminder] = state.human_actions;
  expect(reminder?.status).toBe("open");
  for (const status of ["started", "rolled_back"] as const)
    state = apply(
      state,
      value(
        recordSupervisorUpgrade(
          state,
          system,
          { attempt, from, to, status, summary: "60 秒内健康检查未通过" },
          io,
        ),
      ),
    );
  const failure = state.human_actions.find((h) => h.id !== reminder?.id);
  expect(failure?.status).toBe("open");
  const folded = value(
    reconcileSupervisorNotice(
      state,
      system,
      { ...manual, main: "c".repeat(40) },
      io,
    ),
  );
  // No new human action; the change points at the failure item.
  expect(folded.events.map((e) => e.type)).toEqual([
    "human_action_cancelled",
    "host_deployment_supervisor_change",
  ]);
  expect(folded.events.at(-1)?.payload).toEqual({
    supervisor: from,
    main: "c".repeat(40),
    affected: ["packages/host"],
    human_action_id: failure?.id,
    upgrade_attempt: attempt,
  });
  state = apply(state, folded);
  const open = state.human_actions.filter((h) => h.status === "open");
  expect(open.map((h) => h.id)).toEqual([failure?.id]);
  expect(open[0]?.instructions).toContain("已用备份回滚");
  expect(open[0]?.instructions).toContain(
    `到中心 main ${"c".repeat(40)} 的监督器差异涉及：packages/host`,
  );
  expect(
    state.human_actions.find((h) => h.id === reminder?.id)?.cancellation,
  ).toMatchObject({
    source: "supervisor_rechecked",
    reason: `已并入监督器自动升级失败待办 ${failure?.id}`,
  });
  expect(
    value(listNeedsYou(state, human)).data.human_actions.map((h) => h.id),
  ).toEqual([failure?.id]);
  // Once per running supervisor: later mains add nothing.
  expect(
    value(
      reconcileSupervisorNotice(
        state,
        system,
        { ...manual, main: "d".repeat(40) },
        io,
      ),
    ).events,
  ).toEqual([]);
});

test("C-770: with no self-upgrade records (switch off) the reminder is unchanged", () => {
  const io = ports();
  let state = fixture();
  const system = { kind: "system" as const, project_id: state.project_id };
  // Another version's failure never folds this version's reminder.
  for (const status of ["started", "failed"] as const)
    state = apply(
      state,
      value(
        recordSupervisorUpgrade(
          state,
          system,
          { attempt, from: to, to: "c".repeat(40), status, summary: "x" },
          io,
        ),
      ),
    );
  const result = value(
    reconcileSupervisorNotice(
      state,
      system,
      { supervisor: from, main: to, affected: ["packages/host"] },
      io,
    ),
  );
  expect(result.events.map((e) => e.type)).toEqual([
    "host_deployment_action_requested",
    "human_action_requested",
    "host_deployment_supervisor_change",
  ]);
  state = apply(state, result);
  expect(
    state.human_actions.filter((h) => h.status === "open").at(-1)?.instructions,
  ).toContain("系统不会自我升级");
});
