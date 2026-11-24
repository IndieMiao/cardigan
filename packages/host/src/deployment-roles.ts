import { createHash } from "node:crypto";
import {
  type CommandState,
  deploymentAuditedVersion,
  eventsOfType,
  type ProjectId,
  pendingRoleConflictActions,
  requestDeploymentAction,
  resolveMatchedRoleActions,
  roleUpgradeDiff,
  rotatePmAfterDeployment,
  rotateStandingAfterDeployment,
  streamEventsBy,
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
import { knownDefaults } from "./role-provenance.js";

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

/**
 * The only project whose default roles are published by deployment
 * (`self-deploy roles`). A project with a publication receipt is managed too.
 */
export const ROLE_PACK_DEPLOYMENT_PROJECT = "cardigan";

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
  const managed =
    publication !== undefined || project === ROLE_PACK_DEPLOYMENT_PROJECT;
  return new Map(
    [...latest].flatMap(([id, role]) => {
      const expected = expectedRolePolicy(role);
      if (!expected) return [];
      const hash = deploymentRolePolicyHash(expected);
      const matches = deploymentRolePolicyHash(role) === hash;
      const receipt = publication?.payload as RolePackReceipt | undefined;
      const snapshot = receipt?.roles?.[id];
      // Old deployment-managed installations may have no publication receipt.
      // Matching defaults are safe; an unexplained mismatch is never evidence
      // of a manual edit there. Other projects never receive a publication:
      // their own latest version is authoritative and cannot conflict with it.
      const published = receipt
        ? receipt.pack_hash === defaultRolePackHash() &&
          !!snapshot &&
          role.version >= snapshot.version &&
          (role.version !== snapshot.version ||
            deploymentRolePolicyHash(role) === snapshot.policy_hash) &&
          (matches || snapshot.disposition !== "unverified")
        : matches || !managed;
      const conflict = managed && !matches;
      return [
        [id as string, { role, hash, matches, published, conflict }] as const,
      ];
    }),
  );
}

