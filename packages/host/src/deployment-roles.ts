import { createHash } from "node:crypto";
import {
  type CommandState,
  eventsOfType,
  type ProjectId,
  type RoleDefinition,
  requestDeploymentAction,
  roleUpgradeDiff,
  rotatePmAfterDeployment,
  rotateStandingAfterDeployment,
  upgradeRoleAfterDeployment,
} from "@cardigan/domain";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import { defaultRoleDefinition, isDefaultRoleId } from "@cardigan/roles";
import {
  listRoleVersions,
  persistRoleEffect,
  type Store,
  type StoreTransactionContext,
} from "@cardigan/store";
import { persistPmRotation } from "./pm-rotation.js";

function recordRoleDeferral(
  tx: StoreTransactionContext,
  project: ProjectId,
  key: string,
  notice: string,
  at: string,
) {
  if (
    tx.events
      .listAfter(project, undefined, 0)
      .some(
        (e) =>
          e.type === "host_role_upgrade_deferred" &&
          (e.payload as { key?: string }).key === key,
      )
  )
    return;
  tx.events.append(project, {
    id: tx.ids.nextEventId(),
    seq: tx.ids.nextEventSequence(project),
    type: "host_role_upgrade_deferred",
    actor: { kind: "system", project_id: project },
    created_at: at,
    payload: { key, notice },
  });
}

/** Only fields replaced by --from-default participate; project launch settings stay local. */
export function deploymentRolePolicyHash(role: RoleDefinition): string {
  const policy = {
    instructions: role.instructions ?? role.core_prompt ?? "",
    allowed_tools: [...role.allowed_tools].sort(),
    capabilities: [...role.capabilities].sort(),
    kind: role.kind,
    worktree: role.worktree,
  };
  return createHash("sha256").update(JSON.stringify(policy)).digest("hex");
}

/** Run from the deployed build, so defaults come from that exact release. */
export function upgradeDeployedRoles(
  store: Store,
  project: ProjectId,
  changedRoles: readonly string[],
  previousDefaults: Readonly<Record<string, string>>,
) {
  store.uow.run((tx) => {
    const actor = { kind: "system" as const, project_id: project };
    const clock = { now: () => new Date().toISOString() };
    const ports = { ids: tx.ids, clock };
    const pending = (key: string, instructions: string) =>
      persistEffect(
        tx,
        project,
        unwrap(
          requestDeploymentAction(
            loadCommandState(tx, project),
            actor,
            { key, instructions },
            ports,
          ),
        ),
      );
    const ids = [
      ...new Set(listRoleVersions(tx, project).map((r) => r.role_id)),
    ];
    for (const id of ids) {
      if (!isDefaultRoleId(id) || !changedRoles.includes(id)) continue;
      const roles = listRoleVersions(tx, project);
      const latest = roles.filter((r) => r.role_id === id).at(-1);
      if (!latest || latest.status === "inactive") continue;
      const source = defaultRoleDefinition(id, {
        harness: latest.harness,
        launch_profile_ref: latest.launch_profile_ref,
      });
      const currentHash = deploymentRolePolicyHash(latest);
      // No write is necessary when a formerly manual rule has reached the default pack.
      if (currentHash === deploymentRolePolicyHash(source)) continue;
      const baseline = Object.hasOwn(previousDefaults, id)
        ? previousDefaults[id]
        : undefined;
      if (!baseline) {
        recordRoleDeferral(
          tx,
          project,
          `missing-default:${id}:${latest.version}:${deploymentRolePolicyHash(source)}`,
          `角色 ${id} 缺少上一默认包指纹，系统保留当前版本并通知 PM 排查部署基线；未创建人工拍板。`,
          clock.now(),
        );
        continue;
      }
      if (currentHash !== baseline) {
        if (source.instructions === undefined)
          throw new Error("Default role instructions missing");
        const diff = roleUpgradeDiff(latest, {
          ...source,
          instructions: source.instructions,
        });
        pending(
          `deployment-role-manual:${id}:${latest.version}:${deploymentRolePolicyHash(source)}`,
          `角色 ${id} 未自动升级：${baseline ? "当前版本有手工改动，与上一次已部署默认版本不一致" : "缺少上一次已部署默认版本，无法确认当前版本是否有手工改动"}。已保留当前版本 v${latest.version}；请人核对 role upgrade ${id} --from-default --dry-run 的差异，确认如何保留项目规则。\n${JSON.stringify(diff)}`,
        );
        continue;
      }
      const result = unwrap(
        upgradeRoleAfterDeployment(
          { project_id: project, roles },
          actor,
          id,
          source,
          ports,
        ),
      );
      if (result.effect) {
        persistRoleEffect(tx, project, result.effect);
        tx.events.append(project, {
          id: tx.ids.nextEventId(),
          seq: tx.ids.nextEventSequence(project),
          type: "host_role_upgraded",
          actor,
          created_at: clock.now(),
          payload: {
            role_id: id,
            from_version: latest.version,
            to_version: result.effect.data.version,
            diff: JSON.parse(JSON.stringify(result.diff)),
            notice: `默认角色 ${id} 已随已部署版本自动升级：v${latest.version} → v${result.effect.data.version}。`,
          },
        });
      }
    }
  });
  return rotateIdleDeployedRoles(store, project);
}

