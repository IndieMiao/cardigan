import {
  beginIdleAssignmentRoleUpgrade,
  type Clock,
  deferIdleAssignmentRoleUpgrade,
  finishIdleAssignmentRoleUpgrade,
  type ProjectId,
  type Runtime,
  requestDeploymentAction,
} from "@cardigan/domain";
import { loadCommandState, persistEffect } from "@cardigan/mcp-server";
import { defaultRoleDefinition, isDefaultRoleId } from "@cardigan/roles";
import {
  listRoleVersions,
  type ReadRepositories,
  recordNotification,
  type Store,
} from "@cardigan/store";
import { deploymentRolePolicyHash } from "./deployment-roles.js";
import { tryHostOpsLock } from "./host-ops-lock.js";

export const IDLE_ROLE_UPGRADE_INTERVAL_MS = 60_000;
export const MAX_IDLE_ROLE_UPGRADES = 2;

/** Bounded batches; no version/token changes until the terminal has been observed idle. */
export async function upgradeIdleAssignmentRoles(
  store: Store,
  project: ProjectId,
  runtime: Runtime,
  clock: Clock,
) {
  const inFlight = (tx: ReadRepositories) =>
    store
      .listProjects()
      .flatMap((p) => tx.assignments.list(p.id))
      .filter((a) => a.role_upgrade && a.status === "active").length;
  const { candidates, latest } = store.uow.read((tx) => {
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
          (a.role_upgrade ||
            (latest.get(a.role_id)?.version ?? 0) > a.role_version),
      );
    candidates.sort(
      (a, b) =>
        Number(Boolean(b.role_upgrade)) - Number(Boolean(a.role_upgrade)) ||
        Number(a.id.slice(2)) - Number(b.id.slice(2)),
    );
    return { candidates, latest };
  });
  const policies = new Map(
    [...latest]
      .filter(([id]) => isDefaultRoleId(id))
      .map(([id, role]) => {
        const source = defaultRoleDefinition(
          id as Parameters<typeof defaultRoleDefinition>[0],
          {
            harness: role.harness,
            launch_profile_ref: role.launch_profile_ref,
          },
        );
        const hash = deploymentRolePolicyHash(source);
        return [
          id,
          { role, hash, matches: deploymentRolePolicyHash(role) === hash },
        ] as const;
      }),
  );
  let attempted = 0;
  for (const candidate of candidates) {
    if (attempted >= MAX_IDLE_ROLE_UPGRADES) break;
    const id = candidate.id;
    const unlock = await tryHostOpsLock(store, project, id);
    if (!unlock) continue; // Cardigan human attach holds the same lock for its lifetime.
    const defer = (
      reason: Parameters<typeof deferIdleAssignmentRoleUpgrade>[3],
    ) =>
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
    try {
      const before = store.uow.read((tx) => tx.assignments.get(project, id));
      if (!before || before.status !== "active") continue;
      // Pending owners sort first. A full batch must not probe every later terminal.
      if (
        !before.role_upgrade &&
        store.uow.read(inFlight) >= MAX_IDLE_ROLE_UPGRADES
      )
        break;
      if (
        before.runtime_ref &&
        Date.parse(before.role_upgrade?.retry_at ?? "") >
          Date.parse(clock.now())
      )
        continue;
      const ref = before.runtime_ref;
      if (ref) {
        try {
          const observed = await runtime.status(ref);
          const idle = observed.ok
            ? observed.value.process === "exited" ||
              (observed.value.process === "alive" &&
                observed.value.agent === "idle")
            : observed.error.code === "runtime_not_found";
          if (!idle) {
            if (before.role_upgrade)
              defer(observed.ok ? "runtime_busy" : "runtime_unavailable");
            continue;
          }
        } catch {
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
        const policy = policies.get(previous.role_id);
        if (
          !policy ||
          policy.role.status === "inactive" ||
          policy.role.version <= previous.role_version
        )
          return;
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
      // Human stop may already have confirmed exit and cleared runtime_ref.
      if (ref) {
        try {
          const released = await runtime.release(ref, { force: false });
          if (!released.ok && released.error.code !== "runtime_not_found") {
            defer("release_failed");
            continue;
          }
          if (released.ok) {
            const observed = await runtime.status(ref);
            if (
              !(observed.ok
                ? observed.value.process === "exited"
                : observed.error.code === "runtime_not_found")
            ) {
              defer("exit_unconfirmed");
              continue;
            }
          }
        } catch {
          defer("release_failed");
          continue;
        }
      }
      const finished = store.uow.run((tx) => {
        const effect = finishIdleAssignmentRoleUpgrade(
          loadCommandState(tx, project),
          { kind: "system", project_id: project },
          id,
          { ids: tx.ids, clock },
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
