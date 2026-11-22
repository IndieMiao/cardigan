import {
  beginIdleAssignmentRoleUpgrade,
  type Clock,
  deferIdleAssignmentRoleUpgrade,
  finishIdleAssignmentRoleUpgrade,
  type ProjectId,
  type Runtime,
  requestDeploymentAction,
  retirementOwnsSession,
} from "@cardigan/domain";
import { loadCommandState, persistEffect } from "@cardigan/mcp-server";
import {
  listRoleVersions,
  type ReadRepositories,
  recordNotification,
  type Store,
} from "@cardigan/store";
import { idleRolePolicy } from "./deployment-roles.js";
import { tryHostOpsLock } from "./host-ops-lock.js";
import { retireIdleSessions } from "./idle-session-retirement.js";
import {
  sessionIdleMinutes,
  sessionMaintenanceScan,
} from "./session-maintenance.js";

export const IDLE_ROLE_UPGRADE_INTERVAL_MS = 60_000;
export const MAX_IDLE_ROLE_UPGRADES = 2;

/** Bounded idle retirement followed by exit-confirmed default-role upgrades. */
export async function upgradeIdleAssignmentRoles(
  store: Store,
  project: ProjectId,
  runtime: Runtime,
  clock: Clock,
) {
  // No full state loads for projects without managed work-item sessions.
  if (
    !store.uow.read((tx) =>
      tx.assignments
        .list(project)
        .some(
          (a) =>
            a.scope === "work_item" && !a.external && a.status !== "released",
        ),
    )
  )
    return;
  const scan = sessionMaintenanceScan(
    store,
    project,
    clock,
    sessionIdleMinutes(),
    Boolean(runtime.retire_idle),
  );
  try {
    const retired = await retireIdleSessions(
      store,
      project,
      runtime,
      clock,
      sessionIdleMinutes(),
      MAX_IDLE_ROLE_UPGRADES,
      scan.note,
    );
    await upgradeRoles(
      store,
      project,
      runtime,
      clock,
      scan.note,
      MAX_IDLE_ROLE_UPGRADES - retired,
    );
  } finally {
    await scan.finish();
  }
}

