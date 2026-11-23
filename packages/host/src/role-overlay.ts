import {
  composeRoleOverlay,
  deploymentAuditedVersion,
  type ProjectId,
  type Role,
  type RoleDefinition,
  type RoleOverlay,
  type RoleOverlayRules,
  roleReference,
  type ToolName,
  upgradeRoleAfterDeployment,
} from "@cardigan/domain";
import {
  DEFAULT_ROLE_KINDS,
  defaultRoleDefinition,
  isDefaultRoleId,
} from "@cardigan/roles";
import {
  listRoleVersions,
  persistRoleEffect,
  type Store,
  type StoreTransactionContext,
} from "@cardigan/store";
import { deploymentRolePolicyHash } from "./role-policy-hash.js";
import {
  type KnownDefault,
  knownDefault,
  knownDefaults,
  paragraphs,
  readOnOlderDefault,
  rememberDefault,
} from "./role-provenance.js";

/**
 * C-613: a project role is a default-pack role plus the project's own rules.
 * This module is the single place that tells which default a role version
 * should equal; deployment receipts, idle session upgrades and the CLI share it.
 */

export { deploymentRolePolicyHash };

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
      ...(rules.instructions_mode === "replace" && {
        instructions_mode: "replace" as const,
      }),
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

/**
 * What a deployment pass needs besides the loaded pack. Provenance comes from
 * the trusted default record only, never from the supervisor's fingerprints
 * or its list of changed roles.
 */
export interface DeployedPack {
  /** Launch profiles that pass validation; read only when a version is written. */
  readonly profiles?: () => ReadonlySet<string>;
}

export interface DerivedOverlay {
  readonly rules: RoleOverlayRules;
  /** Default paragraphs the role lacks; composing adds them back. */
  readonly missing: readonly string[];
  /**
   * Default tools the role lacks. The rules keep them out (`removed_tools`),
   * so a reading never widens permissions; a deployment does not guess at it.
   */
  readonly missing_tools: readonly ToolName[];
  /** Policy fields an overlay cannot express (kind, worktree, capabilities...). */
  readonly mismatched: readonly string[];
  /** Project paragraphs were interleaved and are moved after the default text. */
  readonly moved: boolean;
}

const baseToolsOf = (base: RoleDefinition) =>
  composeRoleOverlay(base, {
    append_instructions: "",
    extra_tools: [],
    removed_tools: [],
  }).allowed_tools;

/**
 * Read a role as `base + rules`, keeping its current text and permissions:
 * every project paragraph (each occurrence) is kept, and a lacking default
 * tool becomes an explicit removal. Lossless means no `missing`,
 * `missing_tools` or `mismatched` entries. `replace` keeps the role's whole
 * text for a role of its own.
 */
export function deriveOverlayRules(
  role: Role,
  baseRoleId: string,
  mode: "append" | "replace" = "append",
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
  const baseTools = baseToolsOf(base);
  const extra_tools = [...new Set(role.allowed_tools)].filter(
    (t) => !baseTools.includes(t),
  ) as ToolName[];
  // withdraw_review follows submit_review: it is removed only together.
  const missing_tools = baseTools.filter(
    (t) =>
      !role.allowed_tools.includes(t) &&
      (t !== "withdraw_review" ||
        !role.allowed_tools.includes("submit_review")),
  );
  const own = role.instructions ?? role.core_prompt;
  const baseText = (base.instructions ?? "").replace(/\s+$/u, "");
  let append: string;
  let missing: string[] = [];
  const rest = own.slice(baseText.length);
  if (mode === "replace") append = own.trim();
  else if (own.startsWith(baseText) && (rest === "" || /^\s/u.test(rest)))
    append = rest.trim();
  else {
    // Match by occurrence: a repeated project paragraph is kept every time.
    const unused = paragraphs(baseText);
    const extra: string[] = [];
    for (const part of paragraphs(own)) {
      const at = unused.indexOf(part);
      if (at >= 0) unused.splice(at, 1);
      else extra.push(part);
    }
    append = extra.join("\n\n");
    missing = unused;
  }
  const rules: RoleOverlayRules = {
    base_role_id: baseRoleId,
    append_instructions: append,
    ...(mode === "replace" && { instructions_mode: "replace" as const }),
    extra_tools,
    removed_tools: missing_tools,
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
    ...(rules.instructions_mode === "replace" && {
      instructions_mode: "replace",
    }),
    appended_paragraphs: paragraphs(rules.append_instructions).length,
    extra_tools: [...rules.extra_tools],
    removed_tools: [...rules.removed_tools],
  };
}

type Plan =
  | { readonly kind: "skip" }
  | { readonly kind: "notice"; readonly key: string; readonly text: string }
  | {
      readonly kind: "write";
      readonly source: RoleDefinition;
      readonly composed_hash: string;
      readonly migrated?: { readonly rules: RoleOverlayRules; moved: boolean };
    };

