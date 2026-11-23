import { createHash } from "node:crypto";
import {
  composeRoleOverlay,
  type ProjectId,
  type Role,
  type RoleDefinition,
  type RoleOverlay,
  type RoleOverlayRules,
  type ToolName,
  upgradeRoleAfterDeployment,
} from "@cardigan/domain";
import { defaultRoleDefinition, isDefaultRoleId } from "@cardigan/roles";
import {
  listRoleVersions,
  persistRoleEffect,
  type Store,
  type StoreTransactionContext,
} from "@cardigan/store";

/**
 * C-613: a project role is a default-pack role plus the project's own rules.
 * This module is the single place that tells which default a role version
 * should equal; deployment receipts, idle session upgrades and the CLI share it.
 */

/** Only fields replaced by --from-default participate; project launch settings stay local. */
export function deploymentRolePolicyHash(role: RoleDefinition): string {
  const policy = {
    instructions: role.instructions ?? role.core_prompt ?? "",
    allowed_tools: [...role.allowed_tools].sort(),
    capabilities: [...role.capabilities].sort(),
    kind: role.kind,
    worktree: role.worktree,
    // Keep historical hashes for roles with no machine capability constraints.
    ...(role.required_capabilities?.length
      ? { required_capabilities: [...role.required_capabilities].sort() }
      : {}),
  };
  return createHash("sha256").update(JSON.stringify(policy)).digest("hex");
}

