import type { Actor } from "../entities.js";
import type { AssignmentId, EventId } from "../ids.js";
import {
  remoteWorkerLosses,
  remoteWorkerLossReleased,
  type WorkerRecoveryBackup,
} from "../remote-worker-loss.js";
import { transition } from "../transitions.js";
import {
  type CommandPorts,
  type CommandState,
  command,
  ensure,
  unwrap,
} from "./core.js";
import {
  hostOpsExitConfirmation,
  requestExitConfirmationInDraft,
} from "./host-ops-actions.js";
import { cancelRunDispatch } from "./launch.js";
import { correctRemoteLoss } from "./remote-loss-recovery.js";

/** Persist the fence and Needs You request together, including after a host restart. */
export function requestRemoteWorkerExit(
  state: CommandState,
  actor: Actor,
  p: {
    assignment_id: AssignmentId;
    backup?: WorkerRecoveryBackup;
  },
  ports: CommandPorts,
) {
  return command(state, actor, "manage_host_ops_action", ports, (d) => {
    const a = d.get("assignments", p.assignment_id);
    const previous = remoteWorkerLosses(state.events).find(
      (loss) => loss.assignment_id === a.id,
    );
    ensure(
      a.scope === "work_item" &&
        !a.external &&
        a.machine_id !== "local" &&
        ((a.status === "active" && a.runtime_state === "lost") ||
          (a.status === "released" &&
            previous &&
            remoteWorkerLossReleased(state.events, previous.action_id))),
      "illegal_transition",
      "Only a lost remote work-item Assignment can be recovered",
    );
    const item = d.work(a.work_item_id);
    ensure(
      !!previous || item.assignment_id === a.id,
      "stale_target",
      "Work item ownership changed",
    );
    if (p.backup)
      ensure(
        /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(p.backup.sha) &&
          p.backup.branch === a.branch &&
          Number.isFinite(Date.parse(p.backup.at)),
        "validation_failed",
        "Backup must match the recorded Assignment branch",
      );
    const loss = previous ?? {
      assignment_id: a.id,
      work_item_id: item.id,
      process:
        state.runs.find(
          (r) =>
            r.id === a.runtime_ref?.launch_generation?.run_id &&
            r.assignment_id === a.id,
        )?.launch_publication?.process ?? null,
      run_ids: state.runs
        .filter(
          (r) =>
            r.assignment_id === a.id &&
            !["queued", "cancelled", "completed", "failed"].includes(r.status),
        )
        .map((r) => r.id),
      machine_id: a.machine_id,
      runtime_ref: a.runtime_ref,
      ...(p.backup ? { backup: { ...p.backup } } : {}),
    };
    const action_id =
      previous?.action_id ??
      d.emit("remote_worker_lost", item.card_id, {
        ...loss,
        runtime_ref: loss.runtime_ref ? { ...loss.runtime_ref } : null,
      }).id;
    const backup = loss.backup
      ? `最后成功备份：${loss.backup.sha}（${loss.backup.at}），分支 ${loss.backup.branch}。`
      : "没有成功备份记录。";
    requestExitConfirmationInDraft(d, {
      action_id,
      assignment_id: a.id,
      instructions: `机器 ${a.machine_id} 的 ${a.id} 已失联。${backup}\n1. 确认旧机器已关机，或手动结束旧进程及其子进程。\n2. 确认旧进程已退出后，选择“已退出”并回传退出情况；若原会话并未失联，选择“误报”。\n3. PM 再选择其它机器，从备份或基线重新指派。`,
      why_human:
        "失联不能证明进程已退出；系统不会自动结束旧进程。未提交或最后备份之后的工作可能丢失。",
    });
    return { ...loss, action_id };
  });
}