interface PlanContext {
  readonly project: ProjectId;
  readonly defaultPath: boolean;
  readonly known: ReadonlyMap<string, readonly KnownDefault[]>;
  /** Keep a proven older default, so a deferral or a later release reuses it. */
  readonly remember: (id: string, value: RoleDefinition) => void;
}

function overlayWrite(
  latest: Role,
  rules: RoleOverlayRules,
  moved: boolean,
): Plan | undefined {
  const source = composeOverlaySource(latest, rules);
  return (
    source && {
      kind: "write",
      source,
      composed_hash: source.default_overlay.composed_hash,
      migrated: { rules, moved },
    }
  );
}

/**
 * The C-613 provenance order, the same for every project (Q-1197):
 * 1. equal to the current default: nothing to do;
 * 2. equal to any recorded older default: untouched, take the new default;
 * 3./4. an older recorded default plus project rules (`readOnOlderDefault`):
 *    recompose them on the new default;
 * 5. otherwise keep the version. The bootstrap project leaves it to the
 *    default-pack path; elsewhere PM is notified.
 * "Older" excludes this release's own default, so a rerun of one release
 * reaches the same conclusion.
 */
function planRole(latest: Role, c: PlanContext): Plan {
  const id = latest.role_id;
  const hint = `cardigan role overlay ${id} --project ${c.project} --dry-run`;
  const overlay = latest.default_overlay;
  if (overlay) {
    if (overlayEditedByHand(latest))
      return {
        kind: "notice",
        key: `overlay-edited:${id}:${latest.version}`,
        text: `角色 ${id} v${latest.version} 在项目附加规则之外另有改动，系统保留当前版本、不按默认包重组；需要人用 ${hint} 核对后重新登记附加规则。`,
      };
    const source = composeOverlaySource(latest, overlay);
    if (!source)
      return {
        kind: "notice",
        key: `overlay-base:${id}:${latest.version}:${overlay.base_role_id}`,
        text: `角色 ${id} 的附加规则以 ${overlay.base_role_id} 为底，但当前默认包没有这个角色；保留 v${latest.version}，请 PM 排查。`,
      };
    return {
      kind: "write",
      source,
      composed_hash: source.default_overlay.composed_hash,
    };
  }
  const current = packRole(id, latest);
  if (!current) return { kind: "skip" };
  const currentHash = deploymentRolePolicyHash(current);
  const hash = deploymentRolePolicyHash(latest);
  if (hash === currentHash) return { kind: "skip" };
  const older = (c.known.get(id) ?? []).filter(
    (k) => k.policy_hash !== currentHash,
  );
  if (older.some((k) => k.policy_hash === hash))
    return { kind: "write", source: current, composed_hash: currentHash };
  const reading = readOnOlderDefault(latest, current, older);
  if (reading) {
    if (reading.proven) c.remember(id, reading.proven);
    const { append_instructions, extra_tools, removed_tools } = reading.rules;
    // Everything beyond the older default is in the new one already.
    if (!append_instructions && !extra_tools.length && !removed_tools.length)
      return { kind: "write", source: current, composed_hash: currentHash };
    const plan = overlayWrite(latest, reading.rules, false);
    if (plan) return plan;
  }
  if (c.defaultPath) return { kind: "skip" };
  const derived = deriveOverlayRules(latest, id);
  const reasons = [
    ...(older.length ? [] : ["没有可核对的更早默认包记录"]),
    ...(derived?.mismatched ?? []).map((f) => `${f} 与默认包不同`),
    ...(derived?.missing.length
      ? [`缺少默认包的 ${derived.missing.length} 段说明`]
      : []),
    ...(derived?.missing_tools.length
      ? [`缺少默认包工具 ${derived.missing_tools.join("、")}`]
      : []),
  ];
  return {
    kind: "notice",
    key: `overlay-candidate:${id}:${latest.version}:${currentHash}`,
    text: `角色 ${id} v${latest.version} 是项目定制版，但不能确认它是“已记录的默认包 + 附加规则”${reasons.length ? `（${reasons.join("，")}）` : ""}，暂不自动迁移；需要人用 ${hint} 核对后登记。`,
  };
}

/**
 * Deployment pass for one project (C-613), run from the deployed build:
 * overlay roles are recomposed from the new pack, and a default-id role is
 * upgraded or migrated only as far as the trusted default record proves.
 * Problems keep the current version and notify PM; no human action is opened.
 * `defaultPath` is true where the bootstrap default-pack path handles what
 * this pass leaves alone. Returns the role ids this pass decided on (written
 * or deferred), which that path must not judge a second time.
 */