export function recordRoleDeferral(
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

function packRole(
  id: string,
  role: Pick<Role, "harness" | "launch_profile_ref">,
) {
  if (!isDefaultRoleId(id)) return undefined;
  return defaultRoleDefinition(id, {
    harness: role.harness,
    launch_profile_ref: role.launch_profile_ref,
  });
}

/**
 * The deployed default role composed with `rules`, keeping the project's own
 * launch fields. Undefined when the base is not in the default pack.
 */
export function composeOverlaySource(
  role: Role,
  rules: RoleOverlayRules,
): (RoleDefinition & { readonly default_overlay: RoleOverlay }) | undefined {
  const base = packRole(rules.base_role_id, role);
  if (!base) return undefined;
  const composed: RoleDefinition = {
    ...base,
    ...composeRoleOverlay(base, rules),
    role_id: role.role_id,
    display_name: role.display_name,
    abilities: role.abilities,
    required_machine_tags: role.required_machine_tags,
  };
  return {
    ...composed,
    default_overlay: {
      base_role_id: rules.base_role_id,
      append_instructions: rules.append_instructions.trim(),
      extra_tools: [...rules.extra_tools],
      removed_tools: [...rules.removed_tools],
      base_hash: deploymentRolePolicyHash(base),
      composed_hash: deploymentRolePolicyHash(composed),
    },
  };
}

/** What the current deployed pack says this version should be, if anything. */
export function expectedRolePolicy(role: Role): RoleDefinition | undefined {
  return role.default_overlay
    ? composeOverlaySource(role, role.default_overlay)
    : packRole(role.role_id, role);
}

/** An overlay version later edited by hand no longer equals its own composition. */
export function overlayEditedByHand(role: Role): boolean {
  return (
    !!role.default_overlay &&
    deploymentRolePolicyHash(role) !== role.default_overlay.composed_hash
  );
}

/** What the deployment supervisor reports about this release's default pack. */
export interface DeployedPack {
  readonly changedRoles: readonly string[];
  /** Policy hashes of the previously deployed defaults, by role id. */
  readonly previousDefaults: Readonly<Record<string, string>>;
}

const paragraphs = (text: string) =>
  text
    .split(/\n[ \t]*\n/u)
    .map((p) => p.trim())
    .filter(Boolean);

export interface DerivedOverlay {
  readonly rules: RoleOverlayRules;
  /** Default paragraphs the role lacks; composing adds them back. */
  readonly missing: readonly string[];
  /**
   * Default tools the role lacks. A lack is read as "not yet installed", never
   * as a removal: only an explicit removal keeps a default tool out.
   */
  readonly missing_tools: readonly ToolName[];
  /** Policy fields an overlay cannot express (kind, worktree, capabilities...). */
  readonly mismatched: readonly string[];
  /** Project paragraphs were interleaved and are moved after the default text. */
  readonly moved: boolean;
}

/**
 * Read a role as `base + rules`. Every project paragraph and tool choice is
 * kept; a lossless reading has no `missing` or `mismatched` entries.
 */
export function deriveOverlayRules(
  role: Role,
  baseRoleId: string,
): DerivedOverlay | undefined {
  const base = packRole(baseRoleId, role);
  if (!base) return undefined;
  const set = (values: readonly string[] | undefined) =>
    [...new Set(values ?? [])].sort().join("\n");
  const mismatched = [
    ...(role.kind !== base.kind ? ["kind"] : []),
    ...(role.worktree !== base.worktree ? ["worktree"] : []),
    ...(set(role.capabilities) !== set(base.capabilities)
      ? ["capabilities"]
      : []),
    ...(set(role.required_capabilities) !== set(base.required_capabilities)
      ? ["required_capabilities"]
      : []),
    ...(role.instructions === undefined ? ["instructions"] : []),
  ];
  const baseTools = composeRoleOverlay(base, {
    append_instructions: "",
    extra_tools: [],
    removed_tools: [],
  }).allowed_tools;
  const extra_tools = [...new Set(role.allowed_tools)].filter(
    (t) => !baseTools.includes(t),
  ) as ToolName[];
  const missing_tools = baseTools.filter(
    (t) => !role.allowed_tools.includes(t),
  );
  const own = role.instructions ?? role.core_prompt;
  const baseText = (base.instructions ?? "").replace(/\s+$/u, "");
  let append: string;
  let missing: string[] = [];
  const rest = own.slice(baseText.length);
  if (own.startsWith(baseText) && (rest === "" || /^\s/u.test(rest)))
    append = rest.trim();
  else {
    const ownParts = paragraphs(own);
    const baseParts = paragraphs(baseText);
    append = [...new Set(ownParts.filter((p) => !baseParts.includes(p)))].join(
      "\n\n",
    );
    missing = baseParts.filter((p) => !ownParts.includes(p));
  }
  const rules: RoleOverlayRules = {
    base_role_id: baseRoleId,
    append_instructions: append,
    extra_tools,
    removed_tools: [],
  };
  const composed = composeRoleOverlay(base, rules).instructions;
  return {
    rules,
    missing,
    missing_tools,
    mismatched,
    moved:
      missing.length === 0 &&
      paragraphs(composed).join("\n\n") !== paragraphs(own).join("\n\n"),
  };
}

/** Before/after facts for a notice or the CLI; no instruction text is lost. */
export function overlaySummary(rules: RoleOverlayRules) {
  return {
    base_role_id: rules.base_role_id,
    appended_paragraphs: paragraphs(rules.append_instructions).length,
    extra_tools: [...rules.extra_tools],
    removed_tools: [...rules.removed_tools],
  };
}

/**
 * Deployment pass for one project (C-613), run from the deployed build:
 * overlay roles are recomposed from the new pack; a hand-customised default
 * role is migrated when it reads losslessly as `default + rules`. Nothing here
 * creates a human action: problems keep the current version and notify PM.
 */
export function syncOverlayRoles(
  tx: StoreTransactionContext,
  project: ProjectId,
  now: () => string,
  pack: DeployedPack,
  /** False where the default-pack path already reports a customised role. */
  noticeCandidates = true,
) {
  const actor = { kind: "system" as const, project_id: project };
  const ports = { ids: tx.ids, clock: { now } };
  const ids = [...new Set(listRoleVersions(tx, project).map((r) => r.role_id))];
  for (const id of ids) {
    const roles = listRoleVersions(tx, project);
    const latest = roles.filter((r) => r.role_id === id).at(-1);
    if (!latest || latest.status === "inactive") continue;
    const overlay = latest.default_overlay;
    let source: ReturnType<typeof composeOverlaySource>;
    let migrated: DerivedOverlay | undefined;
    if (!overlay) {
      const current = packRole(id, latest);
      const hash = deploymentRolePolicyHash(latest);
      // Plain default roles, current or previous, keep the default-pack path:
      // a tool or paragraph the new pack dropped must not become a project rule.
      if (
        !current ||
        hash === deploymentRolePolicyHash(current) ||
        (Object.hasOwn(pack.previousDefaults, id) &&
          pack.previousDefaults[id] === hash)
      )
        continue;
      // When this release changed the role's default, a project-looking extra
      // may be exactly what the pack just withdrew; never guess at deployment.
      const changed = pack.changedRoles.includes(id);
      migrated = deriveOverlayRules(latest, id);
      if (!migrated) continue;
      // Lacking default text or tools may be an older pack or a deliberate
      // removal; neither is guessed at deployment.
      if (
        changed ||
        migrated.mismatched.length ||
        migrated.missing.length ||
        migrated.missing_tools.length
      ) {
        if (noticeCandidates)
          recordRoleDeferral(
            tx,
            project,
            `overlay-candidate:${id}:${latest.version}:${deploymentRolePolicyHash(current)}`,
            `角色 ${id} v${latest.version} 是项目定制版，但不能无损读成“当前默认包 + 附加规则”（${[
              ...(changed ? ["本次部署改动了它的默认包"] : []),
              ...migrated.mismatched.map((f) => `${f} 与默认包不同`),
              ...(migrated.missing.length
                ? [`缺少默认包的 ${migrated.missing.length} 段说明`]
                : []),
              ...(migrated.missing_tools.length
                ? [`缺少默认包工具 ${migrated.missing_tools.join("、")}`]
                : []),
            ].join(
              "，",
            )}），暂不自动迁移；可用 cardigan role overlay ${id} --project ${project} --dry-run 查看迁移结果。`,
            now(),
          );
        continue;
      }
      source = composeOverlaySource(latest, migrated.rules);
    } else {
      if (overlayEditedByHand(latest)) {
        recordRoleDeferral(
          tx,
          project,
          `overlay-edited:${id}:${latest.version}`,
          `角色 ${id} v${latest.version} 在项目附加规则之外另有改动，系统保留当前版本、不按默认包重组；可用 cardigan role overlay ${id} --project ${project} --dry-run 重新登记附加规则。`,
          now(),
        );
        continue;
      }
      source = composeOverlaySource(latest, overlay);
      if (!source) {
        recordRoleDeferral(
          tx,
          project,
          `overlay-base:${id}:${latest.version}:${overlay.base_role_id}`,
          `角色 ${id} 的附加规则以 ${overlay.base_role_id} 为底，但当前默认包没有这个角色；保留 v${latest.version}，请 PM 排查。`,
          now(),
        );
        continue;
      }
    }
    if (!source) continue;
    const result = upgradeRoleAfterDeployment(
      { project_id: project, roles },
      actor,
      id,
      source,
      ports,
    );
    if (!result.ok) {
      recordRoleDeferral(
        tx,
        project,
        `overlay-conflict:${id}:${latest.version}:${source.default_overlay.composed_hash}`,
        `角色 ${id} 的新默认包与项目附加规则冲突（${result.error.message}），系统保留 v${latest.version}；请 PM 调整附加规则。`,
        now(),
      );
      continue;
    }
    const effect = result.value.effect;
    if (!effect) continue;
    persistRoleEffect(tx, project, effect);
    const to = effect.data.version;
    if (migrated)
      tx.events.append(project, {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(project),
        type: "host_role_overlay_migrated",
        actor,
        created_at: now(),
        payload: {
          role_id: id,
          from_version: latest.version,
          to_version: to,
          before_hash: deploymentRolePolicyHash(latest),
          after_hash: source.default_overlay.composed_hash,
          moved: migrated.moved,
          overlay: overlaySummary(migrated.rules),
          notice: `角色 ${id} 已迁移为“默认包 + 项目附加规则”：v${latest.version} → v${to}，保留追加说明 ${overlaySummary(migrated.rules).appended_paragraphs} 段${migrated.rules.extra_tools.length ? `、额外工具 ${migrated.rules.extra_tools.join("、")}` : ""}${migrated.rules.removed_tools.length ? `、移除工具 ${migrated.rules.removed_tools.join("、")}` : ""}${migrated.moved ? "；追加说明已移到默认说明之后" : ""}。`,
        },
      });
    else if (source.default_overlay.composed_hash !== overlay?.composed_hash)
      tx.events.append(project, {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(project),
        type: "host_role_upgraded",
        actor,
        created_at: now(),
        payload: {
          role_id: id,
          from_version: latest.version,
          to_version: to,
          diff: JSON.parse(JSON.stringify(result.value.diff)),
          overlay: overlaySummary(source.default_overlay),
          notice: `角色 ${id} 已按新默认包和项目附加规则自动升级：v${latest.version} → v${to}。`,
        },
      });
  }
}

/** Projects without the bootstrap deployment receipt only take the overlay pass. */
export function syncProjectOverlayRoles(
  store: Store,
  project: ProjectId,
  pack: DeployedPack,
) {
  store.uow.run((tx) =>
    syncOverlayRoles(tx, project, () => new Date().toISOString(), pack),
  );
}
