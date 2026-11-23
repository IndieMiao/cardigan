import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Actor, createCard, submitReview } from "@cardigan/domain";
import { loadCommandState } from "@cardigan/mcp-server";
import { Store } from "@cardigan/store";
import { expect, test } from "vitest";
import {
  flowReviewFixture,
  required,
} from "../../../packages/domain/src/commands/flow-review-limit/test-fixtures.js";
import { human } from "../../../packages/domain/src/commands/test-fixtures.js";
import { routeProjectEvents } from "./dispatch-inbox.js";
import { runSystemRules } from "./system-rules.js";

/** A flow-5 card whose reviewer left simulator evidence pending on a platform card. */
async function pendingStore() {
  const { f } = flowReviewFixture(undefined, 5);
  const platform = required(
    f.commit(
      createCard(
        f.state,
        human,
        {
          title: "Platform entry",
          goal: "Fix the managed entry",
          acceptance_criteria: ["Entry works"],
          source: { kind: "quote", text: "Platform" },
          repo: "fixture",
          base_branch: "main",
        },
        f.io,
      ),
    ),
  );
  const delivery = await f.deliver();
  f.start(f.reviewer);
  const review = required(
    f.commit(
      submitReview(
        f.state,
        f.actor(f.reviewer),
        {
          delivery_id: delivery.id,
          target_sha: delivery.subject.value,
          kind: "code",
          issues: [],
          evidence_pending: {
            items: [{ description: "Simulator run", basis: "AC1" }],
            blocker: { kind: "card_merged", target_id: platform.id },
          },
        },
        f.io,
      ),
    ),
  );
  const state = f.state;
  const project = state.project_id;
  let ms = Date.parse(f.io.clock.now()) + 1000;
  const clock = { now: () => new Date(ms).toISOString() };
  const dir = mkdtempSync(join(tmpdir(), "cg-review-evidence-"));
  const store = Store.open({ dataDir: dir, clock });
  store.createProject({ id: project });
  store.uow.run((tx) => {
    for (const kind of ["run", "review", "delivery", "decision"] as const)
      for (let i = 0; i < 64; i++) tx.ids.next(project, kind);
    for (const m of state.machines ?? []) tx.machines.put(project, m);
    for (const r of state.roles) tx.roles.put(project, r);
    for (const c of state.cards) tx.cards.put(project, c);
    for (const w of state.work_items) tx.work_items.put(project, w);
    for (const a of state.assignments) tx.assignments.put(project, a);
    for (const r of state.runs) tx.runs.put(project, r);
    for (const v of state.deliveries) tx.deliveries.put(project, v);
    for (const r of state.reviews) tx.reviews.put(project, r);
    for (const e of state.events) {
      tx.ids.nextEventSequence(project, e.card_id);
      tx.events.append(project, e);
    }
  });
  const system: Actor = { kind: "system", project_id: project };
  const mergePlatform = () =>
    store.uow.run((tx) => {
      const card = required(tx.cards.get(project, platform.id));
      tx.cards.put(project, { ...card, status: "done" });
      tx.events.append(project, {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(project, platform.id),
        type: "card_merged",
        payload: { merge_sha: "f".repeat(40) },
        actor: system,
        card_id: platform.id,
        created_at: clock.now(),
      });
    });
  const tick = () => {
    ms += 1000;
    runSystemRules(store, project, clock);
    routeProjectEvents(store, project, { clock });
  };
  const read = () => store.uow.read((tx) => loadCommandState(tx, project));
  return {
    f,
    store,
    project,
    review,
    mergePlatform,
    tick,
    read,
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("C-618: the SQLite store keeps pending evidence; system rules notify the author once after the platform card merges", async () => {
  const s = await pendingStore();
  try {
    expect(
      s.read().reviews.find((r) => r.id === s.review.id)?.evidence_pending,
    ).toEqual(s.review.evidence_pending);
    s.tick();
    const unblocked = () =>
      s.read().events.filter((e) => e.type === "review_evidence_unblocked");
    expect(unblocked()).toHaveLength(0);
    s.mergePlatform();
    s.tick();
    s.tick();
    s.tick();
    expect(unblocked()).toHaveLength(1);
    const instruction = required(
      s
        .read()
        .events.find(
          (e) =>
            e.type === "instruction_issued" &&
            Array.isArray(
              (e.payload as { evidence_unblocked?: unknown })
                .evidence_unblocked,
            ),
        ),
    );
    const notices = s.store
      .listNotifications({ project_id: s.project })
      .filter((n) => n.event_id === instruction.id);
    expect(notices).toMatchObject([
      { recipient: { kind: "assignment", assignment_id: s.f.coder.id } },
    ]);
  } finally {
    s.close();
  }
});
