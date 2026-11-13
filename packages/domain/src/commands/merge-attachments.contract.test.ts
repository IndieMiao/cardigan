import { expect, test } from "vitest";
import {
  type Actor,
  type Assignment,
  type CommandState,
  createCard,
  MAX_DECISION_ATTACHMENTS,
  prepareAttachment,
  resolveDelegatedDecision,
  standingTools,
  submitReview,
  uploadAttachment,
} from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import { assignment, human, ports, role, value } from "./test-fixtures.js";

const TEST_PLAIN_SUMMARY = {
  changed: "测试用的改动说明",
  impact: "测试用的影响说明",
  risk: "无",
};

const { work_item_id: _work, ...base } = assignment(900, "pm");
const ops: Assignment = { ...base, scope: "standing", standing_mode: "ops" };
const opsActor: Actor = {
  kind: "assignment",
  project_id: human.project_id,
  assignment_id: ops.id,
  ...role("pm"),
  allowed_tools: standingTools(role("pm").allowed_tools, "ops"),
};

async function setup() {
  const empty: CommandState = {
    project_id: human.project_id,
    roles: [role("coder"), role("reviewer"), role("pm")],
    cards: [],
    work_items: [],
    assignments: [ops],
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
  const f = mergeFixture("confirm", 3, { state: empty, ports: ports() });
  const receipt = value(
    await prepareAttachment("a".repeat(64), new Uint8Array([1, 2]), {
      put: async () => ({ storage_path: "attachments/example" }),
      get: async () => undefined,
    }),
  );
  const upload = (mime = "image/png", card_id = f.card.id) => {
    const entry = f.state.timeline.find((e) => e.card_id === card_id);
    if (!entry) throw new Error("Missing card entry");
    return f.commit(
      uploadAttachment(
        f.state,
        human,
        {
          card_id,
          kind: "evidence",
          mime,
          attach_to: { kind: "timeline_entry", id: entry.id },
        },
        receipt,
        f.io,
      ),
    );
  };
  const confirmation = () => {
    const q = f.state.decisions
      .filter((q) => q.trigger === "merge_confirmation")
      .at(-1);
    if (!q) throw new Error("Missing merge confirmation");
    return q;
  };
  return { f, upload, confirmation };
}

test("§6 C-95: a merge confirmation shows the completion request's card attachments in order", async () => {
  const { f, upload, confirmation } = await setup();
  const product = await f.deliver();
  f.review(product);
  const shots = Array.from({ length: MAX_DECISION_ATTACHMENTS + 1 }, () =>
    upload(),
  );
  const ids = shots.map((a) => a.id).reverse();
  const completion = await f.deliver(
    "card_completion",
    product.subject.value,
    true,
    [],
    undefined,
    ids,
  );
  f.review(completion);
  expect(confirmation()).toMatchObject({
    trigger: "merge_confirmation",
    attachment_ids: ids.slice(0, MAX_DECISION_ATTACHMENTS),
  });
});

test("§6 C-125: a merge confirmation only includes the intersection of completion and own-card attachments", async () => {
  const { f, upload, confirmation } = await setup();
  const product = await f.deliver();
  f.review(product);
  const first = upload();
  const second = upload();
  upload(); // An own-card attachment not referenced by the completion.
  const other = f.commit(
    createCard(
      f.state,
      human,
      {
        title: "Other card",
        goal: "Keep attachments isolated",
        acceptance_criteria: ["Attachments stay on their card"],
        source: { kind: "quote", text: "Attachment isolation" },
        repo: "fixture",
        base_branch: "main",
      },
      f.io,
    ),
  );
  const foreign = upload("image/png", other.id);
  const completion = await f.deliver(
    "card_completion",
    product.subject.value,
    true,
    [],
    undefined,
    [second.id, first.id],
  );
  f.start(f.pm);
  // Submission rejects foreign attachments; seed a malformed stored request
  // to exercise the merge confirmation's independent isolation boundary.
  f.commit(
    submitReview(
      {
        ...f.state,
        deliveries: f.state.deliveries.map((d) =>
          d.id === completion.id
            ? { ...d, attachments: [foreign.id, ...d.attachments] }
            : d,
        ),
      },
      f.actor(f.pm),
      {
        delivery_id: completion.id,
        target_sha: completion.subject.value,
        kind: "product",
        issues: [],
      },
      f.io,
    ),
  );
  expect(confirmation()).toMatchObject({
    trigger: "merge_confirmation",
    target: { delivery_id: completion.id },
    attachment_ids: [second.id, first.id],
  });
});

test("§6 C-95: a merge confirmation without completion attachments keeps its shape", async () => {
  const { f, confirmation } = await setup();
  await f.accept();
  expect(confirmation()).not.toHaveProperty("attachment_ids");
});

test("§6 C-95: PM Ops can attach card images when handing a decision to the human, and only then", async () => {
  const { f, upload, confirmation } = await setup();
  await f.accept();
  const shot = upload();
  const q = confirmation();
  expect(q.decider).toBe("role:pm");
  const resolve = (extra: object) =>
    resolveDelegatedDecision(
      f.state,
      opsActor,
      { decision_id: q.id, option: "merge", rationale: "请看截图", ...extra },
      f.io,
    );
  for (const [extra, code] of [
    [{ attachment_ids: [shot.id] }, "validation_failed"],
    [{ escalate: true, attachment_ids: ["attachment-missing"] }, "not_found"],
    [
      { escalate: true, attachment_ids: [shot.id, shot.id] },
      "validation_failed",
    ],
  ] as const)
    expect(resolve(extra)).toMatchObject({ ok: false, error: { code } });
  expect(confirmation()).toEqual(q);
  f.commit(resolve({ escalate: true, attachment_ids: [shot.id] }));
  expect(confirmation()).toMatchObject({
    id: q.id,
    decider: "human",
    plain_summary: TEST_PLAIN_SUMMARY,
    attachment_ids: [shot.id],
  });
});
