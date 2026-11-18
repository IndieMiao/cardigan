import type { Actor, Machine, RoleWorktree, WorkItem } from "../entities.js";
import { remainingResourceRatio } from "../machine-placement.js";
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

/** Registry admission also applies to explicit assignments; ranking and live evidence never do. */
export function selectMachine(
  d: CommandDraft,
  item: WorkItem,
  required: WorkItemRequirements,
  worktree: RoleWorktree | undefined,
  explicit?: string,
) {
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
  const facts = d.state.read_machine_placement?.(d.state.project_id, d.now);
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
      f = facts?.get(machine_id),
      reasons = registryReasons(machine);
    if (machine_id !== "local") {
      // C-461: do not infer server-side Git preparation from worker health.
      // Only lift this guard after the dispatch path is verified end to end.
      if (worktree !== "none")
        reasons.push(
          `服务端远程 Git 工作树准备尚未验证（角色工作树策略：${worktree ?? "未声明"}）`,
        );
      if (f?.remote_binding === "platform_mismatch")
        reasons.push("远程绑定的 OS 或架构与机器登记不一致");
      else if (f?.remote_binding !== "allowed")
        reasons.push("allow_remote_launch 未开启");
      if (!f?.health) reasons.push("缺少健康快照");
      else if (!f.health.available || f.health.status !== "passed")
        reasons.push(
          f.health.status === "passed" ? "健康快照已过期" : "健康检查未通过",
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
    candidates.push({
      machine_id,
      affinity: item.kind === "produce" && affinity.has(machine_id),
      control_host: preferLocal && machine_id === "local",
      limit: f?.limit ?? null,
      occupied: f?.occupied ?? null,
      remaining_ratio: f
        ? Math.min(
            (f.limit - f.occupied) / f.limit,
            remainingResourceRatio(keys, f.resources),
          )
        : null,
      ...(resources.length ? { resources } : {}),
      preference_rank: rank < 0 ? null : rank,
    });
  }
  // Registry order breaks exact ties, independent of insertion order or host locale.
  candidates.sort(
    (a, b) =>
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
  return {
    machine_id: first.machine_id,
    audit: {
      candidates,
      excluded,
      selection_order: [
        "control_host",
        "affinity",
        "remaining_ratio",
        "preference_rank",
        "machine_id",
      ],
    },
  };
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
