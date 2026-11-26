import { createHash } from "node:crypto";
import {
  type Assignment,
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
} from "@cardigan/domain";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import {
  DEFAULT_ROLE_KINDS,
  defaultRoleDefinition,
  isDefaultRoleId,
} from "@cardigan/roles";
import {
  listRoleVersions,
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
  /** The supervisor's fingerprints; kept for its interface, never trusted (C-603). */
  _previousDefaults: Readonly<Record<string, string>>,
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
    // C-603 (Q-1186): only the trusted record proves a version untouched.
    // This release's own default is no evidence, so a rerun of one release
    // reaches the same conclusion.
    const known = knownDefaults(tx, project);
    const olderRecorded = (id: string) => {
      if (!isDefaultRoleId(id)) return false;
      const current = deploymentRolePolicyHash(
        defaultRoleDefinition(id, {
          harness: "codex",
          launch_profile_ref: "deployment",
        }),
      );
      return (known.get(id) ?? []).some((k) => k.policy_hash !== current);
    };
    const ids = [
      ...new Set(listRoleVersions(tx, project).map((r) => r.role_id)),
    ];
    for (const id of ids) {
      if (!isDefaultRoleId(id) || !changedRoles.includes(id) || handled.has(id))
        continue;
      const latest = listRoleVersions(tx, project)
        .filter((r) => r.role_id === id)
        .at(-1);
      if (!latest || latest.status === "inactive" || latest.default_overlay)
        continue;
      const source = defaultRoleDefinition(id, {
        harness: latest.harness,
        launch_profile_ref: latest.launch_profile_ref,
      });
      const sourceHash = deploymentRolePolicyHash(source);
      // No write is necessary when a formerly manual rule has reached the default pack.
      if (deploymentRolePolicyHash(latest) === sourceHash) continue;
      // Every version equal to a recorded default was upgraded above. The
      // supervisor's fingerprint decides nothing: an older supervisor hashes
      // without machine requirements, so it cannot tell them from a hand edit.
      if (!olderRecorded(id)) {
        recordRoleDeferral(
          tx,
          project,
          `unverified-default:${id}:${latest.version}:${sourceHash}`,
          `角色 ${id} v${latest.version} 与新默认包不同，且没有可核对的已记录默认包；系统保留当前版本并通知 PM，未创建人工拍板。`,
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
      roles[role.role_id] = {
        version: role.version,
        policy_hash,
        disposition:
          policy_hash === expected
            ? "matched"
            : olderRecorded(role.role_id)
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

/**
 * The newest role version a standing Assignment should rotate to: only one an
 * audited system upgrade reaches (V-3037:1), an upgrade audit to exactly that
 * version or a metadata-only audit carrying one with the same policy and
 * launch fields. Launchability and idleness are judged by the caller.
 */
function rotationTarget(state: CommandState, previous: Assignment) {
  if (
    previous.scope !== "standing" ||
    previous.status !== "active" ||
    previous.external
  )
    return undefined;
  const latest = state.roles
    .filter((r) => r.role_id === previous.role_id)
    .sort((a, b) => b.role_version - a.role_version)[0];
  if (!latest || latest.role_version <= previous.role_version) return undefined;
  const audited = deploymentAuditedVersion(
    state,
    previous.role_id,
    latest.role_version,
  );
  if (audited === undefined || audited <= previous.role_version)
    return undefined;
  return latest;
}

/**
 * C-786: when a deployed role upgrade reaches a standing session. Rotating
 * drops the session's context (PM Office loses what it was holding), so an
 * ordinary upgrade waits and several deployments collapse into one rotation.
 */
export interface StandingRotationPolicy {
  /** Rotate once the session has had no activity this long; 0 rotates as
   * soon as its Run ends (the pre-C-786 behaviour, also the off switch). */
  readonly quiet_ms: number;
  /** An upgrade pending this long rotates at the next idle moment anyway. */
  readonly max_defer_ms: number;
}
/** Same as the idle threshold that retires work-item sessions. */
export const STANDING_ROTATION_QUIET_MINUTES = 60;
export const STANDING_ROTATION_MAX_DEFER_MINUTES = 720;

function minutes(raw: string | undefined, fallback: number, min: number) {
  if (raw === undefined || !/^\d+$/u.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= 10_080
    ? value
    : fallback;
}

/** Host settings; an unreadable value keeps the default rather than stopping maintenance. */
export function standingRotationPolicy(
  env: Readonly<Record<string, string | undefined>> = process.env,
): StandingRotationPolicy {
  return {
    quiet_ms:
      minutes(
        env.CARDIGAN_STANDING_ROTATION_QUIET_MINUTES,
        STANDING_ROTATION_QUIET_MINUTES,
        0,
      ) * 60_000,
    max_defer_ms:
      minutes(
        env.CARDIGAN_STANDING_ROTATION_MAX_DEFER_MINUTES,
        STANDING_ROTATION_MAX_DEFER_MINUTES,
        1,
      ) * 60_000,
  };
}

export type StandingRotationTrigger =
  | "immediate"
  | "security"
  | "no_session"
  | "quiet"
  | "max_defer";

const upgradeAudits = (state: CommandState, roleId: string) =>
  eventsOfType(state.events, "host_role_upgraded").filter(
    (e) =>
      e.actor.kind === "system" &&
      e.card_id === undefined &&
      (e.payload as { role_id?: unknown }).role_id === roleId,
  );
const auditVersion = (e: { payload: unknown }) =>
  (e.payload as { to_version?: unknown }).to_version;
const auditRevision = (e: { payload: unknown }) => {
  const r = (e.payload as { security_revision?: unknown }).security_revision;
  return typeof r === "number" && Number.isSafeInteger(r) ? r : 0;
};

/**
 * C-786: whether a rotation to `latest` is due now, and why; undefined keeps
 * the pinned version for now. Pure: judged from the state and `now` only.
 *
 * - `security`: an upgrade between the pinned and the target version carries
 *   a higher security revision than the pinned version (roles package
 *   `ROLE_SECURITY_REVISIONS`), so it never waits.
 * - `no_session`: the Assignment has no live session; its next wake starts a
 *   new one anyway, so no context is lost.
 * - `quiet`: no Run or Card MCP activity for `quiet_ms`.
 * - `max_defer`: the oldest pending upgrade has waited `max_defer_ms`.
 */
export function standingRotationDue(
  state: CommandState,
  previous: Assignment,
  latest: { readonly role_version: number },
  now: string,
  policy: StandingRotationPolicy,
): StandingRotationTrigger | undefined {
  if (policy.quiet_ms === 0) return "immediate";
  const audits = upgradeAudits(state, previous.role_id);
  const pinnedRevision = Math.max(
    0,
    ...audits
      .filter((e) => {
        const v = auditVersion(e);
        return typeof v === "number" && v <= previous.role_version;
      })
      .map(auditRevision),
  );
  const pending = audits.filter((e) => {
    const v = auditVersion(e);
    return (
      typeof v === "number" &&
      v > previous.role_version &&
      v <= latest.role_version
    );
  });
  if (pending.some((e) => auditRevision(e) > pinnedRevision)) return "security";
  if (!previous.runtime_ref) return "no_session";
  const at = Date.parse(now);
  const times = [
    previous.created_at,
    previous.last_mcp_activity_at,
    ...state.runs
      .filter((r) => r.assignment_id === previous.id)
      .flatMap((r) => [r.started_at, r.finished_at, r.heartbeat_at]),
  ]
    .map((t) => (t ? Date.parse(t) : Number.NaN))
    .filter((t) => Number.isFinite(t));
  const lastActivity = Math.max(0, ...times);
  if (at - lastActivity >= policy.quiet_ms) return "quiet";
  const since = Math.min(
    ...pending.map((e) => Date.parse(e.created_at)).filter(Number.isFinite),
  );
  if (Number.isFinite(since) && at - since >= policy.max_defer_ms)
    return "max_defer";
  return undefined;
}

/** C-786: the host's record of why a deferred standing rotation went ahead. */
export const ROTATION_DUE_EVENT = "host_standing_rotation_due";

/** A session with an unfinished Run keeps its pinned version until idle. */
function rotationBusy(state: CommandState, previous: Assignment) {
  return state.runs.some(
    (r) =>
      r.assignment_id === previous.id &&
      !["completed", "failed", "cancelled"].includes(r.status),
  );
}

function rotatedPm(state: CommandState) {
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
}

/** Retry every maintenance tick; busy sessions retain their pinned version until idle. */
export function rotateIdleDeployedRoles(
  store: Store,
  project: ProjectId,
  loadState: (
    tx: Parameters<typeof loadCommandState>[0],
    project: ProjectId,
  ) => CommandState = loadCommandState,
  /** Valid launch profiles, known in a deployment only. */
  profiles?: () => ReadonlySet<string>,
  policy: StandingRotationPolicy = standingRotationPolicy(),
  clock: { now(): string } = { now: () => new Date().toISOString() },
) {
  // C-641: decide in a read snapshot; only pending work takes the writer lock,
  // and the locked pass below re-evaluates everything.
  const settled = store.uow.optimistic(project, (tx) => {
    const state = loadState(tx, project);
    return {
      value:
        pendingRoleConflictActions(state).length ||
        // A deployment records launch checks for busy sessions too.
        state.assignments.some((a) => {
          const latest = rotationTarget(state, a);
          return (
            latest &&
            (profiles ||
              (!rotationBusy(state, a) &&
                standingRotationDue(state, a, latest, clock.now(), policy)))
          );
        })
          ? undefined
          : { pm: rotatedPm(state) },
    };
  });
  if (settled) return settled.pm;
  return store.uow.run((tx) => {
    let state = loadState(tx, project);
    const actor = { kind: "system" as const, project_id: project };
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
      const latest = rotationTarget(state, previous);
      if (!latest) continue;
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
      if (rotationBusy(state, previous)) continue;
      const trigger = standingRotationDue(
        state,
        previous,
        latest,
        clock.now(),
        policy,
      );
      if (!trigger) continue;
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
      tx.events.append(project, {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(project),
        type: ROTATION_DUE_EVENT,
        actor,
        created_at: clock.now(),
        payload: {
          role_id: previous.role_id,
          previous_assignment_id: previous.id,
          assignment_id: rotated.value.data.assignment.id,
          from_version: previous.role_version,
          to_version: rotated.value.data.to_version,
          trigger,
        },
      });
      persistPmRotation(store, tx, project, rotated.value, clock.now());
      state = loadState(tx, project);
    }
    return rotatedPm(state);
  });
}
