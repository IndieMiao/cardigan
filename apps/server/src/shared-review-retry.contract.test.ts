import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acknowledgeRun,
  type Runtime,
  sharedMustFixes,
  submitReview,
  updateWorkItem,
} from "@cardigan/domain";
import { loadCommandState, persistEffect } from "@cardigan/mcp-server";
import { beginDispatchRetry, listBellAttempts, Store } from "@cardigan/store";
import { expect, onTestFinished, test, vi } from "vitest";
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
import { Dispatcher } from "./dispatch.js";

async function fixture() {
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
    for (const w of state.work_items) tx.work_items.put(project, w);
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
            },
          },
          { ids: tx.ids, clock },
        ),
      );
      persistEffect(tx, project, effect);
      return effect.events.find((e) => e.type === "decision_resolved");
    });
  const e = reject(2);
  if (!e?.card_id) throw Error("Missing first rejection");
  store.advanceRouterCursor(project, e.card_id, e.seq - 1);
  return {
    store,
    project,
    clock,
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
    resume: () => decide("raise_limit"),
  };
}

// The first wake is definitely not sent. Count actual deliveries behind the
// adapter's final callback, not wake() calls or notifications created.
test.each(["backoff", "preparation", "before_send", "superseded"] as const)(
  "failed rework retry respects a shared pause: %s",
  async (phase) => {
    const f = await fixture();
    let prepared = 0,
      sent = 0,
      calls = 0;
    const wake: Runtime["wake"] = async (_ref, _bell, options) => {
      if (++calls === 2 && phase === "before_send") f.pause();
      if (options?.before_send && !(await options.before_send()))
        return { ok: true, value: { sent: false, withdrawn: true } };
      if (calls === 1) return { ok: true, value: { sent: false } };
      sent++;
      return { ok: true, value: { sent: true } };
    };
    const dispatcher = new Dispatcher({
      store: f.store,
      clock: f.clock,
      snapshot: async () => ({ model: "fixture", agent_cli_version: "1" }),
      startRun: vi.fn(),
      beforeWake: async () => {
        if (++prepared === 2 && phase === "preparation") f.pause();
      },
      runtime: {
        wake,
        status: async () => ({
          ok: true,
          value: { process: "alive", agent: "idle", observed_seq: 0 },
        }),
        provision: vi.fn(),
        release: vi.fn(),
        interrupt: vi.fn(),
        resume_or_replace: vi.fn(),
        human_entry: vi.fn(),
      },
    });
    await dispatcher.tick();
    const run = f
      .read()
      .runs.find((r) => r.assignment_id === f.owner && r.kind === "rework");
    if (!run) throw Error("Missing failed dispatch");
    const attempts = () =>
      listBellAttempts(f.store.database, f.project, run.id).map(
        (a) => a.outcome,
      );
    expect(run.status).toBe("dispatched");
    expect(attempts()).toEqual(["failed"]);
    if (phase === "backoff" || phase === "superseded") f.pause();
    f.advance(30_001);
    await dispatcher.tick();
    expect(f.read().decisions[0]).toMatchObject({
      status: "provisional",
      resolution: { option: "pause" },
    });
    expect(sent).toBe(0);
    expect(attempts()).toEqual(["failed"]);
    if (phase === "backoff") expect(prepared).toBe(1);
    expect(
      f.store.uow.run((tx) =>
        acknowledgeRun(
          loadCommandState(tx, f.project),
          actor(),
          { run_id: run.id },
          { ids: tx.ids, clock: f.clock },
        ),
      ),
    ).toMatchObject({ ok: false, error: { code: "illegal_transition" } });
    if (phase === "superseded")
      f.store.uow.run((tx) => {
        tx.deliveries.put(f.project, { ...f.target, status: "superseded" });
        tx.deliveries.put(f.project, {
          ...f.target,
          id: tx.ids.next(f.project, "delivery"),
          supersedes: f.target.id,
          status: "submitted",
        });
      });
    // Time spent paused is not a failed start. Continue the same pending Run,
    // rather than sending the resolution as a second rework notification.
    f.advance(120_000);
    await dispatcher.tick();
    const continued = f.resume();
    await dispatcher.tick();
    await dispatcher.tick();
    if (phase === "superseded") {
      expect(sent).toBe(0);
      expect(attempts()).toEqual(["failed"]);
    } else {
      expect(continued?.payload).toMatchObject({ rework_run_id: run.id });
      expect(attempts()).toEqual(["failed", "sent"]);
      expect(sent).toBe(1);
    }
    expect(continued?.payload).not.toHaveProperty("rework_work_item_id");
  },
);

