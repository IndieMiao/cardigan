import { expect, test } from "vitest";
import {
  type CommandEffect,
  completeHumanAction,
  finishRun,
  recordDecision,
  reportBlocker,
  requestDecision,
  requestHumanAction,
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
  value,
} from "./test-fixtures.js";

const cases = ["produce", "verify"].flatMap((kind) =>
  ["decision", "human"].flatMap((other) =>
    [false, true].flatMap((reportFirst) =>
      [false, true].map((confirmFirst) => ({
        kind,
        other,
        reportFirst,
        confirmFirst,
      })),
    ),
  ),
);
test.each(cases)(
  "invariants 10, 11, 12: $kind report and $other (reportFirst=$reportFirst, confirmFirst=$confirmFirst) clear independently",
  ({ kind, other, reportFirst, confirmFirst }) => {
    const io = ports();
    let state = fixture();
    const commit = <T>(effect: CommandEffect<T>) => {
      state = apply(state, effect);
      return effect;
    };
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
    expect(state.runs.filter((r) => r.status === "queued")).toEqual([
      expect.objectContaining({
        assignment_id: id("assignment", n),
        trigger_event_id: last.events[0]?.id,
        role_version: 1,
        model: "fixture-model",
        agent_cli_version: "1.0",
      }),
    ]);
  },
);
