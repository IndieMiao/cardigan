import { expect, test, vi } from "vitest";
import type { CommandState, Event, SubmitDeliveryParams } from "../index.js";
import {
  latestMergeCheck,
  type Precheck,
  prechecks,
  prepareCheck,
  prepareDelivery,
  prepareRecheck,
  recordPrecheck,
  requestCheck,
  requestRecheck,
  submitDelivery,
} from "../index.js";
import {
  recheckVerifier,
  returnedRecheckFixture,
} from "./request-recheck/test-fixtures.js";
import {
  actor,
  apply,
  fixture,
  id,
  now,
  ports,
  subject,
  value,
} from "./test-fixtures.js";

const params: SubmitDeliveryParams = {
  work_item_id: id("work_item", 1),
  kind: "code",
  summary: "Ready",
  subject,
  requested_verifiers: [id("work_item", 2)],
};
// Synthetic A2a event contract; this does not execute an actual precheck.
function passed(patch: Partial<Event> = {}): Event {
  return {
    id: ports().ids.nextEventId(),
    card_id: id("card", 1),
    seq: 1,
    type: "precheck_finished",
    actor: { kind: "system", project_id: fixture().project_id },
    payload: {
      attempt_id: "synthetic-precheck",
      head_sha: subject.value,
      base_sha: "b".repeat(40),
      tree_sha: "c".repeat(40),
      status: "passed",
    },
    created_at: now,
    ...patch,
  };
}
function state(events: readonly Event[] = []): CommandState {
  const base = fixture();
  return {
    ...base,
    cards: base.cards.map((card) => ({ ...card, flow_version: 3 })),
    project_settings: { merge_gate_enabled: true },
    events,
  };
}
const verification = () => ({
  verify: vi.fn(async () => ({ ok: true as const, value: [] })),
});
const denied = {
  ok: false,
  error: { code: "illegal_transition", message: "请先 request_check" },
};

test.each([
  "queued",
  "running",
  "passed",
  "failed",
  "timed_out",
  "interrupted",
  "executor_unreachable",
  "environment_failed",
] as const)(
  "A2a command-produced %s evidence gates delivery",
  async (status) => {
    const io = ports();
    let s = state();
    s = {
      ...s,
      assignments: s.assignments.map((a) => ({
        ...a,
        branch: "agent/precheck",
        worktree_path: "/synthetic/precheck",
      })),
    };
    const request = { work_item_id: params.work_item_id };
    const receipt = value(
      await prepareCheck(s, actor(), request, {
        head: async () => subject.value,
      }),
    );
    s = apply(s, value(requestCheck(s, actor(), request, receipt, io)));
    const system = { kind: "system" as const, project_id: s.project_id };
    const queued = prechecks(s.events)[0];
    if (!queued) throw new Error("Missing queued precheck");
    const candidate = "b".repeat(40);
    const running: Precheck = {
      ...queued,
      status: "running",
      candidate_sha: candidate,
      tree_sha: "c".repeat(40),
      base_sha: "d".repeat(40),
      executor: { name: "synthetic", type: "ssh" },
    };
    if (status !== "queued")
      s = apply(s, value(recordPrecheck(s, system, running, io)));
    if (status !== "queued" && status !== "running")
      s = apply(
        s,
        value(
          recordPrecheck(
            s,
            system,
            {
              ...running,
              status,
              checks: [
                {
                  name: "test",
                  status: status === "passed" ? "passed" : "failed",
                  exit_code: status === "passed" ? 0 : 1,
                },
              ],
            },
            io,
          ),
        ),
      );
    const verifier = verification();
    if (status !== "passed") {
      expect(await prepareDelivery(s, actor(), params, verifier)).toEqual(
        denied,
      );
      expect(verifier.verify).not.toHaveBeenCalled();
      return;
    }
    // The author HEAD qualifies, never the merged candidate or another card.
    expect(
      await prepareDelivery(
        s,
        actor(),
        { ...params, subject: { ...subject, value: candidate } },
        verifier,
      ),
    ).toEqual(denied);
    expect(
      await prepareDelivery(
        {
          ...s,
          events: s.events.map((e) => ({ ...e, card_id: id("card", 2) })),
        },
        actor(),
        params,
        verifier,
      ),
    ).toEqual(denied);
    s = {
      ...s,
      assignments: s.assignments.map((a) => ({
        ...a,
        base_sha: "e".repeat(40),
      })),
    };
    const proof = value(await prepareDelivery(s, actor(), params, verifier));
    const effect = value(submitDelivery(s, actor(), params, proof, io));
    expect(effect.data.subject).toEqual(subject);
    expect(
      latestMergeCheck(s.events, id("card", 1), effect.data.id),
    ).toBeUndefined();
  },
);