/** Retry every maintenance tick; busy sessions retain their pinned version until idle. */
export function rotateIdleDeployedRoles(
  store: Store,
  project: ProjectId,
  loadState: (
    tx: StoreTransactionContext,
    project: ProjectId,
  ) => CommandState = loadCommandState,
) {
  return store.uow.run((tx) => {
    let state = loadState(tx, project);
    const actor = { kind: "system" as const, project_id: project };
    const clock = { now: () => new Date().toISOString() };
    const ports = { ids: tx.ids, clock };
    for (const previous of state.assignments) {
      if (
        previous.scope !== "standing" ||
        previous.status !== "active" ||
        previous.external
      )
        continue;
      const latest = state.roles
        .filter((r) => r.role_id === previous.role_id)
        .sort((a, b) => b.role_version - a.role_version)[0];
      if (
        !latest ||
        latest.role_version <= previous.role_version ||
        !eventsOfType(state.events, "host_role_upgraded").some(
          (e) =>
            e.actor.kind === "system" &&
            (e.payload as Record<string, unknown>).role_id ===
              previous.role_id &&
            (e.payload as Record<string, unknown>).to_version ===
              latest.role_version,
        ) ||
        state.runs.some(
          (r) =>
            r.assignment_id === previous.id &&
            !["completed", "failed", "cancelled"].includes(r.status),
        )
      )
        continue;
      const rotated =
        previous.role_id === "pm"
          ? rotatePmAfterDeployment(
              state,
              actor,
              listRoleVersions(tx, project),
              ports,
              previous.standing_mode ?? "ops",
            )
          : rotateStandingAfterDeployment(state, actor, previous.id, ports);
      if (!rotated.ok) {
        recordRoleDeferral(
          tx,
          project,
          `rotation:${previous.id}:${latest.role_version}:${rotated.error.code}`,
          `常驻角色 ${previous.role_id} 暂未轮换，系统保留原会话并通知 PM 排查：${rotated.error.message}`,
          clock.now(),
        );
        continue;
      }
      persistPmRotation(store, tx, project, rotated.value, clock.now());
      state = loadState(tx, project);
    }
    return state.assignments.find(
      (a) =>
        a.role_id === "pm" &&
        a.standing_mode === "ops" &&
        a.status === "active" &&
        !state.runs.some((r) => r.assignment_id === a.id) &&
        eventsOfType(state.events, "standing_pm_rotated").some(
          (e) =>
            e.actor.kind === "system" &&
            (e.payload as { assignment_id?: string }).assignment_id === a.id,
        ),
    )?.id;
  });
}
