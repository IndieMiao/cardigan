import {
  type CommandPorts,
  type CommandState,
  prepareDelivery,
  type SubmitDeliveryParams,
  submitDelivery,
  submitReview,
  updateCard,
} from "@cardigan/domain";
import {
  actor,
  apply,
  fixture,
  human,
  id,
  now,
  ports,
  role,
  subject,
  value,
} from "../../domain/src/commands/test-fixtures.js";

/** Changing acceptance criteria invalidates the already reused review. */
export async function requirementsReuseInvalidation(
  io: CommandPorts = ports(),
) {
  const base = fixture();
  let state: CommandState = {
    ...base,
    roles: [...base.roles, role("independent_reviewer")],
    work_items: base.work_items.map((w) => {
      if (w.id === id("work_item", 2))
        return { ...w, role_id: "independent_reviewer" };
      if (w.id !== id("work_item", 3)) return w;
      const { assignment_id: _old, ...rest } = w;
      return { ...rest, status: "todo" };
    }),
    assignments: base.assignments
      .filter((a) => a.id !== id("assignment", 3))
      .map((a) =>
        a.id === id("assignment", 2)
          ? { ...a, role_id: "independent_reviewer" }
          : a,
      ),
    runs: base.runs.filter((r) => r.id !== id("run", 3)),
    employees: [
      {
        id: id("employee", 3),
        name: "PM",
        title: "Acceptance",
        bio: "",
        avatar: null,
        role_id: "pm",
        launch_profile_ref: null,
        status: "active",
        created_at: now,
        updated_at: now,
      },
    ],
    project_preferences: [
      {
        id: base.project_id,
        system_auto_assign_verifiers: true,
        auto_merge_after_minutes: null,
      },
    ],
  };
  const params: SubmitDeliveryParams = {
    work_item_id: id("work_item", 1),
    kind: "code",
    summary: "Ready",
    subject,
    requested_verifiers: [id("work_item", 2)],
  };
  const deliver = async (p: SubmitDeliveryParams) => {
    const proof = value(
      await prepareDelivery(state, actor(), p, {
        verify: async () => ({
          ok: true,
          value: [
            {
              kind: "commit",
              details: { sha: subject.value, tree_sha: "c".repeat(40) },
            },
          ],
        }),
      }),
    );
    const effect = value(submitDelivery(state, actor(), p, proof, io));
    state = apply(state, effect);
    return effect;
  };
  const first = await deliver(params);
  state = apply(
    state,
    value(
      submitReview(
        state,
        actor(2, "independent_reviewer"),
        {
          delivery_id: first.data.id,
          target_sha: subject.value,
          kind: "code",
          issues: [],
        },
        io,
      ),
    ),
  );
  const reused = await deliver(params);
  const completion = await deliver({
    ...params,
    kind: "card_completion",
    plain_summary: { changed: "补齐实现", impact: "恢复审核流程", risk: "无" },
    requested_verifiers: [id("work_item", 3)],
  });
  const invalidation = value(
    updateCard(
      state,
      human,
      { card_id: id("card", 1), acceptance_criteria: ["Updated acceptance"] },
      io,
    ),
  );
  state = apply(state, invalidation);
  const event = invalidation.events.find(
    (e) => e.type === "review_reuse_invalidated",
  );
  if (!event) throw new Error("Missing requirements invalidation");
  const producer = state.assignments.find((a) => a.id === id("assignment", 1));
  if (!producer) throw new Error("Missing producer");
  return {
    state,
    event,
    completion,
    reused,
    producer,
  };
}
