import {
  cancelHumanAction,
  completeHumanAction,
  type Runtime,
  requestHumanAction,
} from "@cardigan/domain";
import { recordNotification } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";
import { Dispatcher } from "./dispatch.js";

test("C-750: owner needs_you notices of completed or cancelled human actions are resolved, open ones stay", async () => {
  const f = dispatchFixture();
  try {
    const { card } = f.create();
    const request = (instructions: string) =>
      f.apply((s, a, p) =>
        requestHumanAction(
          s,
          a,
          {
            card_id: card.id,
            instructions,
            why_human: "账号",
            expected_return: "已确认",
            blocked_work_items: [],
          },
          p,
        ),
      );
    const done = request("去后台点确认");
    const cancelled = request("再点一次");
    const open = request("还要人做");
    // Existing rows written before this change: one owner notice per request.
    const notice = (id: string) => {
      const event = f
        .state()
        .events.find(
          (e) =>
            e.type === "human_action_requested" &&
            (e.payload as { human_action_id?: string }).human_action_id === id,
        );
      if (!event) throw new Error(`missing request event for ${id}`);
      return f.store.uow.run(
        () =>
          recordNotification(f.store.database, {
            project_id: f.project,
            event_id: event.id,
            seq: event.seq,
            card_id: card.id,
            recipient: { kind: "needs_you" },
            kind: "needs_you",
          }).notification.id,
      );
    };
    const ids = {
      done: notice(done.id),
      cancelled: notice(cancelled.id),
      open: notice(open.id),
    };
    f.apply((s, a, p) =>
      completeHumanAction(s, a, { human_action_id: done.id, text: "好了" }, p),
    );
    f.apply((s, a, p) =>
      cancelHumanAction(
        s,
        a,
        { human_action_id: cancelled.id, reason: "不需要了" },
        p,
      ),
    );
    await new Dispatcher({
      store: f.store,
      clock: f.clock,
      runtime: {
        status: vi.fn(async () => ({
          ok: true,
          value: { process: "alive", agent: "idle", observed_seq: 1 },
        })),
        wake: vi.fn(),
      } as unknown as Runtime,
      snapshot: vi.fn(),
      startRun: vi.fn(),
    }).tick();
    const status = (id: string) =>
      f.store
        .listNotifications({ project_id: f.project })
        .find((n) => n.id === id)?.status;
    expect(status(ids.done)).toBe("resolved");
    expect(status(ids.cancelled)).toBe("resolved");
    expect(status(ids.open)).toBe("pending");
  } finally {
    f.close();
  }
});
