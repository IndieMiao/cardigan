import {
  alternativeOptionLabel,
  capabilityAlternatives,
  unresolvedAlternatives,
} from "../capability-alternatives.js";
import type { Actor, Machine, RoleWorktree, WorkItem } from "../entities.js";
import {
  type MachinePlacement,
  remainingResourceRatio,
} from "../machine-placement.js";
import {
  parseCapabilityRequirement,
  type WorkItemRequirements,
} from "../machine-requirements.js";
import { states } from "../states.js";
import {
  type CommandDraft,
  type CommandPorts,
  type CommandState,
  command,
  ensure,
  unwrap,
} from "./core.js";

export interface MachineRequirements {
  readonly machine_id?: string;
  readonly os?: string;
  readonly arch?: string;
  readonly required_tags?: readonly string[];
}

/** Free fraction of a quota slot; a zero ceiling is full, never NaN. */
const freeRatio = (slot: {
  readonly limit: number;
  readonly occupied: number;
}) => (slot.limit > 0 ? (slot.limit - slot.occupied) / slot.limit : 0);

// MC-2 accepts numeric dotted components only. Compare without floating-point rounding.
function versionMatches(
  actual: string | null,
  expected: string,
  operator: "=" | ">=",
) {
  if (!actual || !/^\d+(?:\.\d+)*$/.test(actual)) return false;
  const left = actual.split("."),
    right = expected.split(".");
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const a = (left[i] ?? "0").replace(/^0+/, ""),
      b = (right[i] ?? "0").replace(/^0+/, "");
    if (a !== b)
      return (
        operator === ">=" &&
        (a.length === b.length ? a > b : a.length > b.length)
      );
  }
  return true;
}

/**
 * C-826: required keys another project's exclusive reservation blocks on this
 * machine now. An alternative (`android.any`) is blocked only when every
 * option the machine has verified is reserved.
 */
function reservedKeys(
  keys: readonly string[],
  f: MachinePlacement | undefined,
) {
  const reserved = new Set(f?.reserved ?? []);
  if (!reserved.size) return [];
  const verified = new Set(
    f?.capabilities.filter((c) => c.available).map((c) => c.key),
  );
  return keys.filter((key) => {
    const options = capabilityAlternatives(key);
    if (!options) return reserved.has(key);
    const usable = options.filter((o) => verified.has(o));
    return (
      usable.some((o) => reserved.has(o)) &&
      usable.every((o) => reserved.has(o))
    );
  });
}

/**
 * C-850: for keys with an alternative that names none of its options yet
 * (`android.any`), the most preferred option this machine could hand a new
 * Run of this project now: verified, not reserved by another project, with
 * room in its machine and project slots and, for a device type, an idle
 * device (`idle_devices`). `null` when none is free; `undefined` when the
 * keys have no such alternative.
 */
function freeAlternativeOption(
  keys: readonly string[],
  f: MachinePlacement | undefined,
): string | null | undefined {
  const [key] = unresolvedAlternatives(keys);
  if (key === undefined) return undefined;
  const verified = new Set(
    f?.capabilities.filter((c) => c.available).map((c) => c.key),
  );
  const reserved = new Set(f?.reserved ?? []);
  const room = (slot?: { limit: number; occupied: number }) =>
    !slot || slot.occupied < slot.limit;
  const idle = f?.idle_devices;
  return (
    (capabilityAlternatives(key) ?? []).find(
      (option) =>
        verified.has(option) &&
        !reserved.has(option) &&
        room(f?.resources?.get(option)) &&
        room(f?.project_quota?.resources?.get(option)) &&
        !(idle && Object.hasOwn(idle, option) && (idle[option] ?? 0) <= 0),
    ) ?? null
  );
}

/** Preference position of a free option; machines without one rank last. */
function freeOptionRank(keys: readonly string[], option?: string | null) {
  const [key] = unresolvedAlternatives(keys);
  const options = key === undefined ? [] : (capabilityAlternatives(key) ?? []);
  const rank = option ? options.indexOf(option) : -1;
  return rank < 0 ? options.length : rank;
}

