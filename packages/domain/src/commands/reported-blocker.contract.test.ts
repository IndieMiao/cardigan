import { expect, test } from "vitest";
import {
  type CommandEffect,
  completeHumanAction,
  finishRun,
  prepareDelivery,
  recordDecision,
  reportBlocker,
  requestDecision,
  requestHumanAction,
  submitDelivery,
  updateWorkItem,
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

const TEST_PLAIN_SUMMARY = {
  changed: "测试用的改动说明",
  impact: "测试用的影响说明",
  risk: "无",
};

const cases = ["produce", "verify"].flatMap((kind) =>
  (kind === "verify"
    ? ["missing", "current", "superseded"]
    : ["missing"]
  ).flatMap((target) =>
    ["decision", "human"].flatMap((other) =>
      [false, true].flatMap((reportFirst) =>
        [false, true].map((confirmFirst) => ({
          kind,
          other,
          reportFirst,
          confirmFirst,
          target,
        })),
      ),
    ),
  ),
);
test.each(cases)(
  "invariants 10, 11, 12: $kind report and $other (reportFirst=$reportFirst, confirmFirst=$confirmFirst) clear independently (target=$target)",
  async ({ kind, other, reportFirst, confirmFirst, target }) => {
    const io = ports();
    let state = fixture();
    const commit = <T>(effect: CommandEffect<T>) => {
      state = apply(state, effect);
      return effect;
    };
    if (target !== "missing") {
      const params = {
        work_item_id: id("work_item", 1),
        kind: "code" as const,
        summary: "Ready",
        subject,
        requested_verifiers: [id("work_item", 2)],
      };
      const proof = value(
        await prepareDelivery(state, actor(), params, {
          verify: async () => ({ ok: true, value: [] }),
        }),
      );
      commit(value(submitDelivery(state, actor(), params, proof, io)));
      if (target === "superseded")
        state = {
          ...state,
          deliveries: state.deliveries.map((d) => ({
            ...d,
            status: "superseded",
          })),
        };
    }
    const n = kind === "produce" ? 1 : 2;
    const work_item_id = id("work_item", n);
    const caller = actor(n, kind === "produce" ? "coder" : "reviewer");
    const work = () => state.work_items.find((w) => w.id === work_item_id);
    for (const reason of reportFirst ? ["report", other] : [other, "report"]) {
      if (reason === "report") {
        const params = {
          work_item_id,
          reason: "Waiting for input",
          needs: other === "human" ? ("human" as const) : ("role" as const),
          reported_by: "forged",
          reported_at: "forged",
        };
        commit(value(reportBlocker(state, caller, params, io)));
      } else if (reason === "decision")
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
                context: "Choice needed",
                options: [
                  { key: "go", description: "Continue", impact: "Unblocks" },
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
      else
        commit(
          value(
            requestHumanAction(
              state,
              caller,
              {
                card_id: id("card", 1),
                instructions: "Connect",
                why_human: "Device",
                expected_return: "Connected",
                blocks_merge: true,
                prerequisite: "external_account" as const,
                blocked_work_items: [work_item_id],
              },
              io,
            ),
          ),
        );
    }
    expect(work()?.reported_blocker).toEqual({
      reason: "Waiting for input",
      needs: other === "human" ? "human" : "role",
      reported_by: `assignment:A-${n}`,
      reported_at: now,
    });
    const paused = work()?.status;
    commit(
      value(
        finishRun(
          state,
          caller,
          { run_id: id("run", n), outcome: "blocked", summary: "Waiting" },
          io,
        ),
      ),
    );
    const ended = state.runs.find((r) => r.id === id("run", n));
    const confirm = () =>
      commit(
        value(
          updateWorkItem(
            state,
            reportFirst ? actor(4, "pm") : human,
            { work_item_id, status: "in_progress" },
            io,
          ),
        ),
      );
    const clearOther = (): CommandEffect<unknown> => {
      const action = state.human_actions[0];
      const decision = state.decisions[0];
      if (other === "human" && action)
        return commit(
          value(
            completeHumanAction(
              state,
              human,
              { human_action_id: action.id, text: "Done" },
              io,
            ),
          ),
        );
      if (!decision) throw new Error("Missing decision");
      return commit(
        value(
          recordDecision(
            state,
            actor(4, "pm"),
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
    };
    expect(
      updateWorkItem(
        state,
        caller,
        { work_item_id, status: "in_progress" },
        io,
      ),
    ).toMatchObject({ ok: false, error: { code: "forbidden_tool" } });
    const first = confirmFirst ? confirm() : clearOther();
    expect(work()?.status).toBe(paused);
    expect(Boolean(work()?.reported_blocker)).toBe(!confirmFirst);
    expect(first.events[0]?.payload).toMatchObject({ resume_work_items: [] });
    expect(state.runs.some((r) => r.status === "queued")).toBe(false);
    if (confirmFirst)
      expect(first.events[0]?.payload).toMatchObject({
        reported_blocker_cleared: true,
      });
    const last = confirmFirst ? clearOther() : confirm();
    expect(work()?.reported_blocker).toBeUndefined();
    expect(work()?.status).toBe(
      kind === "verify" && paused === "waiting_decision"
        ? "ready"
        : "in_progress",
    );
    expect(last.events[0]?.payload).toMatchObject({
      resume_work_items: [work_item_id],
    });
    expect(state.runs.find((r) => r.id === id("run", n))).toEqual(ended);
    expect(state.runs.filter((r) => r.status === "queued")).toEqual(
      kind === "verify" && target !== "current"
        ? []
        : [
            expect.objectContaining({
              assignment_id: id("assignment", n),
              trigger_event_id: last.events[0]?.id,
              role_version: 1,
              model: "fixture-model",
              agent_cli_version: "1.0",
            }),
          ],
    );
  },
);
