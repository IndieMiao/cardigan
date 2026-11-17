import { beforeEach, expect, expectTypeOf, test } from "vitest";
import {
  type Actor,
  acknowledgeRun,
  dispatchRun,
  prepareDelivery,
  queueRun,
  type Result,
  type Role,
  type RoleReference,
  type Runtime,
  roleReference,
  runtimeErrorCodes,
  submitDelivery,
  transition,
} from "../index.js";
import {
  actor,
  commit,
  dispatch,
  f,
  item,
  queue,
  ref,
  setup,
  system,
} from "./launch/test-fixtures.js";
import { apply, human, id, subject, value } from "./test-fixtures.js";

const reject = (r: Result<unknown>, code: string) =>
  expect(r).toMatchObject({ ok: false, error: { code } });
beforeEach(setup);
async function deliverForReviewer() {
  const run = f.state.runs.find((r) => r.assignment_id === f.coder.id);
  if (!run) throw new Error("Missing coder Run");
  commit(acknowledgeRun(f.state, actor(), { run_id: run.id }, f.io));
  const params = {
    work_item_id: item().id,
    kind: "code" as const,
    summary: "Ready",
    subject,
    requested_verifiers: [item(f.reviewer).id],
  };
  const proof = value(
    await prepareDelivery(f.state, actor(), params, {
      verify: async () => ({ ok: true, value: [] }),
    }),
  );
  commit(submitDelivery(f.state, actor(), params, proof, f.io));
}
test("Role definitions preserve RoleReference compatibility; Runtime exposes seven typed ports", () => {
  const definition: Role = {
    role_id: "coder",
    version: 2,
    display_name: "Coder",
    kind: "work",
    core_prompt: "Protocol",
    harness: "codex",
    launch_profile_ref: "coder",
    allowed_tools: ["whoami"],
    capabilities: ["code"],
    abilities: [],
    worktree: "write",
    required_machine_tags: [],
  };
  expect(roleReference(definition)).toEqual({
    role_id: "coder",
    role_version: 2,
    allowed_tools: ["whoami"],
    capabilities: ["code"],
    required_machine_tags: [],
  });
  expectTypeOf<keyof RoleReference>().toEqualTypeOf<
    | "role_id"
    | "role_version"
    | "allowed_tools"
    | "capabilities"
    | "status"
    | "required_machine_tags"
  >();
  expectTypeOf<keyof Runtime>().toEqualTypeOf<
    | "provision"
    | "wake"
    | "status"
    | "interrupt"
    | "resume_or_replace"
    | "human_entry"
    | "retire_idle"
    | "release"
  >();
  expect(runtimeErrorCodes).toContain("version_mismatch");
});

test.each(["human", "system"] as const)(
  "invariants 4, 12: %s queues and dispatches real todo work without activating it",
  (kind) => {
    const host: Actor = { kind, project_id: f.state.project_id };
    const before = JSON.stringify(f.state);
    const queued = value(
      queueRun(
        f.state,
        host,
        { assignment_id: f.coder.id, model: "m", agent_cli_version: "v" },
        f.io,
      ),
    );
    expect(JSON.stringify(f.state)).toBe(before);
    expect(queued.data).toMatchObject({
      kind: "initial",
      status: "queued",
      role_version: 1,
      model: "m",
      agent_cli_version: "v",
    });
    expect(queued.events[0]).toMatchObject({
      id: queued.data.trigger_event_id,
      type: "run_queued",
      card_id: item().card_id,
      actor: host,
    });
    f.state = apply(f.state, queued);
    const sent = commit(
      dispatchRun(
        f.state,
        host,
        { run_id: queued.data.id, runtime_ref: ref, base_sha: subject.value },
        f.io,
      ),
    );
    expect(sent.status).toBe("dispatched");
    expect(f.state.work_items.every((w) => w.status === "todo")).toBe(true);
    expect(f.state.assignments.find((a) => a.id === f.coder.id)).toMatchObject({
      runtime_state: "running",
      runtime_ref: ref,
      base_sha: subject.value,
    });
  },
);

test.each(["queued", "dispatched", "acked", "running", "unknown"] as const)(
  "invariant 4: %s Run prevents a second queue",
  (status) => {
    let r = commit(queue());
    if (status !== "queued") r = commit(dispatch(r));
    if (status === "running") {
      const acked = value(transition("run", r.status, "acknowledge"));
      f.state = {
        ...f.state,
        runs: [{ ...r, status: value(transition("run", acked, "start")) }],
      };
    }
    if (status === "acked" || status === "unknown")
      f.state = {
        ...f.state,
        runs: [
          {
            ...r,
            status: value(
              transition(
                "run",
                r.status,
                status === "acked" ? "acknowledge" : "connection_lost",
              ),
            ),
          },
        ],
      };
    reject(queue(), "invariant_violation");
  },
);

test("invariant 4: dispatch refuses another Assignment's occupied worktree", async () => {
  commit(dispatch(commit(queue())));
  await deliverForReviewer();
  const r = commit(queue(f.reviewer));
  reject(dispatch(r), "invariant_violation");
});

test.each(["queued", "dispatched", "acked", "running", "unknown"] as const)(
  "explicit start reuses only queued work, preserving exclusivity (%s)",
  (status) => {
    const run = commit(queue());
    f.state = { ...f.state, runs: [{ ...run, status }] };
    const result = queueRun(
      f.state,
      human,
      {
        assignment_id: f.coder.id,
        reuse_queued: true,
        model: "replacement-model",
        agent_cli_version: "replacement-cli",
      },
      f.io,
    );
    if (status !== "queued") reject(result, "invariant_violation");
    else {
      const effect = value(result);
      expect(effect.data).toEqual(run);
      expect(effect.events).toEqual([]);
      expect(apply(f.state, effect)).toEqual(f.state);
    }
  },
);