/** The host revokes all Assignment tokens in the same transaction as this effect. */
export function releaseLostRemoteWorker(
  state: CommandState,
  actor: Actor,
  action_id: EventId,
  ports: CommandPorts,
) {
  return command(state, actor, "manage_host_ops_action", ports, (d) => {
    const loss = remoteWorkerLosses(state.events).find(
      (v) => v.action_id === action_id,
    );
    ensure(loss, "not_found", "Remote loss was not recorded");
    if (remoteWorkerLossReleased(state.events, action_id)) return undefined;
    const confirmation = hostOpsExitConfirmation(state, action_id);
    ensure(
      confirmation.status === "confirmed",
      "illegal_transition",
      "Only the human can confirm the old process exited",
    );
    const a = d.get("assignments", loss.assignment_id);
    const item = d.work(loss.work_item_id);
    ensure(
      a.status === "active" &&
        a.runtime_state === "lost" &&
        item.assignment_id === a.id &&
        a.machine_id === loss.machine_id &&
        JSON.stringify(a.runtime_ref) === JSON.stringify(loss.runtime_ref),
      "stale_target",
      "Lost Assignment or runtime changed",
    );
    const reason = `人已确认机器 ${a.machine_id} 的 ${a.id} 旧进程退出，失联执行按失败结算。`;
    for (const run of d.list("runs").filter((r) => r.assignment_id === a.id)) {
      if (["completed", "failed", "cancelled"].includes(run.status)) continue;
      const {
        pending_finish: _finish,
        dispatch_stop: _dispatch,
        inactivity_stop: _inactivity,
        launch_publication: _publication,
        ...rest
      } = run;
      cancelRunDispatch(d, rest, reason);
    }
    d.put("assignments", {
      ...a,
      status: unwrap(transition("assignment", a.status, "release")),
      runtime_state: unwrap(transition("runtime", a.runtime_state, "release")),
      runtime_ref: null,
      released_at: d.now,
    });
    // Preserve work state, delivery/review history and all other blockers. PM assigns explicitly.
    d.emit(
      "remote_worker_released",
      item.card_id,
      {
        action_id,
        assignment_id: a.id,
        work_item_id: item.id,
        human_action_id: confirmation.human_action_id,
      },
      {
        type: "system",
        body: `${reason} 请 PM 选择恢复来源并指定机器；使用原机器须显式确认同机恢复。`,
      },
    );
    return a.id;
  });
}

/** A birth-checked live process corrects an open loss; after release it only fences the orphan. */
export function reportRemoteWorkerAlive(
  state: CommandState,
  actor: Actor,
  action_id: EventId,
  ports: CommandPorts,
) {
  return command(state, actor, "manage_host_ops_action", ports, (d) => {
    const loss = remoteWorkerLosses(state.events).find(
      (v) => v.action_id === action_id,
    );
    ensure(loss, "not_found", "Remote loss was not recorded");
    const released = remoteWorkerLossReleased(state.events, action_id);
    const confirmation = hostOpsExitConfirmation(state, action_id);
    if (!released) {
      // A fresh kernel observation overrides a stale alarm/exit assertion,
      // but can never undo an already committed release.
      correctRemoteLoss(d, loss);
      if (confirmation.status === "open") {
        const action = d.get("human_actions", confirmation.human_action_id);
        d.put("human_actions", {
          ...action,
          status: unwrap(transition("human_action", action.status, "cancel")),
        });
        d.emit("human_action_cancelled", action.card_id, {
          human_action_id: action.id,
          reason: "remote_process_alive",
        });
      }
      return;
    }
    if (
      state.events.some(
        (e) =>
          e.type === "remote_worker_alive" &&
          (e.payload as { action_id?: string }).action_id === action_id &&
          (e.payload as { after_release?: boolean }).after_release,
      )
    )
      return;
    d.emit(
      "remote_worker_alive",
      d.work(loss.work_item_id).card_id,
      { action_id, assignment_id: loss.assignment_id, after_release: true },
      {
        type: "system",
        body: `${loss.assignment_id} 结算后的原进程仍在，等待系统核对并清理。`,
      },
    );
  });
}
