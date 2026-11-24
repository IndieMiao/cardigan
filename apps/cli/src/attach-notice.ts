import {
  type AssignmentId,
  ATTACHED_HUMAN_WAIT_REASON,
  type ProjectId,
} from "@cardigan/domain";
import type { Store } from "@cardigan/store";

export const ATTACH_NOTICE_INTERVAL_MS = 2_000;

/**
 * C-678: while a human is attached, show in their terminal any host action
 * that waits for them to detach. Reads only the new project-stream facts;
 * output goes to the human's own stderr, never into the Agent's input, so
 * whatever is being typed is left untouched. Returns a stop function.
 */
export function watchAttachNotices(options: {
  readonly store: Pick<Store, "getUpdates" | "latestEventSeqs">;
  readonly project_id: ProjectId;
  readonly assignment_id: AssignmentId;
  readonly write: (text: string) => void;
  readonly intervalMs?: number;
}): () => void {
  let cursor = options.store.latestEventSeqs(options.project_id).get("") ?? 0;
  const shown = new Set<string>();
  const poll = () => {
    let updates: ReturnType<Store["getUpdates"]>;
    try {
      updates = options.store.getUpdates({
        project_id: options.project_id,
        since_seq: cursor,
      });
    } catch {
      return; // The notice is best effort; attaching itself must not fail.
    }
    cursor = Math.max(cursor, updates.latest_seq);
    for (const e of updates.events) {
      if (e.type !== "host_ops_action_deferred") continue;
      const p = e.payload as {
        action_id?: unknown;
        assignment_id?: unknown;
        reason?: unknown;
        notice?: unknown;
      };
      if (
        p.reason !== ATTACHED_HUMAN_WAIT_REASON ||
        p.assignment_id !== options.assignment_id ||
        typeof p.action_id !== "string" ||
        typeof p.notice !== "string" ||
        shown.has(p.action_id)
      )
        continue;
      shown.add(p.action_id);
      options.write(attachNoticeText(p.notice));
    }
  };
  const timer = setInterval(
    poll,
    options.intervalMs ?? ATTACH_NOTICE_INTERVAL_MS,
  );
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Raw-mode terminals need CR before the line feed `io.stderr` appends;
 * control characters never reach the TTY.
 */
export function attachNoticeText(notice: string) {
  return `\r\n[Cardigan] ${notice.replace(/\p{Cc}/gu, " ")}\r`;
}
