import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchRun, finishRun, type Runtime } from "@cardigan/domain";
import { loadCommandState, persistEffect } from "@cardigan/mcp-server";
import { Store } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import {
  actor,
  id,
  now,
  value,
} from "../../../packages/domain/src/commands/test-fixtures.js";
import { requirementsReuseInvalidation } from "../../../packages/router/test-support/review-reuse.js";
import { Dispatcher, type DispatcherOptions } from "./dispatch.js";

// Exercise the real command event, persistent routing and Run creation together.
test("requirements changes wake the producer for rework once across restart", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cg-reuse-dispatch-"));
  const clock = { now: () => now };
  let store = Store.open({ dataDir, clock });
  const project = "fixture-project";
  try {
    store.createProject({ id: project });
    const io = store.uow.run((tx) => {
      // Reserve the fixed fixture's IDs before issuing real command IDs.
      for (const kind of ["card", "work_item", "assignment", "run"] as const)
        for (let i = 0; i < 4; i++) tx.ids.next(project, kind);
      return { ids: tx.ids, clock };
    });
    const { state, event, producer } = await requirementsReuseInvalidation(io);
    store.uow.run((tx) => {
      for (const c of state.cards) tx.cards.put(project, c);
      for (const w of state.work_items) tx.work_items.put(project, w);
      for (const a of state.assignments) tx.assignments.put(project, a);
      for (const r of state.runs) tx.runs.put(project, r);
      for (const r of state.roles) tx.roles.put(project, r);
      for (const d of state.deliveries) tx.deliveries.put(project, d);
      for (const r of state.reviews) tx.reviews.put(project, r);
      for (const e of state.employees ?? []) tx.employees.put(e);
      for (const p of state.project_preferences ?? [])
        tx.project_preferences.put(project, p);
      for (const e of state.events) tx.events.append(project, e);
      for (const t of state.timeline) tx.timeline.put(project, t);
    });
    // The command's submission is acknowledged; the derived recovery is still
    // unread when the producer finishes its current Run.
    store.ackEvents({
      project_id: project,
      assignment_id: producer.id,
      card_id: id("card", 1),
      up_to_seq: event.seq - 1,
    });
    store.uow.run((tx) =>
      persistEffect(
        tx,
        project,
        value(
          finishRun(
            loadCommandState(tx, project),
            actor(),
            {
              run_id: id("run", 1),
              outcome: "completed",
              summary: "Submitted",
            },
            { ids: tx.ids, clock },
          ),
        ),
      ),
    );
    const runtime: Runtime = {
      status: vi.fn<Runtime["status"]>(async () => ({
        ok: true,
        value: { process: "alive", agent: "idle", observed_seq: event.seq },
      })),
      wake: vi.fn<Runtime["wake"]>(async () => ({
        ok: true,
        value: { sent: true },
      })),
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
    await new Dispatcher(options()).tick();
    const read = () => store.uow.read((tx) => loadCommandState(tx, project));
    const reworks = () =>
      read().runs.filter(
        (r) => r.assignment_id === producer.id && r.kind === "rework",
      );
    expect(reworks()).toMatchObject([
      { status: "dispatched", trigger_event_id: event.id },
    ]);
    expect(
      store
        .listNotifications({ project_id: project, assignment_id: producer.id })
        .filter((n) => n.event_id === event.id),
    ).toMatchObject([{ run_id: reworks()[0]?.id, status: "belled" }]);
    store.close();
    store = Store.open({ dataDir, clock });
    await new Dispatcher(options()).tick();
    await new Dispatcher(options()).tick();
    expect(reworks()).toHaveLength(1);
    expect(onError).not.toHaveBeenCalled();
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
