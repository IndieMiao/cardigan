import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchRun, type Runtime, submitReview } from "@cardigan/domain";
import { loadCommandState, persistEffect } from "@cardigan/mcp-server";
import { Store } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import {
  parallelBug,
  rejectedParallel,
} from "../../../packages/domain/src/commands/parallel-review/test-fixtures.js";
import {
  actor,
  id,
  now,
  value,
} from "../../../packages/domain/src/commands/test-fixtures.js";
import { Dispatcher, type DispatcherOptions } from "./dispatch.js";

async function parallelScenario(routing: "immediate" | "delayed") {
  const dataDir = mkdtempSync(join(tmpdir(), "cg-parallel-review-"));
  const clock = { now: () => now };
  let store = Store.open({ dataDir, clock });
  const project = "fixture-project";
  try {
    store.createProject({ id: project });
    const io = store.uow.run((tx) => {
      for (const kind of ["card", "work_item", "assignment", "run"] as const)
        for (let i = 0; i < 4; i++) tx.ids.next(project, kind);
      return { ids: tx.ids, clock };
    });
    const f = await rejectedParallel(5, io);
    store.uow.run((tx) => {
      for (const c of f.state.cards) tx.cards.put(project, c);
      for (const w of f.state.work_items) tx.work_items.put(project, w);
      for (const a of f.state.assignments) tx.assignments.put(project, a);
      for (const r of f.state.runs)
        tx.runs.put(
          project,
          r.assignment_id === id("assignment", 1)
            ? { ...r, status: "completed", outcome: "completed" }
            : r,
        );
      for (const r of f.state.roles) tx.roles.put(project, r);
      for (const d of f.state.deliveries) tx.deliveries.put(project, d);
      for (const r of f.state.reviews) tx.reviews.put(project, r);
      for (const e of f.state.events) tx.events.append(project, e);
      for (const t of f.state.timeline) tx.timeline.put(project, t);
    });
    const rejectionEvent = f.rejected.events[0];
    if (!rejectionEvent) throw new Error("Missing rejection event");
    store.ackEvents({
      project_id: project,
      assignment_id: id("assignment", 1),
      card_id: id("card", 1),
      up_to_seq: rejectionEvent.seq - 1,
    });
    const runtime: Runtime = {
      status: vi.fn(async () => ({
        ok: true,
        value: { process: "alive", agent: "idle", observed_seq: 0 },
      })),
      wake: vi.fn(async () => ({ ok: true, value: { sent: true } })),
      provision: vi.fn(),
      release: vi.fn(),
      interrupt: vi.fn(),
      resume_or_replace: vi.fn(),
      human_entry: vi.fn(),
    };
    const onError = vi.fn();
    const options = (): DispatcherOptions => ({
      store,
      clock,
      runtime,
      onError,
      snapshot: async () => ({ model: "fixture", agent_cli_version: "1" }),
      startRun: async ({ run, assignment }) => {
        store.uow.run((tx) =>
          persistEffect(
            tx,
            project,
            value(
              dispatchRun(
                loadCommandState(tx, project),
                { kind: "system", project_id: project },
                {
                  run_id: run.id,
                  runtime_ref: {
                    machine_id: "local",
                    runtime_machine: "local",
                    terminal_ref: assignment.id,
                    agent_name: assignment.id,
                  },
                },
                { ids: tx.ids, clock },
              ),
            ),
          ),
        );
      },
    });
    const read = () => store.uow.read((tx) => loadCommandState(tx, project));
    const reworks = () =>
      read().runs.filter(
        (r) => r.assignment_id === id("assignment", 1) && r.kind === "rework",
      );
    if (routing === "immediate") {
      await new Dispatcher(options()).tick();
      expect(reworks()).toHaveLength(1);
    } else {
      expect(reworks()).toHaveLength(0);
    }
    const before = read();
    const write = (rollback = false) =>
      store.uow.run((tx) => {
        const effect = value(
          submitReview(
            loadCommandState(tx, project),
            actor(3, "pm"),
            { ...f.review, issues: [parallelBug] },
            { ids: tx.ids, clock },
          ),
        );
        persistEffect(tx, project, effect);
        if (rollback) throw new Error("synthetic rollback");
        return effect;
      });
    expect(() => write(true)).toThrow("synthetic rollback");
    expect(read().reviews).toEqual(before.reviews);
    expect(read().events).toEqual(before.events);
    const late = write();
    const event = late.events[0];
    if (!event) throw new Error("Missing late review event");
    // Reopen before consuming the late event: the event marker is durable.
    store.close();
    store = Store.open({ dataDir, clock });
    await new Dispatcher(options()).tick();
    await new Dispatcher(options()).tick();
    expect(
      store
        .listNotifications({ project_id: project })
        .filter((n) => n.kind === "escalation"),
    ).toEqual([]);
    for (const reviewEvent of [rejectionEvent, event]) {
      expect(
        store
          .listNotifications({
            project_id: project,
            assignment_id: id("assignment", 1),
          })
          .filter((n) => n.event_id === reviewEvent.id),
      ).toHaveLength(1);
    }
    expect(read().reviews).toHaveLength(2);
    expect(reworks()).toHaveLength(1);
    expect(
      store
        .listNotifications({
          project_id: project,
          assignment_id: id("assignment", 1),
        })
        .filter((n) => n.event_id === event.id),
    ).toEqual([
      expect.objectContaining({
        kind: "review",
        recipient: { kind: "assignment", assignment_id: id("assignment", 1) },
      }),
    ]);
    expect(
      store.getUpdates({
        project_id: project,
        card_id: id("card", 1),
        since_seq: event.seq - 1,
      }).events,
    ).toContainEqual(
      expect.objectContaining({
        id: event.id,
        payload: expect.objectContaining({
          delivery_id: f.target.id,
          parallel_late: true,
        }),
      }),
    );
    expect(read().deliveries[0]?.status).toBe("rejected");
    expect(onError).not.toHaveBeenCalled();
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

test.each(["immediate", "delayed"] as const)(
  "parallel findings survive rollback/restart with %s first-event routing",
  parallelScenario,
);
