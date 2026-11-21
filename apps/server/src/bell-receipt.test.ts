import { acknowledgeRun, postComment, type Runtime } from "@cardigan/domain";
import { expect, test, vi } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";
import { Dispatcher } from "./dispatch.js";

// Count writes at the adapter boundary, not wake() invocations. The same port
// receives the exact worker binding for remote terminals; no local fallback.
test.each([
  ["local", false],
  ["worker", true],
] as const)(
  "%s: retry a confirmed write once on its original Run, then tell PM",
  async (machine, businessStarted) => {
    const f = dispatchFixture(machine);
    try {
      const t = f.create();
      f.session(t.assignment);
      f.apply((s, a, p) =>
        postComment(
          s,
          a,
          { card_id: t.card.id, work_item_id: t.item.id, body: "unread" },
          p,
        ),
      );
      let agent: "working" | "idle" | "done" = "working";
      const writes: string[] = [];
      const runtime: Runtime = {
        status: vi.fn(async () => ({
          ok: true as const,
          value: { process: "alive" as const, agent, observed_seq: 2 },
        })),
        wake: vi.fn(async (ref, text, opts) => {
          expect(ref).toEqual(f.refFor(t.assignment));
          expect(opts?.if_idle || opts?.observed_guard?.state === "done").toBe(
            true,
          );
          if (!opts?.before_send?.())
            return {
              ok: true as const,
              value: { sent: false, withdrawn: true as const },
            };
          writes.push(text);
          return { ok: true as const, value: { sent: true } };
        }),
        release: vi.fn(),
        provision: vi.fn(),
        resume_or_replace: vi.fn(),
        interrupt: vi.fn(),
        human_entry: vi.fn(),
      };
      const opts = {
        store: f.store,
        clock: f.clock,
        runtime,
        dispatchTimeoutMs: 1000,
        snapshot: vi.fn(),
        startRun: vi.fn(),
      };
      const dispatch = new Dispatcher(opts);
      await dispatch.tick();
      expect(writes).toEqual([]);
      agent = "done";
      await dispatch.tick();
      expect(writes).toHaveLength(1);
      const id = f.state().runs.at(-1)?.id;
      if (!id) throw new Error("missing Run");
      if (businessStarted)
        f.apply(
          (s, a, p) => acknowledgeRun(s, a, { run_id: id }, p),
          f.actorFor(t.assignment),
        );
      f.advance(999);
      await dispatch.tick();
      expect(writes).toHaveLength(1);
      f.advance(1);
      agent = "idle";
      await Promise.all([new Dispatcher(opts).tick(), dispatch.tick()]);
      expect(writes).toHaveLength(2);
      expect(writes.every((text) => text.includes(`run=${id}`))).toBe(true);
      f.advance(1001);
      await new Dispatcher(opts).tick();
      await dispatch.tick();
      expect(writes).toHaveLength(2);
      expect(runtime.release).not.toHaveBeenCalled();
      const evidence = f
        .state()
        .events.filter((e) => e.type === "bell_receipt_missing");
      expect(evidence).toHaveLength(1);
      expect(evidence[0]?.payload).toMatchObject({
        assignment_id: t.assignment.id,
        run_id: id,
        reason: "no_receipt_after_retry",
        activity_source: `${machine}: alive/idle`,
      });
      expect(
        f.store
          .listNotifications({ project_id: f.project })
          .some(
            (n) =>
              n.event_id === evidence[0]?.id && n.recipient.kind === "pm_ops",
          ),
      ).toBe(true);
    } finally {
      f.close();
    }
  },
);
