import { expect, test } from "vitest";
import {
  currentMergeConfirmations,
  latestMergeCheck,
  type MergeCheckView,
  recheckMerge,
  recordDecision,
  recordMergeCheck,
  upgradeCardFlow,
} from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import { human, value } from "./test-fixtures.js";

async function setup(retry: "none" | "manual" | "automatic") {
  const f = mergeFixture("confirm");
  const { completion } = await f.accept();
  const state = () => ({
    ...f.state,
    project_settings: { merge_gate_enabled: true },
  });
  const identity = {
    card_id: f.card.id,
    completion_id: completion.id,
    candidate_sha: "b".repeat(40),
    tree_sha: "c".repeat(40),
  };
  const record = (
    attempt_id: string,
    status: Exclude<MergeCheckView["status"], "executor_unreachable">,
    timeout_only = false,
  ) =>
    f.commit(
      recordMergeCheck(
        state(),
        { kind: "system", project_id: state().project_id },
        status === "queued" || status === "running"
          ? { ...identity, attempt_id, status }
          : {
              ...identity,
              attempt_id,
              status,
              summary: "Synthetic result",
              log_ref: `${attempt_id}.log`,
              checks: [
                {
                  name: "test",
                  status,
                  exit_code: status === "passed" ? 0 : 1,
                },
              ],
              ...(timeout_only ? { timeout_only: true } : {}),
            },
        f.io,
      ),
    );
  const returnForChanges = () => {
    const decision = currentMergeConfirmations(state(), f.card.id)[0];
    if (!decision) throw new Error("Missing confirmation");
    f.commit(
      recordDecision(
        state(),
        human,
        {
          decision_id: decision.id,
          option: "request_changes",
          rationale: "Synthetic return for changes",
          raw_quote: "Fix first",
        },
        f.io,
      ),
    );
    expect(f.state.cards.find((c) => c.id === f.card.id)?.status).toBe(
      "in_progress",
    );
    expect(f.state.deliveries.find((d) => d.id === completion.id)?.status).toBe(
      "superseded",
    );
  };
  record("original", "queued");
  record("original", "running");
  record(
    "original",
    retry === "automatic" ? "timed_out" : "failed",
    retry === "automatic",
  );
  if (retry === "manual")
    f.commit(recheckMerge(state(), human, { card_id: f.card.id }, f.io));
  if (retry !== "none")
    expect(
      latestMergeCheck(state().events, f.card.id, completion.id),
    ).toMatchObject({
      attempt_id: "original",
      status: "queued",
      recheck_requested: true,
    });
  const upgrade = () =>
    upgradeCardFlow(state(), human, { card_id: f.card.id, to: 1 }, f.io);
  return { f, completion, state, record, returnForChanges, upgrade };
}

test.each(["none", "manual", "automatic"] as const)(
  "completed %s retry permits flow adjustment after the completion is returned",
  async (retry) => {
    const t = await setup(retry);
    if (retry !== "none") {
      t.record("retry", "queued");
      t.record("retry", "running");
      t.record("retry", "failed");
    }
    t.returnForChanges();
    expect(
      latestMergeCheck(t.state().events, t.f.card.id, t.completion.id)?.status,
    ).toBe("failed");
    const effect = value(t.upgrade());
    expect(effect.changes).toEqual([]);
    expect(effect.events).toEqual([]);
    expect(effect.timeline).toEqual([]);
  },
);

test.each(["manual", "automatic"] as const)(
  "%s retry still blocks flow adjustment while requested, queued or running",
  async (retry) => {
    for (const stage of ["requested", "queued", "running"] as const) {
      const t = await setup(retry);
      if (stage !== "requested") t.record("retry", "queued");
      if (stage === "running") t.record("retry", "running");
      t.returnForChanges();
      expect(t.upgrade()).toMatchObject({
        ok: false,
        error: {
          code: "illegal_transition",
          message: "卡片有排队中或运行中的检查，不能变更流程版本",
        },
      });
    }
  },
);
