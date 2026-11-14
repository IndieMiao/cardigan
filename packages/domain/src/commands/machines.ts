import type { Actor, Machine } from "../entities.js";
import { states } from "../states.js";
import {
  type CommandPorts,
  type CommandState,
  command,
  ensure,
} from "./core.js";

export interface MachineRequirements {
  readonly machine_id?: string;
  readonly os?: string;
  readonly arch?: string;
  readonly required_tags?: readonly string[];
}

/** Only the project's trusted registry is considered; tags do not grant access. */
export function selectMachine(
  machines: readonly Machine[],
  p: MachineRequirements,
): Machine {
  const reasons = (m: Machine) => [
    ...(!["online", "degraded"].includes(m.status) ? [m.status] : []),
    ...(p.os !== undefined && m.os !== p.os ? [`os=${p.os}`] : []),
    ...(p.arch !== undefined && m.arch !== p.arch ? [`arch=${p.arch}`] : []),
    ...(p.required_tags ?? [])
      .filter((tag) => !m.tags.includes(tag))
      .map((tag) => `tag=${tag}`),
  ];
  const registered = machines.filter(
    (m) => p.machine_id === undefined || m.id === p.machine_id,
  );
  ensure(
    registered.length,
    "not_found",
    "本项目没有登记所需机器，请人登记授权后再指派",
  );
  const candidates = registered.filter((m) => reasons(m).length === 0);
  ensure(
    candidates.length,
    "validation_failed",
    `没有满足条件的机器：${registered.map((m) => `${m.id} 缺少能力或不可用 (${reasons(m).join(", ")})`).join("; ")}`,
  );
  ensure(
    candidates.length === 1,
    "validation_failed",
    `有多个候选机器，请明确指定 machine_id：${candidates.map((m) => m.id).join(", ")}`,
  );
  return candidates[0] as Machine;
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
