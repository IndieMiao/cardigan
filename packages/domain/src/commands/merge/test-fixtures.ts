import type {
  Actor,
  Assignment,
  CommandEffect,
  CommandState,
  Delivery,
  Result,
} from "../../index.js";
import {
  acknowledgeRun,
  assign,
  createCard,
  developmentCardTemplate,
  dispatchRun,
  finishRun,
  prepareDelivery,
  queueRun,
  submitDelivery,
  submitReview,
} from "../../index.js";
import { apply, human, ports, role, value } from "../test-fixtures.js";

/** Real create/assign/launch transitions; no pre-seeded in_progress entities. */
export function mergeFixture(policy: "confirm" | "auto" = "confirm") {
  const io = {
    ...ports(),
    templates: [{ ...developmentCardTemplate, merge: policy }],
  };
  let state: CommandState = {
    project_id: human.project_id,
    roles: [role("coder"), role("reviewer"), role("pm")],
    cards: [],
    work_items: [],
    assignments: [],
    runs: [],
    deliveries: [],
    reviews: [],
    decisions: [],
    human_actions: [],
    attachments: [],
    cursors: [],
    timeline: [],
    events: [],
  };
  function commit<T>(r: Result<CommandEffect<T>>) {
    const e = value(r);
    state = apply(state, e);
    return e.data;
  }
  const card = commit(
    createCard(
      state,
      human,
      {
        title: "Merge",
        goal: "Ship",
        acceptance_criteria: ["Works"],
        source: { kind: "quote", text: "Build" },
        repo: "fixture",
        base_branch: "main",
      },
      io,
    ),
  );
  const owners = state.work_items.map((w) =>
    commit(
      assign(state, human, { work_item_id: w.id, role_id: w.role_id }, io),
    ),
  );
  const coder = owners[0] as Assignment,
    reviewer = owners[1] as Assignment,
    pm = owners[2] as Assignment;
  const actor = (a: Assignment): Actor => ({
    kind: "assignment",
    project_id: state.project_id,
    assignment_id: a.id,
    ...role(a.role_id),
  });
  function start(a: Assignment) {
    for (const r of state.runs.filter(
      (r) => r.assignment_id === a.id && r.status === "running",
    ))
      commit(
        finishRun(
          state,
          actor(a),
          { run_id: r.id, outcome: "completed", summary: "Finished" },
          io,
        ),
      );
    const queued =
      state.runs.find(
        (r) => r.assignment_id === a.id && r.status === "queued",
      ) ??
      commit(
        queueRun(
          state,
          human,
          {
            assignment_id: a.id,
            model: "fixture-model",
            agent_cli_version: "1",
          },
          io,
        ),
      );
    commit(
      dispatchRun(
        state,
        human,
        {
          run_id: queued.id,
          runtime_ref: {
            machine_id: "local",
            runtime_machine: "local",
            terminal_ref: `terminal-${a.id}`,
            agent_name: a.role_id,
          },
        },
        io,
      ),
    );
    commit(acknowledgeRun(state, actor(a), { run_id: queued.id }, io));
  }
  async function deliver(
    kind: Delivery["kind"] = "code",
    sha = "a".repeat(40),
    git = true,
    known_gaps: Delivery["known_gaps"] = [],
  ) {
    start(coder);
    const p = {
      work_item_id: coder.work_item_id as Delivery["work_item_id"],
      kind,
      summary: "Ready",
      known_gaps,
      subject: {
        kind: git ? ("git_head" as const) : ("doc_version" as const),
        value: sha,
      },
      requested_verifiers: [
        (kind === "card_completion" ? pm : reviewer)
          .work_item_id as Delivery["work_item_id"],
      ],
    };
    const proof = value(
      await prepareDelivery(state, actor(coder), p, {
        verify: async () => ({ ok: true, value: [] }),
      }),
    );
    return commit(submitDelivery(state, actor(coder), p, proof, io));
  }
  function review(v: Delivery) {
    const a = v.kind === "card_completion" ? pm : reviewer;
    start(a);
    return commit(
      submitReview(
        state,
        actor(a),
        {
          delivery_id: v.id,
          target_sha: v.subject.value,
          kind: v.kind === "card_completion" ? "product" : "code",
          issues: [],
        },
        io,
      ),
    );
  }
  async function accept(git = true) {
    const product = await deliver(git ? "code" : "doc", "a".repeat(40), git);
    review(product);
    const completion = await deliver(
      "card_completion",
      product.subject.value,
      git,
    );
    review(completion);
    return { product, completion };
  }
  return {
    get state() {
      return state;
    },
    io,
    card,
    coder,
    reviewer,
    pm,
    actor,
    commit,
    start,
    deliver,
    review,
    accept,
  };
}
