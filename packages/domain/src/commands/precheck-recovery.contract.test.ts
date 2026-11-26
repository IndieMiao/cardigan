import { expect, test } from "vitest";
import type { Actor, Event } from "../entities.js";
import { HOST_OPS_ROLE_TOOLS } from "../host-ops.js";
import {
  type CommandState,
  hostOpsRecheckPrecheck,
  type Precheck,
  pendingPrecheckRecovery,
  prechecks,
  prepareCheck,
  type RecheckPrecheckParams,
  recordPrecheck,
  requestCheck,
} from "../index.js";
import { roleReference } from "../role.js";
import { createHostOpsAssignment } from "./host-ops.js";
import { createRole } from "./role.js";
import {
  actor,
  apply,
  fixture,
  human,
  id,
  ports,
  value,
} from "./test-fixtures.js";

const system: Actor = { kind: "system", project_id: human.project_id };
const head = "a".repeat(40);
const card = id("card", 1);

/** A running GitHub author precheck bound to run 123, and a standing host_ops. */
async function setup(executor: "github" | "ssh" = "github") {
  const base = fixture();
  const role = value(
    createRole(
      { project_id: base.project_id, roles: [] },
      human,
      {
        role_id: "host_ops",
        display_name: "Host operations",
        kind: "standing",
        instructions: "Inspect session health; report to PM.",
        harness: "codex",
        launch_profile_ref: "fixture",
        worktree: "none",
        capabilities: [],
        abilities: [],
        required_machine_tags: [],
        allowed_tools: HOST_OPS_ROLE_TOOLS,
      },
      ports(),
    ),
  ).data;
  let state: CommandState = {
    ...base,
    roles: [...base.roles, roleReference(role)],
    cards: base.cards.map((c) => ({ ...c, flow_version: 3 })),
    assignments: base.assignments.map((a) =>
      a.id === id("assignment", 1)
        ? { ...a, branch: "agent/test", worktree_path: "/synthetic/worktree" }
        : a,
    ),
  };
  const io = ports();
  const ops = value(createHostOpsAssignment(state, human, {}, io));
  state = apply(state, ops);
  const params = { work_item_id: id("work_item", 1) };
  const receipt = value(
    await prepareCheck(state, actor(), params, { head: async () => head }),
  );
  state = apply(
    state,
    value(requestCheck(state, actor(), params, receipt, io)),
  );
  const queued = prechecks(state.events)[0] as Precheck;
  const running: Precheck = {
    ...queued,
    status: "running",
    candidate_sha: "b".repeat(40),
    tree_sha: "c".repeat(40),
    base_sha: "d".repeat(40),
    executor: { name: "ci", type: executor },
    ...(executor === "github"
      ? {
          external_run: {
            provider: "github" as const,
            run_id: 123,
            run_attempt: 1,
            html_url: "https://github.com/fixture/project/actions/runs/123",
            workflow_sha: "e".repeat(40),
          },
        }
      : {}),
  };
  state = apply(state, value(recordPrecheck(state, system, running, io)));
  const opsActor: Extract<Actor, { kind: "assignment" }> = {
    kind: "assignment",
    project_id: base.project_id,
    assignment_id: ops.data.assignment.id,
    role_id: "host_ops",
    role_version: 1,
    capabilities: [],
    allowed_tools: HOST_OPS_ROLE_TOOLS,
  };
  const request = (
    s: CommandState,
    who: Actor = opsActor,
    p: Partial<RecheckPrecheckParams> = {},
  ) =>
    hostOpsRecheckPrecheck(
      s,
      who,
      {
        card_id: card,
        attempt_id: running.attempt_id,
        action: "reinspect",
        reason: "GitHub finished but the precheck still shows running",
        ...p,
      },
      io,
    );
  return { state, io, opsActor, running, request };
}
const handled = (
  state: CommandState,
  request_id: string,
  attempt_id: string,
  who: Actor = system,
): Event => ({
  id: ports().ids.nextEventId(),
  seq: state.events.length + 1,
  card_id: card,
  type: "precheck_recovery_handled",
  actor: who,
  payload: { attempt_id, request_id, outcome: "reattach" },
  created_at: "2030-01-01T00:00:00.000Z",
});

