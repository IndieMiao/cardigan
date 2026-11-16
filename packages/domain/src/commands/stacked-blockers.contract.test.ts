import { expect, test } from "vitest";
import {
  type CommandEffect,
  completeHumanAction,
  prepareDelivery,
  recordDecision,
  reportBlocker,
  requestDecision,
  requestHumanAction,
  submitDelivery,
} from "../index.js";
import {
  actor,
  apply,
  fixture,
  human,
  id,
  ports,
  subject,
  value,
} from "./test-fixtures.js";

const TEST_PLAIN_SUMMARY = {
  changed: "测试用的改动说明",
  impact: "测试用的影响说明",
  risk: "无",
};

const cases = ["produce", "verify"].flatMap((kind) =>
  ["human", "decision"].flatMap((first) =>
    ["human", "decision"].map((clearFirst) => ({ kind, first, clearFirst })),
  ),
);
test.each(cases)(
  "invariants 8, 10, 11, 12: $kind stacks $first first and clears $clearFirst first without resuming early",
  async ({ kind, first, clearFirst }) => {
    const io = ports();
    let state = fixture();
    const commit = <T>(effect: CommandEffect<T>) => {
      state = apply(state, effect);
      return effect;
    };
    if (kind === "verify") {
      const params = {
        work_item_id: id("work_item", 1),
        kind: "code" as const,
        summary: "Ready",
        subject,
        requested_verifiers: [id("work_item", 2)],
      };
      const receipt = value(
        await prepareDelivery(state, actor(), params, {
          verify: async () => ({ ok: true, value: [] }),
        }),
      );
      commit(value(submitDelivery(state, actor(), params, receipt, io)));
    }
    const n = kind === "produce" ? 1 : 2;
    const work_item_id = id("work_item", n);
    const caller = actor(n, kind === "produce" ? "coder" : "reviewer");
    const paused = first === "human" ? "blocked" : "waiting_decision";
    const workStatus = () =>
      state.work_items.find((w) => w.id === work_item_id)?.status;
    const originalAssignments = state.assignments;
    const originalRunCount = state.runs.length;
    for (const reason of [first, first === "human" ? "decision" : "human"]) {
      if (reason === "human")
        commit(
          value(
            requestHumanAction(
              state,
              caller,
              {
                card_id: id("card", 1),
                instructions: "Connect device",
                why_human: "Physical access",
                expected_return: "Connected",
                blocks_merge: true,
                prerequisite: "external_account" as const,
                blocked_work_items: [work_item_id],
              },
              io,
            ),
          ),
        );
      else
        commit(
          value(
            requestDecision(
              state,
              caller,
              {
                card_id: id("card", 1),
                kind: "choose",
                category: "general",
                question: "Continue?",
                context: "Need a choice",
                options: [
                  {
                    key: "go",
                    description: "Continue",
                    impact: "Unblocks work",
                  },
                ],
                recommended: "go",
                affected_cards: [id("card", 1)],
                affected_work_items: [work_item_id],
                blocking: true,
                decider: "human",
                plain_summary: TEST_PLAIN_SUMMARY,
              },
              io,
            ),
          ),
        );
      expect(workStatus()).toBe(paused);
      expect(state.runs).toHaveLength(originalRunCount);
    }
    const action = state.human_actions[0];
    const decision = state.decisions[0];
    if (!action || !decision) throw new Error("Missing stacked reasons");
    const ended = state.runs.find((r) => r.id === id("run", n));
    expect(ended).toMatchObject({ status: "completed", outcome: "blocked" });
    const clear = (reason: string) =>
      reason === "human"
        ? commit(
            value(
              completeHumanAction(
                state,
                human,
                { human_action_id: action.id, text: "Connected" },
                io,
              ),
            ),
          )
        : commit(
            value(
              recordDecision(
                state,
                human,
                {
                  decision_id: decision.id,
                  option: "go",
                  rationale: "Confirmed",
                  raw_quote: "go",
                },
                io,
              ),
            ),
          );
    const partial = clear(clearFirst);
    expect(workStatus()).toBe(paused);
    expect(partial.events[0]?.payload).toMatchObject({ resume_work_items: [] });
    expect(state.runs).toHaveLength(originalRunCount);
    const final = clear(clearFirst === "human" ? "decision" : "human");
    expect(workStatus()).toBe(
      kind === "verify" && paused === "waiting_decision"
        ? "ready"
        : "in_progress",
    );
    expect(final.events[0]?.payload).toMatchObject({
      resume_work_items: [work_item_id],
    });
    expect(state.assignments).toEqual(originalAssignments);
    expect(state.runs.find((r) => r.id === id("run", n))).toEqual(ended);
    expect(state.runs).toHaveLength(originalRunCount + 1);
    expect(state.runs.filter((r) => r.status === "queued")).toEqual([
      expect.objectContaining({
        assignment_id: id("assignment", n),
        trigger_event_id: final.events[0]?.id,
        kind: paused === "waiting_decision" ? "decision_resumed" : "followup",
        role_version: 1,
        model: "fixture-model",
        agent_cli_version: "1.0",
      }),
    ]);
  },
);

test("invariant 11: recording a nonblocking decision does not clear a role blocker", () => {
  const io = ports();
  const initial = fixture();
  const reported = value(
    reportBlocker(
      initial,
      actor(),
      {
        work_item_id: id("work_item", 1),
        reason: "Waiting for a role",
        needs: "role",
      },
      io,
    ),
  );
  let state = apply(initial, reported);
  const requested = value(
    requestDecision(
      state,
      actor(),
      {
        card_id: id("card", 1),
        kind: "choose",
        category: "general",
        question: "Suggestion?",
        context: "Nonblocking choice",
        options: [{ key: "go", description: "Record", impact: "None" }],
        recommended: "go",
        affected_cards: [id("card", 1)],
        affected_work_items: [id("work_item", 1)],
        blocking: false,
        decider: "human",
        plain_summary: TEST_PLAIN_SUMMARY,
      },
      io,
    ),
  );
  state = apply(state, requested);
  const result = value(
    recordDecision(
      state,
      human,
      {
        decision_id: requested.data.id,
        option: "go",
        rationale: "Recorded",
        raw_quote: "go",
      },
      io,
    ),
  );
  const after = apply(state, result);
  expect(
    after.work_items.find((w) => w.id === id("work_item", 1))?.status,
  ).toBe("blocked");
  expect(result.events[0]?.payload).toMatchObject({ resume_work_items: [] });
  expect(after.runs).toEqual(state.runs);
});