test.each([
  "code",
  "design",
  "doc",
  "test_report",
  "card_completion",
  "other",
] as const)(
  "a Git %s delivery cannot bypass the precheck gate",
  async (kind) => {
    const p: SubmitDeliveryParams = {
      ...params,
      kind,
      ...(kind === "card_completion"
        ? {
            requested_verifiers: [id("work_item", 3)],
            plain_summary: {
              changed: "修正显示",
              impact: "显示正确",
              risk: "无",
            },
          }
        : {}),
    };
    expect(await prepareDelivery(state(), actor(), p, verification())).toEqual(
      denied,
    );
  },
);

test.each([
  "queued",
  "running",
  "failed",
  "timed_out",
  "interrupted",
  "executor_unreachable",
  "cancelled",
])("flow 3: a %s precheck cannot authorize delivery", async (status) => {
  const s = state([passed({ payload: { head_sha: subject.value, status } })]);
  const verifier = verification();
  expect(await prepareDelivery(s, actor(), params, verifier)).toEqual(denied);
  expect(verifier.verify).not.toHaveBeenCalled();
  expect(s.deliveries).toEqual([]);
});

test.each([
  ["missing", []],
  ["another card", [passed({ card_id: id("card", 2) })]],
  [
    "another SHA",
    [passed({ payload: { head_sha: "d".repeat(40), status: "passed" } })],
  ],
  ["author claim", [passed({ actor: actor() })]],
  [
    "another project",
    [passed({ actor: { kind: "system", project_id: "other" } })],
  ],
  ["merge check", [passed({ type: "merge_check_finished" })]],
  ["queued event claiming passed", [passed({ type: "precheck_queued" })]],
  ["started event claiming passed", [passed({ type: "precheck_started" })]],
  ["missing head", [passed({ payload: { status: "passed" } })]],
  ["missing status", [passed({ payload: { head_sha: subject.value } })]],
  ["null payload", [passed({ payload: null })]],
  ["array payload", [passed({ payload: [] })]],
  ["text payload", [passed({ payload: "passed" })]],
] satisfies [string, Event[]][])(
  "flow 3: %s cannot supply a passed precheck",
  async (_label, events) => {
    expect(
      await prepareDelivery(state(events), actor(), params, verification()),
    ).toEqual(denied);
  },
);

test.each([3, 4, 5])(
  "flow %s: same-card same-SHA pass permits delivery after the baseline advances",
  async (version) => {
    const s = state([passed()]);
    const advanced = {
      ...s,
      cards: s.cards.map((card) => ({ ...card, flow_version: version })),
      assignments: s.assignments.map((a) => ({
        ...a,
        base_sha: "e".repeat(40),
      })),
    };
    const proof = value(
      await prepareDelivery(advanced, actor(), params, verification()),
    );
    const effect = value(
      submitDelivery(advanced, actor(), params, proof, ports()),
    );
    expect(effect.data.subject).toEqual(subject);
    expect(apply(advanced, effect).deliveries).toHaveLength(1);
    // The precheck grants no final-merge check evidence.
    expect(
      latestMergeCheck(advanced.events, id("card", 1), effect.data.id),
    ).toBeUndefined();
  },
);

