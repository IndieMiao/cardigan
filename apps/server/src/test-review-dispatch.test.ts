import { queueRun, type Runtime } from "@cardigan/domain";
import { loadCommandState } from "@cardigan/mcp-server";
import { PROJECT_EVENT_STREAM, Store } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import { human } from "../../../packages/domain/src/commands/test-fixtures.js";
import { testReviewFixture } from "../../../packages/domain/src/commands/test-review/test-fixtures.js";
import { Dispatcher } from "./dispatch.js";
import { retryDispatchedRuns } from "./dispatch-retry.js";

test.each(["send", "revoke", "retry", "retry-revoke", "budget"])(
  "live independent-review wake and retry preserve scope (%s)",
  async (mode) => {
    const f = await testReviewFixture(mode === "budget" ? 1 : 3);
    const delivery = await f.deliver();
    const event = delivery.events.find((e) => e.type === "delivery_submitted");
    if (!event) throw new Error("Missing event");
    const queued = f.commit(
      queueRun(
        f.state,
        human,
        { assignment_id: "A-2", model: "fixture", agent_cli_version: "1" },
        f.io,
      ),
    ).data;
    const ref = {
      machine_id: "local",
      runtime_machine: "local",
      terminal_ref: "test-review",
      agent_name: "review",
    };
    f.state = {
      ...f.state,
      assignments: f.state.assignments.map((a) =>
        a.id === "A-2" ? { ...a, runtime_ref: ref } : a,
      ),
    };
    let time = Date.parse("2026-01-01T00:00:01.000Z");
    const clock = { now: () => new Date(time).toISOString() };
    const store = Store.open({ dbPath: ":memory:", clock });
    store.createProject({ id: f.state.project_id });
    store.setTestReviewTrust(f.trust);
    store.uow.run((tx) => {
      for (const e of f.state.employees ?? []) tx.employees.put(e);
      for (const collection of [
        "cards",
        "work_items",
        "assignments",
        "runs",
        "deliveries",
        "reviews",
        "roles",
      ] as const)
        for (const entity of f.state[collection])
          (tx[collection].put as (p: string, e: unknown) => void)(
            f.state.project_id,
            entity,
          );
      for (const e of f.state.events) tx.events.append(f.state.project_id, e);
      for (const card of [undefined, ...f.state.cards.map((c) => c.id)]) {
        const max = Math.max(
          0,
          ...f.state.events.filter((e) => e.card_id === card).map((e) => e.seq),
        );
        for (let n = 0; n < max; n++)
          tx.ids.nextEventSequence(f.state.project_id, card);
      }
    });
    for (const card of [undefined, ...f.state.cards.map((c) => c.id)])
      store.advanceRouterCursor(
        f.state.project_id,
        card ?? PROJECT_EVENT_STREAM,
        store.getUpdates({
          project_id: f.state.project_id,
          ...(card ? { card_id: card } : {}),
        }).latest_seq,
      );
    store.recordNotification({
      project_id: f.state.project_id,
      event_id: event.id,
      card_id: event.card_id,
      seq: event.seq,
      kind: "delivery",
      recipient: { kind: "assignment", assignment_id: "A-2" },
    });
    let sent = false;
    let calls = 0;
    const wake = vi.fn<Runtime["wake"]>(async (_ref, text, options) => {
      expect(text).toContain("增量复核（只改测试）");
      expect(text).toContain(delivery.data.id);
      expect(text).toContain(delivery.data.subject.value);
      calls++;
      if (mode.startsWith("retry") && calls === 1)
        return {
          ok: false,
          error: { code: "runtime_timeout", message: "Uncertain delivery" },
        };
      if (mode === "revoke" || mode === "retry-revoke") f.revoke();
      sent = options?.before_send?.() !== false;
      return { ok: true, value: { sent } };
    });
    const unused = async () => {
      throw new Error("Unused runtime method");
    };
    const runtime: Runtime = {
      wake,
      status: async () => ({
        ok: true,
        value: { process: "alive", agent: "idle", observed_seq: 1 },
      }),
      provision: unused,
      release: unused,
      interrupt: unused,
      resume_or_replace: unused,
      human_entry: unused,
    };
    const dispatcher = new Dispatcher({
      store,
      runtime,
      clock,
      snapshot: async () => ({ model: "fixture", agent_cli_version: "1" }),
      startRun: unused,
    });
    try {
      if (mode === "budget") f.revoke();
      await dispatcher.tick();
      if (mode === "budget") {
        await dispatcher.tick();
        expect(wake).not.toHaveBeenCalled();
        const state = store.uow.read((tx) =>
          loadCommandState(tx, f.state.project_id),
        );
        expect(state.work_items.find((w) => w.id === "W-2")?.status).toBe(
          "waiting_decision",
        );
        expect(
          state.decisions.filter((q) => q.trigger === "review_limit"),
        ).toHaveLength(1);
        return;
      }
      if (mode.startsWith("retry")) {
        time += 30000;
        await retryDispatchedRuns(
          { store, runtime, clock },
          f.state.project_id,
          {
            timeoutMs: 600000,
            retryBaseMs: 30000,
            maxRetries: 4,
            leaseMs: 60000,
          },
          vi.fn(),
        );
      }
      expect(wake).toHaveBeenCalledTimes(mode.startsWith("retry") ? 2 : 1);
      expect(sent).toBe(mode === "send" || mode === "retry");
      expect(
        store.uow
          .read((tx) => loadCommandState(tx, f.state.project_id))
          .runs.find((r) => r.id === queued.id)?.test_review,
      ).toEqual(delivery.data.test_review);
    } finally {
      await dispatcher.close();
      store.close();
    }
  },
);