// Re-create the dispatcher at resume; two independent loops contend for the
// same durable attempt. Count the external write only behind the final guard.
test.each([
  "preparation",
  "before_send",
  "superseded",
  "unknown",
  "interrupted",
] as const)(
  "withdrawn first repair has one owner after restart: %s",
  async (phase) => {
    const f = await fixture();
    let paused = false,
      writes = 0;
    const pauseOnce = () => {
      if (!paused) {
        paused = true;
        f.pause();
      }
    };
    const release = vi.fn();
    const runtime: Runtime = {
      status: async () => ({
        ok: true,
        value: { process: "alive", agent: "idle", observed_seq: 0 },
      }),
      wake: async (_ref, _bell, opts) => {
        if (phase !== "preparation") pauseOnce();
        if (opts?.before_send && !opts.before_send())
          return { ok: true, value: { sent: false, withdrawn: true } };
        writes++;
        if (phase === "unknown")
          return {
            ok: false,
            error: { code: "runtime_timeout", message: "Lost response" },
          };
        return { ok: true, value: { sent: true } };
      },
      release,
      provision: vi.fn(),
      interrupt: vi.fn(),
      resume_or_replace: vi.fn(),
      human_entry: vi.fn(),
    };
    const loop = () =>
      new Dispatcher({
        store: f.store,
        clock: f.clock,
        runtime,
        startRun: vi.fn(),
        snapshot: async () => ({ model: "fixture", agent_cli_version: "1" }),
        beforeWake: async () => {
          if (phase === "preparation" && !paused) {
            f.advance(12 * 60_000);
            pauseOnce();
          }
        },
      });
    await loop().tick();
    const run = f
      .read()
      .runs.find((r) => r.assignment_id === f.owner && r.kind === "rework");
    if (!run) throw Error("Missing withdrawn rework");
    const outcomes = () =>
      listBellAttempts(f.store.database, f.project, run.id).map(
        (a) => a.outcome,
      );
    expect(writes).toBe(0);
    expect(outcomes()).toEqual([]);
    expect(
      f
        .read()
        .events.filter((e) => e.type === "run_dispatch_deferred")
        .map((e) => e.payload),
    ).toContainEqual(
      expect.objectContaining({
        run_id: run.id,
        reason: "shared_review_paused",
        delivery_id: f.target.id,
        target_sha: f.target.subject.value,
      }),
    );
    f.advance(12 * 60_000);
    await loop().tick();
    if (phase === "superseded")
      f.store.uow.run((tx) =>
        tx.deliveries.put(f.project, { ...f.target, status: "superseded" }),
      );
    f.resume();
    if (phase === "interrupted") {
      // Simulate a previous process that committed its claim but did not
      // persist the IO outcome. Neither its lease nor its expiry proves no IO.
      f.store.uow.run(() =>
        beginDispatchRetry(f.store.database, {
          id: "lost-claim",
          project_id: f.project,
          assignment_id: f.owner,
          run_id: run.id,
          notification_ids: [],
          started_at: f.clock.now(),
          lease_until: new Date(Date.parse(f.clock.now()) + 1000).toISOString(),
        }),
      );
      await loop().tick();
      expect(outcomes()).toEqual([null]);
      f.advance(1_001);
      await loop().tick();
      f.advance(30_001);
      await loop().tick();
      expect(writes).toBe(0);
      expect(outcomes()).toEqual(["failed"]);
      expect(release).not.toHaveBeenCalled();
      return;
    }
    await Promise.all([loop().tick(), loop().tick()]);
    f.advance(30_001);
    await loop().tick();
    expect(writes).toBe(phase === "superseded" ? 0 : 1);
    expect(outcomes()).toEqual(
      phase === "superseded" ? [] : phase === "unknown" ? ["failed"] : ["sent"],
    );
    expect(release).not.toHaveBeenCalled();
  },
);
