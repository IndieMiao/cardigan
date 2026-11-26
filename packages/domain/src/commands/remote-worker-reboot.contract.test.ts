import { expect, test } from "vitest";
import {
  assign,
  completeHumanAction,
  confirmRemoteExitByReboot,
  hostOpsExitConfirmation,
  releaseLostRemoteWorker,
  remoteWorkerExitPending,
  remoteWorkerLosses,
  reportRemoteWorkerAlive,
  requestRemoteWorkerExit,
} from "../index.js";
import type { CommandState } from "./core.js";
import {
  actor,
  apply,
  fixture,
  human,
  id,
  machine,
  now,
  ports,
  value,
} from "./test-fixtures.js";

// C-761: a changed boot identity is the only automatic remote exit evidence.
const system = { kind: "system" as const, project_id: human.project_id };
const owner = id("assignment", 1);
const launch = id("run", 1);
const started = "2025-12-31T23:00:00.000Z";
const process = {
  machine: "f".repeat(64),
  terminal: "c".repeat(32),
  boot: "old-boot-id",
  uid: 501,
  pid: 4242,
  start: "100:200",
  process_group: 4242,
};
const reading = { current_boot: "new-boot-id", observed_at: now };

function setup(
  options: { started?: boolean; process?: typeof process | null } = {},
) {
  const original = fixture();
  const runtime_ref = {
    machine_id: "worker-a",
    runtime_machine: "worker-a",
    terminal_ref: "old-terminal",
    agent_name: "old-agent",
    launch_generation: { run_id: launch, generation: "c".repeat(32) },
  };
  const state: CommandState = {
    ...original,
    machines: [machine(), { ...machine(), id: "worker-a" }],
    assignments: original.assignments.map((a) =>
      a.id === owner
        ? {
            ...a,
            machine_id: "worker-a",
            runtime_state: "lost" as const,
            branch: "agent/C-1/W-1",
            runtime_ref,
          }
        : a,
    ),
    runs: original.runs.map((r) =>
      r.id === launch
        ? {
            ...r,
            status: "unknown" as const,
            ...(options.started === false ? {} : { started_at: started }),
            launch_publication: {
              generation: "c".repeat(32),
              target: {
                project_id: human.project_id,
                machine_id: "worker-a",
                session: "fixture",
                generation: "one",
                fingerprint: "f".repeat(64),
              },
              phase: "started" as const,
              lease_until: now,
              agent_name: "old-agent",
              work_dir: "/worker/A-1",
              sha: null,
              token_id: null,
              runtime_ref,
              process:
                options.process === undefined ? process : options.process,
              log_offset: 0,
              artifacts: [],
              wait: false,
              provision_attempted: true,
            },
          }
        : r,
    ),
  };
  const io = ports();
  const request = value(
    requestRemoteWorkerExit(state, system, { assignment_id: owner }, io),
  );
  const current = apply(state, request);
  const action = current.human_actions[0];
  if (!action) throw new Error("Missing confirmation");
  const action_id = request.data.action_id;
  const confirm = (
    s: CommandState,
    p: Partial<typeof reading> = {},
    caller: Parameters<typeof confirmRemoteExitByReboot>[1] = system,
  ) =>
    confirmRemoteExitByReboot(s, caller, { action_id, ...reading, ...p }, io);
  return { state, current, action, action_id, io, confirm };
}

test("a changed boot read after the Run started completes the exit request as the system and lets PM reassign at once", () => {
  const f = setup();
  expect(remoteWorkerLosses(f.current.events)[0]?.process).toEqual(process);
  const effect = value(f.confirm(f.current));
  const confirmed = apply(f.current, effect);
  // The request is completed by the system itself, never as a human.
  expect(confirmed.human_actions[0]).toMatchObject({
    id: f.action.id,
    status: "done",
    result: { conclusion: "exited" },
  });
  const evidence = effect.events.find(
    (e) => e.type === "remote_worker_reboot_confirmed",
  );
  expect(evidence).toMatchObject({
    actor: system,
    payload: {
      action_id: f.action_id,
      human_action_id: f.action.id,
      assignment_id: owner,
      machine_id: "worker-a",
      run_id: launch,
      run_started_at: started,
      previous_boot: "old-boot-id",
      current_boot: "new-boot-id",
      observed_at: now,
      source: "worker_helper_status",
    },
  });
  expect(effect.events.at(-1)).toMatchObject({
    type: "human_action_completed",
    actor: system,
    payload: {
      human_action_id: f.action.id,
      conclusion: "exited",
      basis: "reboot",
      evidence_event_id: evidence?.id,
    },
  });
  expect(
    effect.timeline.map((t) => (t as { body?: string }).body).join("\n"),
  ).toContain("系统按重启证据自动确认退出");
  expect(hostOpsExitConfirmation(confirmed, f.action_id)).toEqual({
    status: "confirmed",
    human_action_id: f.action.id,
    basis: "reboot",
  });
  expect(
    remoteWorkerExitPending(
      confirmed.events,
      remoteWorkerLosses(confirmed.events)[0] ?? (undefined as never),
    ),
  ).toBe(false);
  // A repeated reading after completion changes nothing.
  expect(f.confirm(confirmed).ok).toBe(false);

  const release = value(
    releaseLostRemoteWorker(confirmed, system, f.action_id, f.io),
  );
  expect(release.events.at(-1)).toMatchObject({
    type: "remote_worker_released",
    payload: { exit_basis: "reboot", human_action_id: f.action.id },
  });
  expect(
    release.timeline.map((t) => (t as { body?: string }).body).join("\n"),
  ).toContain("系统已按重启证据确认");
  const released = apply(confirmed, release);
  expect(released.assignments.find((a) => a.id === owner)).toMatchObject({
    status: "released",
    runtime_ref: null,
  });
  expect(released.runs.find((r) => r.id === launch)).toMatchObject({
    status: "cancelled",
  });
  expect(f.confirm(released).ok).toBe(false);
  // The existing PM reassignment works without a further human step.
  const reassigned = value(
    assign(
      released,
      actor(4, "pm"),
      {
        work_item_id: id("work_item", 1),
        role_id: "coder",
        machine_id: "local",
        recovery_source: "main",
      },
      f.io,
    ),
  );
  expect(reassigned.data.id).not.toBe(owner);
  expect(reassigned.data.recovery).toEqual({
    previous_assignment_id: owner,
    source: "main",
  });
});

