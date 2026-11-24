import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  postComment,
  sharedMustFixes,
  submitReview,
  updateWorkItem,
} from "@cardigan/domain";
import { loadCommandState, persistEffect } from "@cardigan/mcp-server";
import { Store } from "@cardigan/store";
import { onTestFinished } from "vitest";
import {
  first,
  sharedReviewFixture,
} from "../../../packages/domain/src/commands/shared-review/test-fixtures.js";
import {
  actor,
  id,
  now,
  value,
} from "../../../packages/domain/src/commands/test-fixtures.js";

export async function sharedRepairStore() {
  const { state, target } = await sharedReviewFixture(1, [first], 2);
  const project = state.project_id,
    owner = id("assignment", 1);
  let ms = Date.parse(now);
  const clock = { now: () => new Date(ms).toISOString() };
  const dir = mkdtempSync(join(tmpdir(), "cg-review-retry-"));
  const store = Store.open({ dataDir: dir, clock });
  onTestFinished(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  store.createProject({ id: project });
  store.uow.run((tx) => {
    // The domain fixture already owns numbered entities; reserve their IDs.
    for (const kind of ["run", "review", "delivery", "decision"] as const)
      for (let i = 0; i < 128; i++) tx.ids.next(project, kind);
    for (const c of state.cards) tx.cards.put(project, c);
    // C-610: this lane's alignment round was already disputed, so its third
    // rejection keeps the PM path these repair scenarios exercise.
    for (const w of state.work_items)
      tx.work_items.put(
        project,
        w.kind === "verify" && w.id === id("work_item", 3)
          ? {
              ...w,
              review_alignment: {
                review_id: id("review", 31),
                status: "disputed",
              },
            }
          : w,
      );
    for (const r of state.roles) tx.roles.put(project, r);
    for (const r of state.reviews) tx.reviews.put(project, r);
    for (const d of state.deliveries) tx.deliveries.put(project, d);
    for (const a of state.assignments)
      tx.assignments.put(
        project,
        a.id !== owner
          ? a
          : {
              ...a,
              runtime_ref: {
                machine_id: "local",
                runtime_machine: "local",
                terminal_ref: "fixture",
                agent_name: "fixture",
              },
            },
      );
    for (const r of state.runs)
      tx.runs.put(
        project,
        r.assignment_id !== owner
          ? r
          : {
              ...r,
              status: "completed",
              started_at: now,
              outcome: "completed",
            },
      );
    for (const e of state.events) {
      tx.ids.nextEventSequence(project, e.card_id);
      tx.events.append(project, e);
    }
  });
  const read = () => store.uow.read((tx) => loadCommandState(tx, project));
  const reject = (n: 2 | 3) =>
    store.uow.run((tx) => {
      const s = loadCommandState(tx, project);
      const refs = sharedMustFixes(s.reviews, s.deliveries, s.work_items).map(
        (i) => i.finding_id,
      );
      const effect = value(
        submitReview(
          s,
          actor(n, n === 2 ? "reviewer" : "independent_reviewer"),
          {
            delivery_id: target.id,
            target_sha: target.subject.value,
            kind: "code",
            issues: n === 2 ? [first] : [],
            issue_refs: n === 2 ? [] : refs,
            pass_conditions: [{ description: "补上校验", basis: "AC1" }],
          },
          { clock, ids: tx.ids },
        ),
      );
      persistEffect(tx, project, effect);
      return effect.events.find((e) => e.type === "review_submitted");
    });
  const decide = (option: "pause" | "raise_limit") =>
    store.uow.run((tx) => {
      const s = loadCommandState(tx, project),
        q = s.decisions[0];
      if (!q) throw Error("Missing review limit");
      const effect = value(
        updateWorkItem(
          s,
          actor(4, "pm"),
          {
            work_item_id: id("work_item", 3),
            review_limit_decision: {
              decision_id: q.id,
              option,
              rationale: "fixture",
              ...(option === "pause"
                ? {
                    pause_plan: {
                      owner,
                      confirmers: [id("assignment", 2), id("assignment", 3)],
                      next_step: "提交方案",
                    },
                  }
                : {}),
            },
          },
          { ids: tx.ids, clock },
        ),
      );
      persistEffect(tx, project, effect);
      return effect.events.find((e) => e.type === "decision_resolved");
    });
  const confirm = () => {
    const entry = (
      n: number,
      step: "propose" | "confirm",
      reply_to?: import("@cardigan/domain").TimelineEntryId,
    ) =>
      store.uow.run((tx) => {
        const state = loadCommandState(tx, project);
        const q = state.decisions[0];
        if (!q?.card_id) throw Error("Missing pause");
        const effect = value(
          postComment(
            state,
            n === 1
              ? actor()
              : actor(n, n === 2 ? "reviewer" : "independent_reviewer"),
            {
              card_id: q.card_id,
              body: "核对方案",
              review_plan: { decision_id: q.id, step },
              ...(reply_to ? { reply_to } : {}),
            },
            { ids: tx.ids, clock },
          ),
        );
        persistEffect(tx, project, effect);
        return effect.data;
      });
    const p = entry(1, "propose");
    entry(2, "confirm", p?.id);
    entry(3, "confirm", p?.id);
  };
  const e = reject(2);
  if (!e?.card_id) throw Error("Missing first rejection");
  store.advanceRouterCursor(project, e.card_id, e.seq - 1);
  return {
    store,
    project,
    clock,
    dataDir: dir,
    target,
    read,
    owner,
    advance: (delay: number) => {
      ms += delay;
    },
    pause: () => {
      reject(3);
      decide("pause");
    },
    confirm,
    release: () => decide("raise_limit"),
    resume: () => {
      confirm();
      return decide("raise_limit");
    },
  };
}