test("C-773: only the standing host_ops identity holding the tool can ask to reinspect or abandon a precheck", async () => {
  const f = await setup();
  for (const who of [
    human,
    system,
    actor(),
    actor(2, "reviewer"),
    { ...f.opsActor, project_id: "foreign" },
    {
      ...f.opsActor,
      allowed_tools: HOST_OPS_ROLE_TOOLS.filter(
        (t) => t !== "host_ops_recheck_precheck",
      ),
    },
  ])
    expect(f.request(f.state, who).ok).toBe(false);
  const effect = value(f.request(f.state));
  expect(effect.data).toMatchObject({
    attempt_id: f.running.attempt_id,
    action: "reinspect",
    status: "requested",
  });
  expect(effect.events.map((e) => e.type)).toEqual([
    "precheck_recovery_requested",
    "host_ops_action_taken",
  ]);
  expect(effect.events[0]?.actor).toMatchObject({
    kind: "assignment",
    role_id: "host_ops",
  });
  expect(effect.events[1]?.payload).toMatchObject({
    tool: "host_ops_recheck_precheck",
    target_id: card,
    attempt_id: f.running.attempt_id,
  });
  expect(effect.timeline[0]?.body).toContain("重新核对");
  // Recording a request never changes the precheck itself.
  expect(prechecks(apply(f.state, effect).events)[0]).toEqual(f.running);
});

test("C-773: requests target only a queued or running GitHub precheck and need a real reason", async () => {
  const f = await setup();
  for (const p of [
    { attempt_id: "missing" },
    { reason: "  " },
    { reason: "x".repeat(501) },
    { action: "delete" as never },
    { card_id: id("card", 2) },
  ])
    expect(f.request(f.state, f.opsActor, p).ok).toBe(false);
  const ended = apply(
    f.state,
    value(
      recordPrecheck(
        f.state,
        system,
        { ...f.running, status: "interrupted", summary: "ended" },
        f.io,
      ),
    ),
  );
  expect(f.request(ended).ok).toBe(false);
  const ssh = await setup("ssh");
  expect(ssh.request(ssh.state).ok).toBe(false);
});

test("C-773: a repeated request while one is pending records nothing; only a system handling reopens the attempt", async () => {
  const f = await setup();
  const first = value(f.request(f.state));
  const s = apply(f.state, first);
  const request = first.events[0] as Event;
  expect(pendingPrecheckRecovery(s.events, card, f.running.attempt_id)).toEqual(
    {
      request_id: request.id,
      card_id: card,
      attempt_id: f.running.attempt_id,
      action: "reinspect",
    },
  );
  const again = value(f.request(s));
  expect(again.events).toEqual([]);
  expect(again.data).toMatchObject({
    request_id: request.id,
    status: "already_requested",
  });
  // A different action cannot overtake the pending one.
  expect(f.request(s, f.opsActor, { action: "abandon" }).ok).toBe(false);
  // A non-system "handled" record is ignored.
  const forged = {
    ...s,
    events: [
      ...s.events,
      handled(s, request.id, f.running.attempt_id, f.opsActor),
    ],
  };
  expect(
    pendingPrecheckRecovery(forged.events, card, f.running.attempt_id)
      ?.request_id,
  ).toBe(request.id);
  const settled = {
    ...s,
    events: [...s.events, handled(s, request.id, f.running.attempt_id)],
  };
  expect(
    pendingPrecheckRecovery(settled.events, card, f.running.attempt_id),
  ).toBeUndefined();
  const abandon = value(f.request(settled, f.opsActor, { action: "abandon" }));
  expect(abandon.data).toMatchObject({
    action: "abandon",
    status: "requested",
  });
  expect(abandon.timeline[0]?.body).toContain("放弃");
});

test("C-773: request records written by anyone but host_ops are never pending work", async () => {
  const f = await setup();
  const forged: Event = {
    id: ports().ids.nextEventId(),
    seq: f.state.events.length + 1,
    card_id: card,
    type: "precheck_recovery_requested",
    actor: actor(),
    payload: {
      attempt_id: f.running.attempt_id,
      action: "abandon",
      reason: "forged",
    },
    created_at: "2030-01-01T00:00:00.000Z",
  };
  expect(
    pendingPrecheckRecovery(
      [...f.state.events, forged],
      card,
      f.running.attempt_id,
    ),
  ).toBeUndefined();
});