export function syncOverlayRoles(
  tx: StoreTransactionContext,
  project: ProjectId,
  now: () => string,
  pack: DeployedPack,
  defaultPath = false,
): ReadonlySet<string> {
  const actor = { kind: "system" as const, project_id: project };
  const ports = { ids: tx.ids, clock: { now } };
  let profiles: ReadonlySet<string> | undefined;
  const handled = new Set<string>();
  const known = knownDefaults(tx, project);
  const remember = (id: string, value: RoleDefinition) =>
    rememberDefault(
      tx,
      project,
      known,
      id,
      knownDefault(value),
      "proof",
      now(),
    );
  // Record this pack, so later releases can read roles built on it.
  for (const id of Object.keys(DEFAULT_ROLE_KINDS))
    rememberDefault(
      tx,
      project,
      known,
      id,
      knownDefault(
        defaultRoleDefinition(id as keyof typeof DEFAULT_ROLE_KINDS, {
          harness: "codex",
          launch_profile_ref: "deployment",
        }),
      ),
      "pack",
      now(),
    );
  const context: PlanContext = { project, defaultPath, known, remember };
  const ids = [...new Set(listRoleVersions(tx, project).map((r) => r.role_id))];
  for (const id of ids) {
    const roles = listRoleVersions(tx, project);
    const latest = roles.filter((r) => r.role_id === id).at(-1);
    if (!latest || latest.status === "inactive") continue;
    const plan = planRole(latest, context);
    if (plan.kind === "skip") continue;
    handled.add(id);
    if (plan.kind === "notice") {
      recordRoleDeferral(tx, project, plan.key, plan.text, now());
      continue;
    }
    const { source, composed_hash, migrated } = plan;
    const before = deploymentRolePolicyHash(latest);
    if (
      composed_hash === latest.default_overlay?.composed_hash &&
      source.default_overlay?.base_hash === latest.default_overlay?.base_hash
    )
      continue;
    // A new version keeps its launch profile; a broken one must not replace
    // a working session (the default-pack path checks the same).
    profiles ??= pack.profiles?.() ?? new Set();
    if (!profiles.has(latest.launch_profile_ref)) {
      recordRoleDeferral(
        tx,
        project,
        `missing-profile:${id}:${latest.version}:${latest.launch_profile_ref}`,
        `角色 ${id} 引用的启动配置 ${latest.launch_profile_ref} 不存在或配置未通过校验；保留原版本 v${latest.version}，请 PM 排查。`,
        now(),
      );
      continue;
    }
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
        `overlay-conflict:${id}:${latest.version}:${composed_hash}`,
        `角色 ${id} 的新默认包与项目附加规则冲突（${result.error.message}），系统保留 v${latest.version}；请 PM 调整附加规则。`,
        now(),
      );
      continue;
    }
    const effect = result.value.effect;
    if (!effect) continue;
    persistRoleEffect(tx, project, effect);
    const to = effect.data.version;
    const changedText = composed_hash !== before;
    // Same policy, same launch fields: the new version may carry the audit of
    // the version it replaces (V-3037:1), so a session pinned before that
    // audited upgrade can follow. Nothing else is carried.
    const carried =
      !changedText &&
      effect.data.launch_profile_ref === latest.launch_profile_ref &&
      effect.data.harness === latest.harness &&
      deploymentAuditedVersion(
        {
          roles: listRoleVersions(tx, project).map(roleReference),
          events: tx.events.listAfter(project, undefined, 0),
        },
        id,
        latest.version,
      ) !== undefined;
    const summary = migrated && overlaySummary(migrated.rules);
    const migration = migrated && {
      before_hash: before,
      after_hash: composed_hash,
      moved: migrated.moved,
      overlay: summary,
    };
    const migratedText =
      summary &&
      `已迁移为“默认包 + 项目附加规则”，保留追加说明 ${summary.appended_paragraphs} 段${summary.extra_tools.length ? `、额外工具 ${summary.extra_tools.join("、")}` : ""}${summary.removed_tools.length ? `、移除工具 ${summary.removed_tools.join("、")}` : ""}${migrated?.moved ? "，追加说明已移到默认说明之后" : ""}`;
    // Idle standing sessions follow host_role_upgraded only; a structure-only
    // migration with no audited upgrade to carry needs no rotation.
    tx.events.append(project, {
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence(project),
      type:
        changedText || carried
          ? "host_role_upgraded"
          : "host_role_overlay_migrated",
      actor,
      created_at: now(),
      // Drop absent fields; the stored payload is plain JSON.
      payload: JSON.parse(
        JSON.stringify({
          role_id: id,
          from_version: latest.version,
          to_version: to,
          metadata_only: carried || undefined,
          diff: changedText ? result.value.diff : undefined,
          overlay:
            source.default_overlay && overlaySummary(source.default_overlay),
          migrated: migration,
          notice: changedText
            ? `角色 ${id} 已按新默认包${source.default_overlay ? "和项目附加规则" : ""}自动升级：v${latest.version} → v${to}${migratedText ? `；${migratedText}` : ""}。`
            : `角色 ${id} ${migratedText ?? "的附加规则记录已更新"}：v${latest.version} → v${to}，生效内容不变。`,
        }),
      ),
    });
  }
  return handled;
}

/** Projects without the bootstrap default-pack path take this pass alone. */
export function syncProjectOverlayRoles(
  store: Store,
  project: ProjectId,
  pack: DeployedPack,
) {
  store.uow.run((tx) =>
    syncOverlayRoles(tx, project, () => new Date().toISOString(), pack),
  );
}