/** Registry admission also applies to explicit assignments; ranking and live evidence never do. */
export function selectMachine(
  d: CommandDraft,
  item: WorkItem,
  required: WorkItemRequirements,
  worktree: RoleWorktree | undefined,
  options: {
    explicit?: string | undefined;
    profile?: string | undefined;
    failedMachine?: string | undefined;
    /** C-826: machines ruled out for this selection only, with the reason recorded. */
    exclude?: ReadonlyMap<string, string>;
  },
) {
  const { explicit } = options;
  const machines = d
    .list("machines")
    .filter((m) => explicit === undefined || m.id === explicit)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  ensure(
    machines.length,
    "not_found",
    "本项目没有登记所需机器，请人登记授权后再指派",
    explicit === undefined ? { no_matching_machine: true } : undefined,
  );
  const registryReasons = (m: Machine) => [
    ...(!["online", "degraded"].includes(m.status) ? [m.status] : []),
    ...(required.os && required.os !== m.os ? [`os=${required.os}`] : []),
    ...(required.arch && required.arch !== m.arch
      ? [`arch=${required.arch}`]
      : []),
    ...(required.tags ?? [])
      .filter((tag) => !m.tags.includes(tag))
      .map((tag) => `tag=${tag}`),
  ];
  if (explicit !== undefined) {
    const reasons = registryReasons(machines[0] as Machine);
    ensure(
      !reasons.length,
      "validation_failed",
      `没有满足条件的机器：${explicit} 缺少能力或不可用 (${reasons.join(", ")})`,
    );
    return { machine_id: explicit };
  }
  const facts = d.state.read_machine_placement?.(
    d.state.project_id,
    d.now,
    options.profile,
    {
      assignments: d.list("assignments"),
      work_items: d.list("work_items"),
      runs: d.list("runs"),
    },
  );
  const constraints = (required.capabilities ?? []).map((raw) => ({
    raw,
    ...unwrap(parseCapabilityRequirement(raw)),
  }));
  const keys = [...new Set(constraints.map((req) => req.key))];
  const preferLocal = item.kind === "verify" && !constraints.length;
  const producers = new Set(
    d
      .list("work_items")
      .filter((w) => w.card_id === item.card_id && w.kind === "produce")
      .map((w) => w.id),
  );
  const affinity = new Set(
    d
      .list("assignments")
      .filter(
        (a) =>
          a.scope === "work_item" &&
          producers.has(a.work_item_id) &&
          a.status !== "released" &&
          a.worktree_path,
      )
      .map((a) => a.machine_id),
  );
  const preference =
    d.list("project_preferences").find((p) => p.id === d.state.project_id)
      ?.machine_preference ?? [];
  const candidates = [],
    excluded = [];
  for (const machine of machines) {
    const machine_id = machine.id,
      f = facts?.machines.get(machine_id),
      reasons = registryReasons(machine);
    if (machine_id === options.failedMachine)
      reasons.push("上次首发未完成，重新指派需要另一台机器");
    const ruledOut = options.exclude?.get(machine_id);
    if (ruledOut) reasons.push(ruledOut);
    if (machine_id !== "local") {
      if (f?.preparation_cooldown_until && f.preparation_cooldown_until > d.now)
        reasons.push(
          `连续启动准备失败，冷却至 ${f.preparation_cooldown_until}`,
        );
      if (!facts?.harness) reasons.push("启动配置未知，无法确定所需启动器");
      else {
        const key = `harness.${facts.harness}`;
        const cap = f?.capabilities.find((c) => c.key === key);
        if (
          cap &&
          f?.remote_binding === "allowed" &&
          !f.observation_target_matches
        )
          reasons.push(
            `${key}：缺少与当前工作机绑定和平台匹配的检查，请重新检查`,
          );
        else if (!cap?.available || !cap.version)
          reasons.push(
            `${key}：${!cap ? "未验证" : !cap.available ? "已过期" : "缺少版本"}`,
          );
      }
      if (worktree === "write" || worktree === "readonly") {
        const proof = f?.worktree_preparation;
        if (proof !== "verified") {
          const reason =
            proof === "expired"
              ? "证据已过期"
              : proof === "invalid"
                ? "证据无效"
                : proof === "stale"
                  ? "证据待重新验证（PATH 或 env 已变更，下次真实准备成功后自动续期）"
                  : "尚未验证";
          reasons.push(
            `服务端远程 Git 工作树准备${reason}（角色工作树策略：${worktree}）`,
          );
        }
      } else if (worktree !== "none") {
        reasons.push("角色工作树策略未知，无法确定远程 Git 工作树准备要求");
      }
      if (f?.remote_binding === "platform_mismatch")
        reasons.push("远程绑定的 OS 或架构与机器登记不一致");
      else if (f?.remote_binding !== "allowed")
        reasons.push("allow_remote_launch 未开启");
      if (!f?.health) reasons.push("缺少健康快照");
      else if (!f.health.available || f.health.status !== "passed")
        reasons.push(
          f.health.status === "passed"
            ? "健康快照已过期"
            : f.health.blockers?.join("、") || "健康检查未通过",
        );
    }
    for (const req of constraints) {
      const cap = f?.capabilities.find((c) => c.key === req.key);
      if (
        !cap?.available ||
        (req.version &&
          req.operator &&
          !versionMatches(cap.version, req.version, req.operator))
      )
        reasons.push(
          `${req.raw}：${!cap ? "未验证" : !cap.available ? "已过期" : "版本不满足"}`,
        );
    }
    if (f && f.limit <= 0) reasons.push("机器容量配置不可用");
    if (reasons.length) {
      excluded.push({ machine_id, reasons });
      continue;
    }
    const rank = preference.indexOf(machine_id);
    const resources = keys.flatMap((key) => {
      const slot = f?.resources?.get(key);
      return slot ? [{ key, ...slot }] : [];
    });
    // C-716: this project's own ceilings on the machine rank like its slots.
    const quota = f?.project_quota;
    const project_resources = keys.flatMap((key) => {
      const slot = quota?.resources?.get(key);
      return slot ? [{ key, ...slot }] : [];
    });
    const reserved = reservedKeys(keys, f);
    const free_option = freeAlternativeOption(keys, f);
    const full = f
      ? [
          ...(f.occupied >= f.limit
            ? [`机器上限 ${f.occupied}/${f.limit}`]
            : []),
          ...(quota?.limit && quota.limit.occupied >= quota.limit.limit
            ? [`项目上限 ${quota.limit.occupied}/${quota.limit.limit}`]
            : []),
          ...resources
            .filter((r) => r.occupied >= r.limit)
            .map((r) => `${r.key} 名额 ${r.occupied}/${r.limit}`),
          ...project_resources
            .filter((r) => r.occupied >= r.limit)
            .map((r) => `项目 ${r.key} 名额 ${r.occupied}/${r.limit}`),
          ...reserved.map((key) => `${key} 被其它项目预约独占`),
        ]
      : [];
    candidates.push({
      machine_id,
      affinity: item.kind === "produce" && affinity.has(machine_id),
      control_host: preferLocal && machine_id === "local",
      limit: f?.limit ?? null,
      occupied: f?.occupied ?? null,
      ...(f?.pending_assignments
        ? { pending_assignments: f.pending_assignments }
        : {}),
      ...(quota?.limit ? { project_limit: { ...quota.limit } } : {}),
      remaining_ratio: f
        ? Math.min(
            (f.limit - f.occupied) / f.limit,
            quota?.limit ? freeRatio(quota.limit) : 1,
            remainingResourceRatio(keys, f.resources),
            ...project_resources.map(freeRatio),
            reserved.length ? 0 : 1,
          )
        : null,
      ...(reserved.length ? { reserved } : {}),
      ...(free_option !== undefined ? { free_option } : {}),
      ...(resources.length ? { resources } : {}),
      ...(project_resources.length ? { project_resources } : {}),
      ...(full.length ? { full } : {}),
      preference_rank: rank < 0 ? null : rank,
    });
  }
  // Registry order breaks exact ties, independent of insertion order or host locale.
  candidates.sort(
    (a, b) =>
      Number((b.remaining_ratio ?? 0) > 0) -
        Number((a.remaining_ratio ?? 0) > 0) ||
      // A reserved machine cannot even start the work when it frees up.
      Number(!!a.reserved) - Number(!!b.reserved) ||
      // C-850: `android.any` goes where an idle device is, else a free emulator.
      freeOptionRank(keys, a.free_option) -
        freeOptionRank(keys, b.free_option) ||
      Number(b.control_host) - Number(a.control_host) ||
      Number(b.affinity) - Number(a.affinity) ||
      (b.remaining_ratio ?? 0) - (a.remaining_ratio ?? 0) ||
      (a.preference_rank ?? Infinity) - (b.preference_rank ?? Infinity),
  );
  const first = candidates[0];
  ensure(
    first,
    "validation_failed",
    `没有满足条件的机器：${excluded.map((m) => `${m.machine_id} (${m.reasons.join(", ")})`).join("; ")}`,
    { no_matching_machine: true },
  );
  // Every eligible machine is full: the Run queues there; name the limits.
  const queued_on =
    (first.remaining_ratio ?? 1) <= 0 && first.full ? first.full : undefined;
  const alternative = alternativePlacement(keys, first, candidates);
  return {
    machine_id: first.machine_id,
    audit: {
      candidates,
      excluded,
      ...(queued_on ? { queued_on } : {}),
      ...(alternative ? { alternative } : {}),
      selection_order: [
        "has_capacity",
        "not_reserved",
        "free_alternative",
        "control_host",
        "affinity",
        "remaining_ratio",
        "preference_rank",
        "machine_id",
      ],
    },
  };
}

