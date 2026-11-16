import {
  beginIdleAssignmentRoleUpgrade,
  type Clock,
  finishIdleAssignmentRoleUpgrade,
  type ProjectId,
  type Runtime,
  requestDeploymentAction,
} from "@cardigan/domain";
import { loadCommandState, persistEffect } from "@cardigan/mcp-server";
import { defaultRoleDefinition, isDefaultRoleId } from "@cardigan/roles";
import { getRoleVersion, type Store } from "@cardigan/store";
import { deploymentRolePolicyHash } from "./deployment-roles.js";
import { tryHostOpsLock } from "./host-ops-lock.js";

/** Durable retirement fence prevents another controller from launching during release. */
export async function upgradeIdleAssignmentRoles(
  store: Store,
  project: ProjectId,
  runtime: Runtime,
  clock: Clock,
) {
  const ids = store.uow.read((tx) =>
    tx.assignments
      .list(project)
      .filter(
        (a) =>
          a.scope === "work_item" &&
          a.status === "active" &&
          !a.external &&
          (a.role_upgrade ||
            (getRoleVersion(tx, project, a.role_id)?.version ?? 0) >
              a.role_version),
      )
      .map((a) => a.id),
  );
  for (const id of ids) {
    const unlock = await tryHostOpsLock(store, project, id);
    if (!unlock) continue;
    try {
      const pending = store.uow.run((tx) => {
        const previous = tx.assignments.get(project, id);
        if (!previous) return;
        if (previous.role_upgrade) return previous;
        if (!isDefaultRoleId(previous.role_id)) return;
        const latest = getRoleVersion(tx, project, previous.role_id);
        if (
          !latest ||
          latest.status === "inactive" ||
          latest.version <= previous.role_version
        )
          return;
        const source = defaultRoleDefinition(previous.role_id, {
          harness: latest.harness,
          launch_profile_ref: latest.launch_profile_ref,
        });
        // Reuse B9's conflict key so deployment and idle maintenance ask once.
        if (
          deploymentRolePolicyHash(latest) !== deploymentRolePolicyHash(source)
        ) {
          const notice = requestDeploymentAction(
            loadCommandState(tx, project),
            { kind: "system", project_id: project },
            {
              key: `deployment-role-manual:${previous.role_id}:${latest.version}:${deploymentRolePolicyHash(source)}`,
              instructions: `角色 ${previous.role_id} v${latest.version} 与当前默认包存在手改冲突；保留旧 Assignment、会话和工作区，请人确认角色规则后再自动升级。`,
            },
            { ids: tx.ids, clock },
          );
          if (notice.ok) persistEffect(tx, project, notice.value);
          return;
        }
        const effect = beginIdleAssignmentRoleUpgrade(
          loadCommandState(tx, project),
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
      const ref = pending.role_upgrade.previous_runtime_ref;
      if (ref) {
        try {
          const released = await runtime.release(ref, { force: true });
          if (!released.ok && released.error.code !== "runtime_not_found")
            continue;
          const observed = await runtime.status(ref);
          if (
            !(observed.ok
              ? observed.value.process === "exited"
              : observed.error.code === "runtime_not_found")
          )
            continue;
        } catch {
          continue;
        }
      }
      store.uow.run((tx) => {
        const effect = finishIdleAssignmentRoleUpgrade(
          loadCommandState(tx, project),
          { kind: "system", project_id: project },
          id,
          { ids: tx.ids, clock },
        );
        if (effect.ok) persistEffect(tx, project, effect.value);
      });
    } finally {
      await unlock();
    }
  }
}
