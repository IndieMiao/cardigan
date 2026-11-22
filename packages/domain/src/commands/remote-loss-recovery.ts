import type { RemoteWorkerLoss } from "../remote-worker-loss.js";
import { reconnectRun, transition } from "../transitions.js";
import { type CommandDraft, ensure, unwrap } from "./core.js";

/** A correction removes just this loss fence. Never re-issue a token, change
 * ownership, resurrect a settled Run, or reinterpret an ordinary exit H. */
export function correctRemoteLoss(d: CommandDraft, loss: RemoteWorkerLoss) {
  const a = d.get("assignments", loss.assignment_id);
  const item = d.work(loss.work_item_id);
  const runs = d
    .list("runs")
    .filter(
      (r) =>
        r.assignment_id === a.id &&
        !["queued", "cancelled", "completed", "failed"].includes(r.status),
    );
  ensure(
    a.status === "active" &&
      a.runtime_state === "lost" &&
      item.assignment_id === a.id &&
      a.machine_id === loss.machine_id &&
      JSON.stringify(a.runtime_ref) === JSON.stringify(loss.runtime_ref) &&
      runs.every((r) => !loss.run_ids || loss.run_ids.includes(r.id)),
    "stale_target",
    "Lost session is no longer current",
  );
  const idle = unwrap(transition("runtime", a.runtime_state, "loss_corrected"));
  d.put("assignments", {
    ...a,
    runtime_state: runs.length
      ? unwrap(transition("runtime", idle, "run_started"))
      : idle,
  });
  for (const r of runs)
    if (r.status === "unknown")
      d.put("runs", {
        ...r,
        status: unwrap(reconnectRun(r)),
      });
  d.emit(
    "remote_worker_loss_corrected",
    item.card_id,
    { action_id: loss.action_id, assignment_id: a.id },
    { type: "system", body: `${a.id} 失联判定为误报，保留原会话。` },
  );
}