function rolePackPublication(tx: ReadRepositories, project: ProjectId) {
  // All receipts are in the project stream. Its sequence survives clock skew.
  return streamEventsBy(tx.events, project, undefined, "type", [
    "host_role_pack_published",
  ])
    .filter(
      (e) =>
        e.card_id === undefined &&
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
    // C-613: every role is first judged against the trusted default record;
    // what that pass decided is not judged again below.
    const handled = syncOverlayRoles(
      tx,
      project,
      clock.now,
      { profiles: profileNames },
      true,
    );
    const known = knownDefaults(tx, project);
    const ids = [
      ...new Set(listRoleVersions(tx, project).map((r) => r.role_id)),
    ];
    for (const id of ids) {
      if (!isDefaultRoleId(id) || !changedRoles.includes(id) || handled.has(id))
        continue;
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
        // Only a recorded older default makes a mismatch a manual edit to
        // review (C-603). Without one, e.g. an older supervisor's fingerprint
        // that omits machine requirements, nothing is proven: keep the version
        // and notify PM, opening no human action (V-3037:2).
        const sourceHash = deploymentRolePolicyHash(source);
        if (!(known.get(id) ?? []).some((k) => k.policy_hash !== sourceHash)) {
          recordRoleDeferral(
            tx,
            project,
            `unverified-default:${id}:${latest.version}:${sourceHash}`,
            `角色 ${id} v${latest.version} 与上一默认包指纹不一致，且没有可核对的已记录默认包；系统保留当前版本并通知 PM，未创建人工拍板。`,
            clock.now(),
          );
          continue;
        }
        if (source.instructions === undefined)
          throw new Error("Default role instructions missing");
        const diff = roleUpgradeDiff(latest, {
          ...source,
          instructions: source.instructions,
        });
        pending(
          `deployment-role-manual:${id}:${latest.version}:${sourceHash}`,
          `角色 ${id} 未自动升级：当前版本有手工改动，与已记录的默认版本都不一致。已保留当前版本 v${latest.version}；请人核对 role upgrade ${id} --from-default --dry-run 的差异，确认如何保留项目规则。\n${JSON.stringify(diff)}`,
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
  return rotateIdleDeployedRoles(
    store,
    project,
    loadCommandState,
    profileNames,
  );
}

/**
 * C-613 V-3073:1: a deployment's conclusion on a standing role's target
 * launch profile, per role, version and profile. Only the system writes it,
 * in the project stream and on no card, and only when it changes.
 */
export const LAUNCH_CHECKED_EVENT = "host_role_launch_checked";
interface LaunchTarget {
  readonly role_id: string;
  readonly role_version: number;
  readonly profile: string | undefined;
}

function lastLaunchCheck(
  tx: ReadRepositories,
  project: ProjectId,
  target: LaunchTarget,
): boolean | undefined {
  const last = streamEventsBy(tx.events, project, undefined, "type", [
    LAUNCH_CHECKED_EVENT,
  ])
    .filter((e) => {
      const p = e.payload as Partial<LaunchTarget>;
      return (
        e.card_id === undefined &&
        e.actor.kind === "system" &&
        e.actor.project_id === project &&
        p.role_id === target.role_id &&
        p.role_version === target.role_version &&
        p.profile === target.profile
      );
    })
    .sort((a, b) => a.seq - b.seq)
    .at(-1);
  const valid = (last?.payload as { valid?: unknown } | undefined)?.valid;
  return typeof valid === "boolean" ? valid : undefined;
}

function recordLaunchCheck(
  tx: StoreTransactionContext,
  project: ProjectId,
  target: LaunchTarget & { readonly profile: string },
  valid: boolean,
  at: string,
) {
  if (lastLaunchCheck(tx, project, target) === valid) return;
  tx.events.append(project, {
    id: tx.ids.nextEventId(),
    seq: tx.ids.nextEventSequence(project),
    type: LAUNCH_CHECKED_EVENT,
    actor: { kind: "system", project_id: project },
    created_at: at,
    payload: {
      role_id: target.role_id,
      role_version: target.role_version,
      profile: target.profile,
      valid,
    },
  });
}

/** Retry every maintenance tick; busy sessions retain their pinned version until idle. */
export function rotateIdleDeployedRoles(
  store: Store,
  project: ProjectId,
  loadState: (
    tx: StoreTransactionContext,
    project: ProjectId,
  ) => CommandState = loadCommandState,
  /** Valid launch profiles, known in a deployment only. */
  profiles?: () => ReadonlySet<string>,
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
      // Only to a version an audited system upgrade reaches (V-3037:1): an
      // upgrade audit to exactly that version, or a metadata-only audit that
      // carries one with the same policy and launch fields.
      const audited =
        latest &&
        deploymentAuditedVersion(state, previous.role_id, latest.role_version);
      if (
        !latest ||
        latest.role_version <= previous.role_version ||
        audited === undefined ||
        audited <= previous.role_version
      )
        continue;
      // The new session must be launchable. A deployment checks the profile
      // and records its conclusion, busy session or not; between deployments
      // that conclusion stands (V-3073:1), else only an unchanged profile is
      // taken.
      const pinned = state.roles.find(
        (r) =>
          r.role_id === previous.role_id &&
          r.role_version === previous.role_version,
      );
      const profile = latest.launch_profile_ref;
      const target = {
        role_id: previous.role_id,
        role_version: latest.role_version,
        profile,
      };
      let launchable: boolean;
      if (profiles) {
        launchable = profile !== undefined && profiles().has(profile);
        if (profile !== undefined)
          recordLaunchCheck(
            tx,
            project,
            { ...target, profile },
            launchable,
            clock.now(),
          );
      } else {
        // Already notified by the deployment that found it invalid.
        if (lastLaunchCheck(tx, project, target) === false) continue;
        launchable =
          profile !== undefined && profile === pinned?.launch_profile_ref;
      }
      if (!launchable) {
        recordRoleDeferral(
          tx,
          project,
          `rotation-profile:${previous.id}:${latest.role_version}:${profile}`,
          profiles
            ? `常驻角色 ${previous.role_id} v${latest.role_version} 的启动配置 ${profile} 不存在或未通过校验；系统保留原会话并通知 PM 排查。`
            : `常驻角色 ${previous.role_id} v${latest.role_version} 换了启动配置 ${profile}，部署之外无法核对；系统保留原会话，下次部署核对后再轮换。`,
          clock.now(),
        );
        continue;
      }
      if (
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