test("any passed precheck for this SHA qualifies, regardless of later attempts", async () => {
  const s = state([
    passed(),
    passed({ seq: 2, payload: { head_sha: subject.value, status: "failed" } }),
  ]);
  expect((await prepareDelivery(s, actor(), params, verification())).ok).toBe(
    true,
  );
});

test.each([undefined, 1, 2])(
  "flow %s preserves the old delivery path",
  async (version) => {
    const s = state();
    const old = {
      ...s,
      cards: s.cards.map(({ flow_version: _version, ...card }) => ({
        ...card,
        ...(version === undefined ? {} : { flow_version: version }),
      })),
    };
    expect(
      (await prepareDelivery(old, actor(), params, verification())).ok,
    ).toBe(true);
  },
);

test.each([undefined, false])(
  "gate enabled=%s preserves delivery without a precheck",
  async (enabled) => {
    const s = {
      ...state(),
      project_settings:
        enabled === undefined ? {} : { merge_gate_enabled: enabled },
    };
    expect((await prepareDelivery(s, actor(), params, verification())).ok).toBe(
      true,
    );
  },
);

test.each([
  { kind: "doc_version", value: "v1" },
  { kind: "artifact_sha256", value: "a".repeat(64) },
] as const)("non-Git $kind delivery needs no precheck", async (subject) => {
  expect(
    (
      await prepareDelivery(
        state(),
        actor(),
        { ...params, subject },
        verification(),
      )
    ).ok,
  ).toBe(true);
});

test("SHA-256 Git subjects require their exact digest too", async () => {
  const sha = "a".repeat(64);
  const p = { ...params, subject: { ...subject, value: sha } };
  expect(
    await prepareDelivery(state([passed()]), actor(), p, verification()),
  ).toEqual(denied);
  expect(
    (
      await prepareDelivery(
        state([passed({ payload: { head_sha: sha, status: "passed" } })]),
        actor(),
        p,
        verification(),
      )
    ).ok,
  ).toBe(true);
});

test.each(["lost pass", "gate enabled", "card upgraded"])(
  "the write transaction rechecks eligibility after preparation: %s",
  async (change) => {
    const s = state([passed()]);
    const prepared = {
      ...s,
      ...(change === "gate enabled"
        ? { project_settings: { merge_gate_enabled: false } }
        : {}),
      ...(change === "card upgraded"
        ? { cards: s.cards.map((card) => ({ ...card, flow_version: 2 })) }
        : {}),
    };
    const proof = value(
      await prepareDelivery(prepared, actor(), params, verification()),
    );
    expect(
      submitDelivery({ ...s, events: [] }, actor(), params, proof, ports()),
    ).toEqual(denied);
    expect(s.deliveries).toEqual([]);
  },
);

test("recheck composition observes the same delivery gate in both phases", async () => {
  const { f } = await returnedRecheckFixture();
  const s: CommandState = {
    ...f.state,
    cards: f.state.cards.map((card) => ({ ...card, flow_version: 3 })),
    project_settings: { merge_gate_enabled: true },
  };
  const p = { card_id: f.card.id, reason: "合成的无关失败" };
  expect(
    await prepareRecheck(s, f.actor(f.coder), p, recheckVerifier()),
  ).toEqual(denied);
  const allowed = {
    ...s,
    events: [...s.events, passed({ card_id: f.card.id })],
  };
  const proof = value(
    await prepareRecheck(allowed, f.actor(f.coder), p, recheckVerifier()),
  );
  expect(requestRecheck(s, f.actor(f.coder), p, proof, f.io)).toEqual(denied);
  expect(requestRecheck(allowed, f.actor(f.coder), p, proof, f.io).ok).toBe(
    true,
  );
});
