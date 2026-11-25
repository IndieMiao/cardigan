import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ATTACHED_HUMAN_WAIT_REASON } from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { attachNoticeText, watchAttachNotices } from "./attach-notice.js";

let root: string, store: Store;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cg-attach-notice-"));
  store = Store.open({ dataDir: root });
  store.createProject({ id: "fixture", name: "Fixture" });
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  store.close();
  rmSync(root, { recursive: true, force: true });
});

function append(type: string, payload: Record<string, unknown>) {
  store.uow.run((tx) =>
    tx.events.append("fixture" as never, {
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence("fixture" as never),
      type,
      actor: { kind: "system", project_id: "fixture" as never },
      payload: payload as never,
      created_at: new Date().toISOString(),
    }),
  );
}
const wait = (assignment_id: string, action_id: string, notice: string) =>
  append("host_ops_action_deferred", {
    action_id,
    assignment_id,
    reason: ATTACHED_HUMAN_WAIT_REASON,
    notice,
  });

test("C-678: the attached terminal shows each waiting action once, ignoring other facts", () => {
  // A wait recorded before this attach session is not replayed.
  wait("A-1", "E-old", "old");
  const written: string[] = [];
  const stop = watchAttachNotices({
    store,
    project_id: "fixture" as never,
    assignment_id: "A-1" as never,
    write: (text) => written.push(text),
    intervalMs: 1_000,
  });
  try {
    wait("A-1", "E-1", "主机运维要重启；按 Ctrl+\\ 断开后自动继续。");
    wait("A-1", "E-1", "same action, next attach session");
    wait("A-2", "E-2", "another Agent");
    append("host_ops_action_deferred", {
      action_id: "E-3",
      assignment_id: "A-1",
      reason: "terminal_exit_confirmation_requested",
      notice: "unrelated",
    });
    expect(written).toEqual([]);
    vi.advanceTimersByTime(1_000);
    expect(written).toEqual([
      "\r\n[Cardigan] 主机运维要重启；按 Ctrl+\\ 断开后自动继续。\r",
    ]);
    vi.advanceTimersByTime(5_000);
    expect(written).toHaveLength(1);
  } finally {
    stop();
  }
  wait("A-1", "E-4", "after detach");
  vi.advanceTimersByTime(5_000);
  expect(written).toHaveLength(1);
});

test("C-678: notice text never carries terminal control characters", () => {
  expect(attachNoticeText("a\u001b[2Jb\nc")).toBe("\r\n[Cardigan] a [2Jb c\r");
});