test("reusing queued work still rejects another Run occupying the same worktree", async () => {
  commit(dispatch(commit(queue())));
  await deliverForReviewer();
  const queued = commit(queue(f.reviewer));
  f.state = {
    ...f.state,
    assignments: f.state.assignments.map((a) => ({
      ...a,
      worktree_path: "/fixture/worktree",
    })),
  };
  reject(
    queueRun(
      f.state,
      human,
      {
        assignment_id: queued.assignment_id,
        reuse_queued: true,
        model: "m",
        agent_cli_version: "v",
      },
      f.io,
    ),
    "invariant_violation",
  );
});

test.each([
  "suspended",
  "released",
  "machine",
  "role",
  "owner",
  "closed",
  "project",
])("queue and dispatch reject invalid target: %s", (fault) => {
  const r = commit(queue());
  if (fault === "role") f.state = { ...f.state, roles: [] };
  else if (fault === "owner")
    f.state = {
      ...f.state,
      work_items: f.state.work_items.map((w) =>
        w.id === f.coder.work_item_id
          ? { ...w, assignment_id: f.reviewer.id }
          : w,
      ),
    };
  else if (fault === "closed" || fault === "project")
    f.state = {
      ...f.state,
      cards: f.state.cards.map((c) =>
        fault === "closed"
          ? { ...c, status: "cancelled" }
          : { ...c, project_id: "another" },
      ),
    };
  else
    f.state = {
      ...f.state,
      assignments: f.state.assignments.map((a) =>
        a.id !== f.coder.id
          ? a
          : fault === "machine"
            ? { ...a, machine_id: "remote" }
            : { ...a, status: fault as "released" | "suspended" },
      ),
    };
  const code =
    (
      {
        role: "not_found",
        owner: "invariant_violation",
        machine: "validation_failed",
        project: "unauthorized",
      } as Record<string, string>
    )[fault] ?? "illegal_transition";
  reject(queue(), code);
  reject(dispatch(r), code);
});

test("invariant 12: blank model/CLI, changed Role snapshot and invalid dispatch metadata are refused", () => {
  for (const [model, agent_cli_version] of [
    [" ", "v"],
    ["m", " "],
  ])
    reject(
      queueRun(
        f.state,
        human,
        {
          assignment_id: f.coder.id,
          model: model ?? "",
          agent_cli_version: agent_cli_version ?? "",
        },
        f.io,
      ),
      "validation_failed",
    );
  const r = commit(queue());
  for (const patch of [
    { role_version: 9 },
    { model: "" },
    { agent_cli_version: "" },
  ]) {
    const corrupt = { ...f.state, runs: [{ ...r, ...patch }] };
    reject(
      dispatchRun(corrupt, human, { run_id: r.id, runtime_ref: ref }, f.io),
      "invariant_violation",
    );
  }
  for (const patch of [
    { machine_id: "remote" },
    { terminal_ref: "" },
    { runtime_machine: "" },
    { agent_name: "" },
    { branch: "" },
    { worktree_path: "" },
    { agent_session_id: "" },
  ])
    reject(dispatch(r, { ...ref, ...patch }), "validation_failed");
  for (const base_sha of [undefined, "wrong"])
    reject(
      dispatchRun(
        f.state,
        human,
        { run_id: r.id, runtime_ref: ref, ...(base_sha ? { base_sha } : {}) },
        f.io,
      ),
      "validation_failed",
    );
});

test("host-only queue/dispatch reject Agent identities, wrong projects and missing targets", () => {
  const r = commit(queue());
  for (const a of [
    actor(),
    { ...human, project_id: "other" },
    { ...system, project_id: "other" },
  ]) {
    reject(
      queueRun(
        f.state,
        a,
        { assignment_id: f.coder.id, model: "m", agent_cli_version: "v" },
        f.io,
      ),
      "unauthorized",
    );
    reject(
      dispatchRun(f.state, a, { run_id: r.id, runtime_ref: ref }, f.io),
      "unauthorized",
    );
  }
  reject(
    queueRun(
      f.state,
      human,
      {
        assignment_id: id("assignment", 999),
        model: "m",
        agent_cli_version: "v",
      },
      f.io,
    ),
    "not_found",
  );
  reject(
    dispatchRun(
      f.state,
      human,
      { run_id: id("run", 999), runtime_ref: ref },
      f.io,
    ),
    "not_found",
  );
});
test("invariant 5: dispatch validates runtime transitions and keeps the worktree on restart", () => {
  const r = commit(queue());
  for (const runtime_state of ["unknown", "lost", "released"] as const)
    reject(
      dispatchRun(
        {
          ...f.state,
          assignments: f.state.assignments.map((a) => ({
            ...a,
            runtime_state,
          })),
        },
        human,
        { run_id: r.id, runtime_ref: ref, base_sha: subject.value },
        f.io,
      ),
      "illegal_transition",
    );
  const sent = commit(dispatch(r));
  reject(dispatch(sent), "illegal_transition");
  f.state = {
    ...f.state,
    runs: [
      { ...sent, status: value(transition("run", sent.status, "cancel")) },
    ],
  };
  const next = commit(queue());
  for (const patch of [
    { worktree_path: "/fixture/other" },
    { branch: "other" },
  ])
    reject(dispatch(next, { ...ref, ...patch }), "invariant_violation");
  commit(dispatch(next));
  expect(f.state.assignments.find((a) => a.id === f.coder.id)).toMatchObject({
    session_ref: "session-1",
    worktree_path: "/fixture/worktree",
    branch: ref.branch,
  });
});
