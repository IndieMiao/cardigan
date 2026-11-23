import { createHash } from "node:crypto";
import {
  type CommandState,
  eventsOfType,
  type ProjectId,
  pendingRoleConflictActions,
  type RoleDefinition,
  requestDeploymentAction,
  resolveMatchedRoleActions,
  roleUpgradeDiff,
  rotatePmAfterDeployment,
  rotateStandingAfterDeployment,
  upgradeRoleAfterDeployment,
} from "@cardigan/domain";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import {
  DEFAULT_ROLE_KINDS,
  defaultRoleDefinition,
  isDefaultRoleId,
} from "@cardigan/roles";
import {
  listRoleVersions,
  persistRoleEffect,
  type ReadRepositories,
  type Store,
  type StoreTransactionContext,
} from "@cardigan/store";
import { persistPmRotation } from "./pm-rotation.js";
import {
  deploymentRolePolicyHash,
  expectedRolePolicy,
  recordRoleDeferral,
  syncOverlayRoles,
} from "./role-overlay.js";

export { deploymentRolePolicyHash };

/** Fingerprint the loaded package, not the mutable project role definitions. */
let loadedPackHash: string | undefined;
type PublishedRole = {
  readonly version: number;
  readonly policy_hash: string;
  readonly disposition: "matched" | "conflict" | "unverified";
};
type RolePackReceipt = {
  readonly pack_hash: string;
  readonly roles: Readonly<Record<string, PublishedRole>>;
};
export function defaultRolePackHash(): string {
  loadedPackHash ??= createHash("sha256")
    .update(
      JSON.stringify(
        Object.keys(DEFAULT_ROLE_KINDS)
          .sort()
          .map((id) => [
            id,
            deploymentRolePolicyHash(
              defaultRoleDefinition(id as keyof typeof DEFAULT_ROLE_KINDS, {
                harness: "codex",
                launch_profile_ref: "deployment",
              }),
            ),
          ]),
      ),
    )
    .digest("hex");
  return loadedPackHash;
}

/** Read both the publication fence and role in the caller's fresh transaction. */
export function idleRolePolicy(
  tx: ReadRepositories,
  project: ProjectId,
  id: string,
) {
  return idleRolePolicies(tx, project).get(id);
}

export function idleRolePolicies(tx: ReadRepositories, project: ProjectId) {
  const latest = new Map(
    listRoleVersions(tx, project).map((role) => [role.role_id, role]),
  );
  const publication = rolePackPublication(tx, project);
  return new Map(
    [...latest].flatMap(([id, role]) => {
      const expected = expectedRolePolicy(role);
      if (!expected) return [];
      const hash = deploymentRolePolicyHash(expected);
      const matches = deploymentRolePolicyHash(role) === hash;
      // Old installations may have no publication receipt. Matching defaults are
      // safe; an unexplained mismatch is never evidence of a manual edit.
      const receipt = publication?.payload as RolePackReceipt | undefined;
      const snapshot = receipt?.roles?.[id];
      const published = receipt
        ? receipt.pack_hash === defaultRolePackHash() &&
          !!snapshot &&
          role.version >= snapshot.version &&
          (role.version !== snapshot.version ||
            deploymentRolePolicyHash(role) === snapshot.policy_hash) &&
          (matches || snapshot.disposition !== "unverified")
        : matches;
      return [[id as string, { role, hash, matches, published }] as const];
    }),
  );
}

function rolePackPublication(tx: ReadRepositories, project: ProjectId) {
  // All receipts are in the project stream. Its sequence survives clock skew.
  return tx.events
    .listAfter(project, undefined, 0)
    .filter(
      (e) =>
        e.card_id === undefined &&
        e.type === "host_role_pack_published" &&
        e.actor.kind === "system" &&
        e.actor.project_id === project,
    )
    .sort((a, b) => a.seq - b.seq)
    .at(-1);
}

/** Run from the deployed build, so defaults come from that exact release. */
export function upgradeDeployedRoles(
  store: Store,
  project: ProjectId,
  changedRoles: readonly string[],
  previousDefaults: Readonly<Record<string, string>>,
  profiles: ReadonlySet<string> | (() => ReadonlySet<string>) = new Set(),
) {
  let loadedProfiles: ReadonlySet<string> | undefined;
  const profileNames = () =>
    (loadedProfiles ??= typeof profiles === "function" ? profiles() : profiles);
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
    // C-613: overlay roles follow the pack on every deployment.
    syncOverlayRoles(
      tx,
      project,
      clock.now,
      { changedRoles, previousDefaults, profiles: profileNames },
      true,
    );
    const ids = [
      ...new Set(listRoleVersions(tx, project).map((r) => r.role_id)),
    ];
    for (const id of ids) {
      if (!isDefaultRoleId(id) || !changedRoles.includes(id)) continue;
      const roles = listRoleVersions(tx, project);
      const latest = roles.filter((r) => r.role_id === id).at(-1);
      if (!latest || latest.status === "inactive" || latest.default_overlay)
        continue;
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
      if (!profileNames().has(source.launch_profile_ref)) {
        recordRoleDeferral(
          tx,
          project,
          `missing-profile:${id}:${latest.version}:${source.launch_profile_ref}`,
          `默认角色 ${id} 引用的启动配置 ${source.launch_profile_ref} 不存在或配置未通过校验；保留原版本 v${latest.version}，请 PM 排查。`,
          clock.now(),
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
    // Even a no-op publication needs a receipt. Commit it with all role writes;
    // a failed transaction cannot make a half-published pack look consistent.
    const pack_hash = defaultRolePackHash();
    const roles: Record<string, PublishedRole> = {};
    for (const role of listRoleVersions(tx, project)) {
      const policy = expectedRolePolicy(role);
      if (!policy) continue;
      const policy_hash = deploymentRolePolicyHash(role);
      const expected = deploymentRolePolicyHash(policy);
      const baseline = previousDefaults[role.role_id];
      roles[role.role_id] = {
        version: role.version,
        policy_hash,
        disposition:
          policy_hash === expected
            ? "matched"
            : baseline && policy_hash !== baseline
              ? "conflict"
              : "unverified",
      };
    }
    const receipt: RolePackReceipt = { pack_hash, roles };
    const previous = rolePackPublication(tx, project);
    if (JSON.stringify(previous?.payload) !== JSON.stringify(receipt))
      tx.events.append(project, {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(project),
        type: "host_role_pack_published",
        actor,
        created_at: clock.now(),
        payload: { ...receipt },
      });
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
    if (pendingRoleConflictActions(state).length) {
      const matched = new Set(
        [...idleRolePolicies(tx, project)]
          .filter(
            ([, p]) => p.role.status !== "inactive" && p.matches && p.published,
          )
          .map(([id]) => id),
      );
      const effect = unwrap(
        resolveMatchedRoleActions(state, actor, matched, ports),
      );
      persistEffect(tx, project, effect);
      if (effect.changes.length) state = loadState(tx, project);
    }
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
