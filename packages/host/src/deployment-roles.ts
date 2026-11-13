import { createHash } from "node:crypto";
import {
  type ProjectId,
  type RoleDefinition,
  requestDeploymentAction,
  roleUpgradeDiff,
  rotatePmAfterDeployment,
  upgradeRoleAfterDeployment,
} from "@cardigan/domain";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import { defaultRoleDefinition, isDefaultRoleId } from "@cardigan/roles";
import {
  listRoleVersions,
  persistRoleEffect,
  type Store,
} from "@cardigan/store";
import { persistPmRotation } from "./pm-rotation.js";

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
  return store.uow.run((tx) => {
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
    let pmChanged = false;
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
      if (!baseline || currentHash !== baseline) {
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
          },
        });
        pmChanged ||= id === "pm";
      } else if (result.diff.relaxations.length) {
        pending(
          `deployment-role:${id}:${latest.version}:${createHash("sha256").update(JSON.stringify(result.patch)).digest("hex")}`,
          `角色 ${id} 未自动升级：默认包会放宽权限。请人审核 role upgrade ${id} --from-default --dry-run 的差异后处理。\n${JSON.stringify(result.diff)}`,
        );
      }
    }
    const state = loadCommandState(tx, project);
    if (!pmChanged) {
      // A previous post-deploy invocation may have rotated before failing to start.
      const pendingStart = state.assignments.find(
        (a) =>
          a.role_id === "pm" &&
          a.standing_mode === "ops" &&
          a.status === "active" &&
          !state.runs.some((r) => r.assignment_id === a.id) &&
          state.events.some(
            (e) =>
              e.type === "standing_pm_rotated" &&
              e.actor.kind === "system" &&
              (e.payload as { assignment_id?: string }).assignment_id === a.id,
          ),
      );
      return pendingStart?.id;
    }
    if (
      !state.assignments.some(
        (a) =>
          a.role_id === "pm" &&
          a.standing_mode === "ops" &&
          a.status === "active",
      )
    )
      return undefined;
    const rotated = rotatePmAfterDeployment(
      state,
      actor,
      listRoleVersions(tx, project),
      ports,
    );
    if (!rotated.ok) {
      pending(
        `deployment-pm:${
          listRoleVersions(tx, project)
            .filter((r) => r.role_id === "pm")
            .at(-1)?.version
        }`,
        `PM 默认包已更新，自动轮换未执行：${rotated.error.message}。请核对 pm rotate --ops。`,
      );
      return undefined;
    }
    persistPmRotation(store, tx, project, rotated.value, clock.now());
    return rotated.value.data.assignment.id;
  });
}