/**
 * C-850: which option the chosen machine can hand an `android.any` Run now
 * and why it ranked first, for the `machine_selected` audit.
 */
function alternativePlacement(
  keys: readonly string[],
  first: { machine_id: string; free_option?: string | null },
  candidates: readonly { machine_id: string; free_option?: string | null }[],
) {
  const [key] = unresolvedAlternatives(keys);
  if (key === undefined) return undefined;
  const option = first.free_option ?? null;
  const preferred = (capabilityAlternatives(key) ?? [])[0];
  const others = candidates.filter((c) => c.machine_id !== first.machine_id);
  const reason = !option
    ? "合格机器都没有空闲的真机或模拟器，按现有规则选机排队"
    : option === preferred
      ? `有空闲${alternativeOptionLabel(option)}，优先`
      : others.some((c) => c.free_option === preferred)
        ? `有空闲${alternativeOptionLabel(option)}；有空闲${alternativeOptionLabel(preferred ?? "")}的机器按名额或预约排在后面`
        : `合格机器都没有空闲${alternativeOptionLabel(preferred ?? "")}，用空闲的${alternativeOptionLabel(option)}`;
  return { key, option, reason };
}

export function validateMachine(machine: Machine): void {
  // No endpoint, account, credential or arbitrary extension fields enter the registry.
  const keys = [
    "id",
    "label",
    "herdr_machine",
    "os",
    "arch",
    "tags",
    "max_assignments",
    "status",
    "last_seen",
  ];
  ensure(
    Object.keys(machine).every((key) => keys.includes(key)),
    "validation_failed",
    "机器登记仅接受非敏感描述字段",
  );
  for (const key of ["id", "herdr_machine", "os", "arch"] as const)
    ensure(
      typeof machine[key] === "string" &&
        /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(machine[key]),
      "validation_failed",
      `Invalid machine ${key}`,
    );
  ensure(
    typeof machine.label === "string" &&
      machine.label.trim().length > 0 &&
      !/[\r\n]/.test(machine.label),
    "validation_failed",
    "Invalid machine label",
  );
  ensure(
    Array.isArray(machine.tags) &&
      machine.tags.every(
        (tag) =>
          typeof tag === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(tag),
      ),
    "validation_failed",
    "Invalid machine tags",
  );
  ensure(
    states.machine.includes(machine.status),
    "validation_failed",
    "Invalid machine status",
  );
  ensure(
    Number.isSafeInteger(machine.max_assignments) &&
      machine.max_assignments >= 0,
    "validation_failed",
    "Invalid displayed Run limit",
  );
  ensure(
    typeof machine.last_seen === "string" &&
      Number.isFinite(Date.parse(machine.last_seen)),
    "validation_failed",
    "Invalid machine last_seen",
  );
}

/** Human registration changes metadata only, never SSH configuration or Run limits. */
export function saveMachine(
  state: CommandState,
  actor: Actor,
  p: { machine: Machine; operation: "register" | "update" | "drain" },
  ports: CommandPorts,
) {
  return command(state, actor, "manage_machines", ports, (d) => {
    ensure(actor.kind === "human", "unauthorized", "只有人可以登记或修改机器");
    validateMachine(p.machine);
    const previous = d.list("machines").find((m) => m.id === p.machine.id);
    ensure(
      p.operation === "register" ? !previous : previous,
      "validation_failed",
      "机器已登记或待更新机器不存在",
    );
    ensure(
      !previous || previous.herdr_machine === p.machine.herdr_machine,
      "invariant_violation",
      "既有运行时别名不能在机器登记中改写",
    );
    const machine =
      p.operation === "drain"
        ? { ...(previous as Machine), status: "draining" as const }
        : p.machine;
    d.put("machines", machine);
    d.emit(
      `machine_${p.operation === "register" ? "registered" : p.operation === "drain" ? "draining" : "updated"}`,
      undefined,
      { machine: { ...machine, tags: [...machine.tags] } },
    );
    return machine;
  });
}