const noBoot = "journaled launch boot";
const noOrder = "must follow the Run start";
test.each([
  ["no journaled launch process", { process: null }, {}, noBoot],
  ["the Run never started", { started: false }, {}, noOrder],
  ["the same boot", {}, { current_boot: "old-boot-id" }, noBoot],
  ["an empty boot", {}, { current_boot: "" }, noBoot],
  ["a malformed boot", {}, { current_boot: "new boot/../x" }, noBoot],
  ["a reading before the Run started", {}, { observed_at: started }, noOrder],
  [
    "a reading before the loss was recorded",
    {},
    { observed_at: "2025-12-31T23:30:00.000Z" },
    noOrder,
  ],
  [
    "a reading after the command time",
    {},
    { observed_at: "2026-01-02T00:00:00.000Z" },
    noOrder,
  ],
  ["an unparseable reading time", {}, { observed_at: "later" }, noOrder],
] as const)(
  "%s keeps the human-only confirmation unchanged",
  (_name, options, p, reason) => {
    const f = setup(options);
    const refused = f.confirm(f.current, p);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toContain(reason);
    expect(hostOpsExitConfirmation(f.current, f.action_id)).toEqual({
      status: "open",
      human_action_id: f.action.id,
    });
    expect(
      releaseLostRemoteWorker(f.current, system, f.action_id, f.io).ok,
    ).toBe(false);
    // Only a human completion still settles it.
    const done = apply(
      f.current,
      value(
        completeHumanAction(
          f.current,
          human,
          {
            human_action_id: f.action.id,
            conclusion: "exited",
            text: "checked",
          },
          f.io,
        ),
      ),
    );
    expect(hostOpsExitConfirmation(done, f.action_id)).toEqual({
      status: "confirmed",
      human_action_id: f.action.id,
    });
  },
);

test("only the system can record reboot evidence; Assignments, PM and the human cannot", () => {
  const f = setup();
  for (const caller of [human, actor(), actor(4, "pm")])
    expect(f.confirm(f.current, {}, caller).ok).toBe(false);
  expect(hostOpsExitConfirmation(f.current, f.action_id).status).toBe("open");
});

test("a live process, a human answer or a changed runtime wins over a later reboot reading", () => {
  const f = setup();
  const alive = apply(
    f.current,
    value(reportRemoteWorkerAlive(f.current, system, f.action_id, f.io)),
  );
  expect(f.confirm(alive).ok).toBe(false);
  const falseAlarm = apply(
    f.current,
    value(
      completeHumanAction(
        f.current,
        human,
        {
          human_action_id: f.action.id,
          conclusion: "false_alarm",
          text: "still running",
        },
        f.io,
      ),
    ),
  );
  expect(f.confirm(falseAlarm).ok).toBe(false);
  const changed = {
    ...f.current,
    assignments: f.current.assignments.map((a) =>
      a.id === owner ? { ...a, runtime_ref: null } : a,
    ),
  };
  expect(f.confirm(changed).ok).toBe(false);
});

test("a self-declared reboot without the system's own boot finding never confirms the exit", () => {
  const f = setup();
  const effect = value(f.confirm(f.current));
  const evidence = effect.events.find(
    (e) => e.type === "remote_worker_reboot_confirmed",
  );
  const completion = effect.events.find(
    (e) => e.type === "human_action_completed",
  );
  if (!evidence || !completion) throw new Error("Missing reboot events");
  const done = apply(f.current, effect);
  const forged = (events: CommandState["events"]) => ({
    ...done,
    events: [...f.current.events, ...events],
  });
  // A system completion naming "reboot" with no finding, a finding written by
  // an Assignment, or one for another request are all just claims.
  expect(hostOpsExitConfirmation(forged([completion]), f.action_id)).toEqual({
    status: "rejected",
    human_action_id: f.action.id,
  });
  const byAgent = { ...evidence, actor: actor() };
  expect(
    hostOpsExitConfirmation(forged([byAgent, completion]), f.action_id).status,
  ).toBe("rejected");
  const other = {
    ...evidence,
    payload: {
      ...(evidence.payload as object),
      human_action_id: id("human_action", 99),
    },
  };
  expect(
    hostOpsExitConfirmation(forged([other, completion]), f.action_id).status,
  ).toBe("rejected");
  const unbased = {
    ...completion,
    payload: { ...(completion.payload as object), basis: null },
  };
  expect(
    hostOpsExitConfirmation(forged([evidence, unbased]), f.action_id).status,
  ).toBe("rejected");
  expect(
    releaseLostRemoteWorker(forged([completion]), system, f.action_id, f.io).ok,
  ).toBe(false);
  // The system still cannot complete the request through the ordinary route.
  expect(
    completeHumanAction(
      f.current,
      system,
      { human_action_id: f.action.id, conclusion: "exited", text: "rebooted" },
      f.io,
    ).ok,
  ).toBe(false);
});
