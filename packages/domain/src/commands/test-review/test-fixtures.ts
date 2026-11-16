import type {
  CommandEffect,
  CommandState,
  DeliveryVerifier,
  Result,
  SubmitDeliveryParams,
  TestReviewProof,
  TestReviewTrust,
} from "../../index.js";
import {
  acknowledgeRun,
  dispatchRun,
  finishRun,
  prepareDelivery,
  queueRun,
  submitDelivery,
  submitReview,
} from "../../index.js";
import {
  actor,
  apply,
  fixture,
  human,
  id,
  now,
  ports,
  role,
  value,
} from "../test-fixtures.js";

/** Synthetic trust port ONLY for state-machine contracts, never a production source. */
export async function testReviewFixture(limit = 1) {
  const io = ports();
  let valid = true;
  let proofEnabled = true;
  const trust: TestReviewTrust = {
    prepare: async (candidate) =>
      proofEnabled
        ? ({
            ...candidate,
            new_tree: "d".repeat(40),
            baseline_sha: "e".repeat(40),
            baseline_tree: "f".repeat(40),
            files: ["tests/assert.test.ts"],
            ranges: [
              {
                base: candidate.old_sha,
                head: candidate.new_sha,
                files: ["tests/assert.test.ts"],
              },
            ],
            baseline_merges: [],
            policy_boundary_generation: "policy-1",
            policy_digest: "1".repeat(64),
            policy_version: "v1",
            source_version: "closed-v1",
            input_digest: "2".repeat(64),
            isolation_generation: "generation-1",
            authority: "synthetic-contract-authority",
          } satisfies TestReviewProof)
        : undefined,
    isCurrent: () => valid,
  };
  const base = fixture();
  let state: CommandState = {
    ...base,
    test_review_trust: trust,
    roles: [...base.roles, role("independent_reviewer")],
    assignments: base.assignments.map((a) => ({
      ...a,
      employee_id: id("employee", Number(a.id.slice(2))),
      ...(a.id === id("assignment", 2)
        ? { role_id: "independent_reviewer" }
        : {}),
    })),
    employees: [1, 2, 3, 4].map((n) => ({
      id: id("employee", n),
      name: `Person ${n}`,
      title: "Engineer",
      bio: "",
      avatar: null,
      role_id: n === 2 ? "independent_reviewer" : n === 1 ? "coder" : "pm",
      launch_profile_ref: null,
      status: "active",
      created_at: now,
      updated_at: now,
    })),
    work_items: base.work_items.map((w) =>
      w.id === id("work_item", 2)
        ? { ...w, role_id: "independent_reviewer", max_review_rounds: limit }
        : w,
    ),
  };
  const verifier: DeliveryVerifier = {
    verify: async (s) => ({
      ok: true,
      value: [
        {
          kind: "commit",
          details: {
            sha: s.value,
            tree_sha:
              s.value === "a".repeat(40) ? "c".repeat(40) : "d".repeat(40),
          },
        },
      ],
    }),
  };
  function commit<T>(result: Result<CommandEffect<T>>) {
    const effect = value(result);
    state = apply(state, effect);
    return effect;
  }
  const params = (sha: string): SubmitDeliveryParams => ({
    work_item_id: id("work_item", 1),
    kind: "code",
    summary: "Ready",
    subject: { kind: "git_head", value: sha },
    requested_verifiers: [id("work_item", 2)],
  });
  async function deliver(sha = "b".repeat(40)) {
    const p = params(sha);
    return commit(
      submitDelivery(
        state,
        actor(),
        p,
        value(await prepareDelivery(state, actor(), p, verifier)),
        io,
      ),
    );
  }
  function review(issues: Parameters<typeof submitReview>[2]["issues"] = []) {
    const target = state.deliveries.find((v) => v.status === "submitted");
    if (!target) throw new Error("Missing target");
    return submitReview(
      state,
      actor(2, "independent_reviewer"),
      {
        delivery_id: target.id,
        target_sha: target.subject.value,
        kind: "code",
        issues,
      },
      io,
    );
  }
  function start() {
    const queued = commit(
      queueRun(
        state,
        human,
        {
          assignment_id: id("assignment", 2),
          model: "fixture",
          agent_cli_version: "1",
        },
        io,
      ),
    ).data;
    commit(
      dispatchRun(
        state,
        human,
        {
          run_id: queued.id,
          runtime_ref: {
            machine_id: "local",
            runtime_machine: "local",
            terminal_ref: "test",
            agent_name: "review",
          },
        },
        io,
      ),
    );
    return commit(
      acknowledgeRun(
        state,
        actor(2, "independent_reviewer"),
        { run_id: queued.id },
        io,
      ),
    ).data;
  }
  const first = (await deliver("a".repeat(40))).data;
  const passed = commit(review()).data;
  commit(
    finishRun(
      state,
      actor(2, "independent_reviewer"),
      { run_id: id("run", 2), outcome: "completed", summary: "Finished" },
      io,
    ),
  );
  return {
    get state() {
      return state;
    },
    set state(s: CommandState) {
      state = s;
    },
    io,
    trust,
    verifier,
    params,
    first,
    passed,
    commit,
    deliver,
    start,
    review,
    revoke() {
      valid = false;
    },
    disableProof() {
      proofEnabled = false;
    },
  };
}
