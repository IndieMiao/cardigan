// Scenario setup uses public commands and repositories only; no production test fixtures.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Actor,
  type Assignment,
  acknowledgeRun,
  assign,
  type CardId,
  type CommandEffect,
  type CommandPorts,
  type CommandState,
  createCard,
  createWorkItem,
  dispatchRun,
  type Event,
  finishRun,
  type JsonValue,
  type ProjectId,
  postComment,
  prepareDelivery,
  queueRun,
  type Result,
  submitDelivery,
  submitReview,
  type WorkItem,
} from "@cardigan/domain";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import { Store, writeRole } from "@cardigan/store";

const TEST_PLAIN_SUMMARY = {
  changed: "测试用的改动说明",
  impact: "测试用的影响说明",
  risk: "无",
};

export function m3Fixture(
  project = "m3-acceptance",
  shared?: Store,
  assignVerifiersAsPm = false,
) {
  const dataDir = shared
    ? undefined
    : mkdtempSync(join(tmpdir(), "cg-m3-acceptance-"));
  let time = Date.parse("2031-01-01T00:00:00.000Z");
  const clock = { now: () => new Date(time).toISOString() },
    id = project as ProjectId;
  const store =
    shared ?? Store.open({ ...(dataDir ? { dataDir } : {}), clock });
  unwrap(store.createProject({ id, name: "Cross acceptance" }));
  const human: Actor = { kind: "human", project_id: id };
  const state = () => store.uow.read((tx) => loadCommandState(tx, id));
  function apply<T>(
    command: (
      s: CommandState,
      actor: Actor,
      ports: CommandPorts,
    ) => Result<CommandEffect<T>>,
    actor: Actor = human,
  ) {
    return store.uow.run((tx) => {
      const result = unwrap(
        command(loadCommandState(tx, id), actor, { clock, ids: tx.ids }),
      );
      persistEffect(tx, id, result);
      return result;
    });
  }
  for (const role_id of ["coder", "reviewer", "pm"])
    store.uow.run((tx) =>
      writeRole(
        tx,
        id,
        {
          role_id,
          version: 1,
          display_name: role_id,
          kind: "work",
          harness: "pi",
          launch_profile_ref: "acceptance",
          core_prompt: "Test role",
          abilities: [],
          worktree: "none",
          required_machine_tags: [],
          capabilities: ["code", "review", "manage"],
          allowed_tools: [
            "post_comment",
            ...(role_id === "pm" && assignVerifiersAsPm
              ? ["assign" as const]
              : []),
            "submit_delivery",
            "submit_review",
            "request_decision",
            "record_decision",
            "request_human_action",
            "finish_run",
            "get_updates",
            "ack_events",
          ],
        },
        { mode: "add" },
      ),
    );
  const card = apply((s, a, p) =>
    createCard(
      s,
      a,
      {
        title: "Ship feature",
        goal: "Deliver reviewed work",
        acceptance_criteria: ["all verifiers pass"],
        source: { kind: "quote", text: "acceptance scenario" },
        repo: "fixture/repo",
        base_branch: "main",
      },
      p,
    ),
  ).data;
  const items = state().work_items;
  const pmAssigner: Actor = assignVerifiersAsPm
    ? store.uow.run((tx) => {
        const owner: Assignment = {
          id: tx.ids.next(id, "assignment"),
          scope: "standing",
          standing_mode: "ops",
          role_id: "pm",
          role_version: 1,
          status: "active",
          runtime_state: "not_provisioned",
          machine_id: "local",
          runtime_ref: null,
          mcp_token_id: "fixture-pm",
          created_at: clock.now(),
        };
        tx.assignments.put(id, owner);
        const role = tx.roles.get(id, { role_id: "pm", role_version: 1 });
        if (!role) throw new Error("Missing PM role");
        return {
          ...role,
          kind: "assignment",
          assignment_id: owner.id,
          project_id: id,
        };
      })
    : human;
  const assignItem = (w: WorkItem) =>
    apply(
      (s, a, p) => assign(s, a, { work_item_id: w.id, role_id: w.role_id }, p),
      w.kind === "verify" ? pmAssigner : human,
    ).data;
  const produce = items.find((w) => w.kind === "produce"),
    verify = items.find((w) => w.kind === "verify" && w.role_id !== "pm"),
    acceptance = items.find((w) => w.role_id === "pm");
  if (!produce || !verify || !acceptance)
    throw new Error("Development template lacks required work items");
  const coder = assignItem(produce),
    reviewer = assignItem(verify),
    pm = assignItem(acceptance);
  const actor = (a: Assignment): Actor => {
    const role = state().roles.find(
      (r) => r.role_id === a.role_id && r.role_version === a.role_version,
    );
    if (!role) throw new Error("Missing role snapshot");
    return { ...role, kind: "assignment", assignment_id: a.id, project_id: id };
  };
  const start = (a: Assignment) => {
    const run =
      state().runs.find(
        (r) => r.assignment_id === a.id && r.status === "queued",
      ) ??
      apply((s, who, p) =>
        queueRun(
          s,
          who,
          {
            assignment_id: a.id,
            model: "test-model",
            agent_cli_version: "test-cli",
          },
          p,
        ),
      ).data;
    const current = state().assignments.find((v) => v.id === a.id);
    apply((s, who, p) =>
      dispatchRun(
        s,
        who,
        {
          run_id: run.id,
          ...(current?.runtime_ref
            ? {}
            : {
                runtime_ref: {
                  machine_id: "local",
                  runtime_machine: "local",
                  terminal_ref: a.id,
                  agent_name: a.id,
                },
              }),
        },
        p,
      ),
    );
    return apply(
      (s, who, p) => acknowledgeRun(s, who, { run_id: run.id }, p),
      actor(a),
    ).data;
  };
  const finish = (a: Assignment) => {
    const run = state().runs.find(
      (r) => r.assignment_id === a.id && r.status === "running",
    );
    if (!run) throw new Error("Missing active Run");
    return apply(
      (s, who, p) =>
        finishRun(
          s,
          who,
          { run_id: run.id, outcome: "completed", summary: "Finished" },
          p,
        ),
      actor(a),
    );
  };
  const comment = (
    who: Actor = human,
    work_item_id?: WorkItem["id"],
    mentions: readonly string[] = [],
  ) =>
    apply(
      (s, a, p) =>
        postComment(
          s,
          a,
          {
            card_id: card.id,
            body: "Scenario comment",
            ...(work_item_id ? { work_item_id } : {}),
            mentions,
          },
          p,
        ),
      who,
    ).events[0] as Event;
  const fact = (
    type: string,
    payload: JsonValue,
    card_id: CardId | undefined = card.id,
  ): Event =>
    store.uow.run((tx) => {
      const event: Event = {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(id, card_id),
        ...(card_id ? { card_id } : {}),
        type,
        payload,
        actor: human,
        created_at: clock.now(),
      };
      tx.events.append(id, event);
      return event;
    });
  const delivery = async (kind: "code" | "card_completion" = "code") => {
    const params = {
      work_item_id: produce.id,
      kind,
      ...(kind === "card_completion"
        ? { plain_summary: TEST_PLAIN_SUMMARY }
        : {}),
      summary: "Ready for review",
      subject: { kind: "git_head" as const, value: "a".repeat(40) },
      requested_verifiers: [kind === "code" ? verify.id : acceptance.id],
    };
    const proof = unwrap(
      await prepareDelivery(state(), actor(coder), params, {
        verify: async () => ({ ok: true, value: [] }),
      }),
    );
    return apply(
      (s, a, p) => submitDelivery(s, a, params, proof, p),
      actor(coder),
    );
  };
  const review = (
    delivery_id: Parameters<typeof submitReview>[2]["delivery_id"],
    reject = false,
    a = reviewer,
  ) =>
    apply(
      (s, who, p) =>
        submitReview(
          s,
          who,
          {
            delivery_id,
            target_sha: "a".repeat(40),
            kind: "code",
            issues: reject
              ? [
                  {
                    severity: "major",
                    description: "Incorrect output",
                    must_fix: true,
                    pre_existing: false,
                  },
                ]
              : [],
          },
          p,
        ),
      actor(a),
    );
  const extra = (role_id: string, depends_on: readonly WorkItem["id"][] = []) =>
    apply((s, a, p) =>
      createWorkItem(
        s,
        a,
        {
          card_id: card.id,
          title: "Follow-on work",
          kind: "produce",
          role_id,
          required: false,
          completion_criteria: ["complete"],
          depends_on,
        },
        p,
      ),
    ).data;
  const office = () =>
    store.uow.run((tx) => {
      const { work_item_id: _work, ...base } = pm;
      const a: Assignment = {
        ...base,
        id: tx.ids.next(id, "assignment"),
        scope: "standing",
      };
      tx.assignments.put(id, a);
      return a;
    });
  return {
    office,
    dataDir,
    store,
    id,
    human,
    clock,
    state,
    apply,
    card,
    produce,
    verify,
    acceptance,
    coder,
    reviewer,
    pm,
    actor,
    assignItem,
    start,
    finish,
    comment,
    fact,
    delivery,
    review,
    extra,
    advance: (ms: number) => {
      time += ms;
    },
    close: () => {
      if (dataDir) {
        store.close();
        rmSync(dataDir, { recursive: true, force: true });
      }
    },
  };
}