async function upgradeRoles(
  store: Store,
  project: ProjectId,
  runtime: Runtime,
  clock: Clock,
  note: ReturnType<typeof sessionMaintenanceScan>["note"],
  limit: number,
) {
  const inFlight = (tx: ReadRepositories) =>
    store
      .listProjects()
      .flatMap((p) => tx.assignments.list(p.id))
      .filter(
        (a) =>
          (a.role_upgrade ||
            (a.idle_retirement?.phase === "stopping" &&
              !a.idle_retirement.handoff)) &&
          a.status === "active",
      ).length;
  const candidates = store.uow.read((tx) => {
    // Parse each role document once per maintenance pass, not once per Assignment.
    const latest = new Map<
      string,
      ReturnType<typeof listRoleVersions>[number]
    >();
    for (const role of listRoleVersions(tx, project))
      latest.set(role.role_id, role);
    const candidates = tx.assignments
      .list(project)
      .filter(
        (a) =>
          a.scope === "work_item" &&
          a.status === "active" &&
          !a.external &&
          a.idle_retirement?.phase !== "stopping" &&
          (a.role_upgrade ||
            (!retirementOwnsSession(a) &&
              (latest.get(a.role_id)?.version ?? 0) > a.role_version)),
      );
    candidates.sort(
      (a, b) =>
        Number(Boolean(b.role_upgrade)) - Number(Boolean(a.role_upgrade)) ||
        Number(a.id.slice(2)) - Number(b.id.slice(2)),
    );
    return candidates;
  });
  let attempted = 0;
  for (const candidate of candidates) {
    const id = candidate.id;
    if (attempted >= limit) {
      note(id, "upgrade_capacity");
      continue;
    }
    const unlock = await tryHostOpsLock(store, project, id);
    if (!unlock) {
      note(id, "maintenance_locked"); // Includes Cardigan attach; native attach remains unobserved.
      continue;
    }
    const defer = (
      reason: Parameters<typeof deferIdleAssignmentRoleUpgrade>[3],
    ) => {
      try {
        store.uow.run((tx) => {
          const effect = deferIdleAssignmentRoleUpgrade(
            loadCommandState(tx, project),
            { kind: "system", project_id: project },
            id,
            reason,
            { ids: tx.ids, clock },
          );
          if (!effect.ok) throw new Error("Failed to defer idle role upgrade");
          persistEffect(tx, project, effect.value);
          for (const event of effect.value.events)
            recordNotification(store.database, {
              project_id: project,
              event_id: event.id,
              card_id: event.card_id,
              seq: event.seq,
              recipient: { kind: "pm_ops" },
              kind: "run_attention",
              at: event.created_at,
            });
        });
      } catch {
        // Keep the durable fence and allow later candidates to make progress.
        console.error("Failed to persist idle Assignment role upgrade backoff");
      }
    };
    try {
      const before = store.uow.read((tx) => tx.assignments.get(project, id));
      if (!before || before.status !== "active") continue;
      // Pending owners sort first. A full batch must not probe every later terminal.
      if (
        !before.role_upgrade &&
        store.uow.read(inFlight) >= MAX_IDLE_ROLE_UPGRADES
      ) {
        note(id, "upgrade_capacity");
        continue;
      }
      if (
        before.runtime_ref &&
        Date.parse(before.role_upgrade?.retry_at ?? "") >
          Date.parse(clock.now())
      )
        continue;
      const ref = before.runtime_ref;
      if (
        before.idle_retirement?.phase === "stopping" ||
        (!before.role_upgrade && retirementOwnsSession(before))
      )
        continue;
      if (ref && !retirementOwnsSession(before)) {
        try {
          const observed = await runtime.status(ref);
          // Agent state and control-plane silence cannot prove that a live
          // terminal has no native attach or output. Never retire a live process.
          const idle = observed.ok
            ? observed.value.process === "exited"
            : observed.error.code === "runtime_not_found";
          if (!idle) {
            note(
              id,
              !observed.ok
                ? "runtime_unavailable"
                : observed.value.process === "unknown" ||
                    observed.value.agent === "unknown"
                  ? "observation_incomplete"
                  : ["working", "blocked"].includes(observed.value.agent)
                    ? "terminal_busy"
                    : "unsupported_capability",
            );
            if (before.role_upgrade)
              defer(observed.ok ? "runtime_busy" : "runtime_unavailable");
            continue;
          }
          note(id, "exited");
        } catch {
          note(id, "runtime_unavailable");
          if (before.role_upgrade) defer("runtime_unavailable");
          continue;
        }
      }
      const pending = store.uow.run((tx) => {
        const previous = tx.assignments.get(project, id);
        if (
          !previous ||
          JSON.stringify(previous.runtime_ref) !== JSON.stringify(ref)
        )
          return;
        if (previous.role_upgrade) return previous;
        if (inFlight(tx) >= MAX_IDLE_ROLE_UPGRADES) return;
        const policy = idleRolePolicy(tx, project, previous.role_id);
        if (
          !policy ||
          policy.role.status === "inactive" ||
          policy.role.version <= previous.role_version
        )
          return;
        if (!policy.published) {
          note(id, "publication_pending");
          return;
        }
        const state = loadCommandState(tx, project);
        if (
          state.roles.some(
            (r) =>
              r.role_id === previous.role_id &&
              r.role_version > policy.role.version,
          )
        )
          return;
        if (!policy.matches) {
          const notice = requestDeploymentAction(
            state,
            { kind: "system", project_id: project },
            {
              key: `deployment-role-manual:${previous.role_id}:${policy.role.version}:${policy.hash}`,
              instructions: `角色 ${previous.role_id} v${policy.role.version} 与当前默认包存在手改冲突；保留旧 Assignment、会话和工作区，请人确认角色规则后再自动升级。`,
            },
            { ids: tx.ids, clock },
          );
          if (notice.ok) persistEffect(tx, project, notice.value);
          return;
        }
        const effect = beginIdleAssignmentRoleUpgrade(
          state,
          { kind: "system", project_id: project },
          id,
          { ids: tx.ids, clock },
        );
        if (!effect.ok) return;
        persistEffect(tx, project, effect.value);
        for (const token of tx.tokensForAssignment(project, id))
          if (token.revoked_at === null && !tx.revokeToken(token.id))
            throw new Error("Failed to revoke old role token");
        return effect.value.data;
      });
      if (!pending?.role_upgrade) continue;
      attempted++;
      let observedRetirementExit: NonNullable<typeof ref> | undefined;
      // Human stop may already have confirmed exit and cleared runtime_ref.
      if (ref) {
        try {
          // The general release API can kill a live terminal even with
          // force:false. Do not invoke it: preserve terminal history and only
          // settle the fenced identity after another observation of exit.
          let exited: boolean;
          if (retirementOwnsSession(pending)) {
            // Legacy overlap: never use a missing snapshot to finish this upgrade.
            const observed = await runtime.observe_retirement?.(ref, {
              project_id: project,
              assignment_id: id,
            });
            exited = observed?.ok === true && observed.value === "exited";
            if (exited) observedRetirementExit = ref;
          } else {
            const observed = await runtime.status(ref);
            exited = observed.ok
              ? observed.value.process === "exited"
              : observed.error.code === "runtime_not_found";
          }
          if (!exited) {
            defer("exit_unconfirmed");
            continue;
          }
        } catch {
          defer("runtime_unavailable");
          continue;
        }
      }
      const finished = store.uow.run((tx) => {
        const effect = finishIdleAssignmentRoleUpgrade(
          loadCommandState(tx, project),
          { kind: "system", project_id: project },
          id,
          { ids: tx.ids, clock },
          observedRetirementExit,
        );
        if (!effect.ok) return false;
        persistEffect(tx, project, effect.value);
        return true;
      });
      if (!finished) defer("settlement_failed");
    } finally {
      await unlock();
    }
  }
}
