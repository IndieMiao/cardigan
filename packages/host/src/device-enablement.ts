import {
  type Clock,
  type DeviceObservation,
  type DeviceRegistration,
  deviceActionKey,
  deviceEnabledFor,
  deviceResourceName,
  deviceUnavailableReason,
  normalizeDeviceInitResult,
  preselectedDeviceProject,
  reconcileDeviceAction,
  usableDevice,
  waitsOnDevice,
} from "@cardigan/domain";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import { readMachineObservations, type Store } from "@cardigan/store";
import type { HostDeviceTarget } from "./device-provider-host.js";
import {
  DEVICE_PROVIDERS,
  deviceProvider,
  type HostDeviceProvider,
} from "./device-providers.js";
import { DeviceRegistry, machineProjects } from "./device-registry.js";
import { assignmentResourceKeys } from "./run-resources.js";

/**
 * C-817: discovery, one-click enabling and loss of external test devices.
 *
 * Runs inside every machine check (patrol, CLI, Workbench), right after a
 * provider listed its devices as the project account:
 *
 * 1. an available device never seen before is registered as `pending`;
 * 2. a device a person enabled with this project as the initializing project
 *    is initialized with the provider's fixed steps (one claim at a time);
 * 3. only devices enabled for this project become machine capabilities.
 *
 * After the observation is recorded, the project's Needs You to-dos follow
 * the registry: an enable prompt while a device waits for a person, closed
 * by the system once enabled or disabled; and a reminder only while queued
 * work of this project waits on an enabled device that became unusable.
 */
export interface DeviceCheckOutcome {
  /** Devices whose registration changed; their prompts change in every project. */
  readonly changed: boolean;
  /** This project's dispatchable devices of the provider. */
  readonly enabled: readonly DeviceObservation[];
}

export async function observeProviderDevices(input: {
  readonly store: Store;
  readonly project: string;
  readonly machine: string;
  readonly provider: HostDeviceProvider;
  readonly listed: readonly DeviceObservation[];
  /** The listing itself succeeded (else no initialization is judged). */
  readonly complete: boolean;
  readonly target: HostDeviceTarget;
  readonly now: () => string;
}): Promise<DeviceCheckOutcome> {
  const { store, project, machine, provider, listed, target, now } = input;
  const registry = new DeviceRegistry(store);
  let changed = false;
  for (const device of listed)
    if (registry.discover(machine, device, now())) changed = true;
  for (const reg of input.complete ? registry.list(machine) : []) {
    if (reg.type !== provider.type || reg.status !== "initializing") continue;
    const claim = registry.claimInit(machine, reg.type, reg.id, project, now());
    if (!claim) continue;
    const seen = listed.find((d) => d.id === reg.id);
    let outcome: ReturnType<typeof normalizeDeviceInitResult>;
    if (seen?.state === "available") {
      let raw: unknown;
      try {
        raw = provider.initialize
          ? await provider.initialize(target, seen)
          : { result: "ok" };
      } catch {
        raw = undefined;
      }
      outcome = normalizeDeviceInitResult(raw, provider.init_steps ?? []);
      if (outcome.ok && !outcome.version && seen.version)
        outcome = { ...outcome, version: seen.version };
    } else
      outcome = normalizeDeviceInitResult(
        {
          result: seen?.state === "unauthorized" ? "unauthorized" : "not_found",
        },
        [],
      );
    if (registry.finishInit(machine, reg.type, reg.id, claim, outcome, now()))
      changed = true;
  }
  const enabled = listed.filter((d) =>
    deviceEnabledFor(registry.get(machine, d.type, d.id), project),
  );
  return { changed, enabled };
}

const label = (reg: DeviceRegistration) =>
  `${deviceProvider(reg.type)?.label ?? reg.type}${reg.model ? ` ${reg.model}` : ""}（${reg.id}）`;

function enablePrompt(reg: DeviceRegistration, projects: readonly string[]) {
  const provider = deviceProvider(reg.type);
  const steps = (provider?.init_steps ?? []).map((s) => s.title);
  const preselected = preselectedDeviceProject(projects);
  const phase =
    reg.status === "initializing"
      ? "initializing"
      : reg.status === "failed"
        ? "failed"
        : "pending";
  const name = `${provider?.label ?? reg.type}${reg.model ? ` ${reg.model}` : ""}`;
  const lines = [
    `启用后系统自动${steps.length ? `${steps.join("、")}，并` : ""}记录分辨率和系统版本；不恢复出厂，不装卸其它应用。`,
    `设备编号：${reg.id}`,
    ...(phase === "initializing" ? ["正在初始化，一分钟内出结果。"] : []),
    ...(phase === "failed" && reg.failure
      ? [`上次初始化失败：${reg.failure}`]
      : []),
  ];
  return {
    instructions: lines.join("\n"),
    // The row title: the question itself.
    why_human: `${reg.machine} 发现${name}，给 ${preselected ?? "哪个项目"} 用？`,
    expected_return: "点“启用”后系统自动初始化，成功后这条待办自动结项。",
    device_enablement: {
      machine_id: reg.machine,
      type: reg.type,
      device_id: reg.id,
      label: provider?.label ?? reg.type,
      ...(reg.model ? { model: reg.model } : {}),
      projects: [...projects],
      ...(preselected ? { preselected } : {}),
      steps,
      phase,
      ...(phase === "failed" && reg.failure ? { failure: reg.failure } : {}),
    },
    reopen_key: `${phase}:${reg.updated_at}`,
  } as const;
}

function enabledText(reg: DeviceRegistration) {
  return `已启用${label(reg)}，给 ${reg.projects.join("、")} 用${reg.resolution ? `；分辨率 ${reg.resolution}` : ""}${reg.version ? `，系统版本 ${reg.version}` : ""}。`;
}

/**
 * Cards of this project's queued Runs on the machine that only this device can
 * serve. `available` is the machine's verified capabilities: a queued
 * `android.any` with no available emulator counts as waiting on the device
 * (C-827).
 */
function waitingCards(
  store: Store,
  project: string,
  machine: string,
  reg: DeviceRegistration,
  usable: readonly DeviceObservation[],
  available: readonly string[],
) {
  return store.uow.read((tx) => {
    const queued = new Set(
      tx.runs
        .list(project)
        .filter((r) => r.status === "queued")
        .map((r) => r.assignment_id),
    );
    const cards = new Set<string>();
    for (const a of tx.assignments.list(project)) {
      if (a.machine_id !== machine || !queued.has(a.id) || !a.work_item_id)
        continue;
      if (
        !waitsOnDevice(
          assignmentResourceKeys(tx, project, a),
          reg,
          usable,
          available,
        )
      )
        continue;
      const item = tx.work_items.get(project, a.work_item_id);
      if (item) cards.add(item.card_id);
    }
    return [...cards].sort();
  });
}

function reconcile(
  store: Store,
  project: string,
  clock: Clock,
  input: Parameters<typeof reconcileDeviceAction>[2],
) {
  store.uow.run((tx) =>
    persistEffect(
      tx,
      project,
      unwrap(
        reconcileDeviceAction(
          loadCommandState(tx, project),
          { kind: "system", project_id: project },
          input,
          { ids: tx.ids, clock },
        ),
      ),
    ),
  );
}

/** Bring this project's device to-dos for one machine in line with the registry. */
export function syncDeviceActions(
  store: Store,
  project: string,
  machine: string,
  clock: Clock,
) {
  const registry = new DeviceRegistry(store);
  const regs = registry.list(machine);
  if (!regs.length) return;
  const projects = machineProjects(store, machine);
  if (!projects.includes(project)) return;
  const observed = readMachineObservations(
    store,
    project,
    machine,
    clock.now(),
  );
  const health = observed.health;
  const available = observed.capabilities
    .filter((c) => c.available)
    .map((c) => c.key);
  const listing =
    health?.available && health.devices ? health.devices : undefined;
  for (const reg of regs) {
    if (!DEVICE_PROVIDERS.some((p) => p.type === reg.type)) continue;
    const key = (kind: "enable" | "unavailable") =>
      deviceActionKey(kind, machine, reg.type, reg.id);
    if (["pending", "initializing", "failed"].includes(reg.status))
      reconcile(store, project, clock, {
        key: key("enable"),
        open: enablePrompt(reg, projects),
      });
    else
      reconcile(store, project, clock, {
        key: key("enable"),
        close:
          reg.status === "enabled"
            ? { outcome: "done", text: enabledText(reg) }
            : { outcome: "cancelled", text: "设备未启用，不派给任何项目" },
      });
    // Loss is judged only from a listing this check actually made.
    if (
      !listing ||
      health?.capability_failures?.some((f) => f.key === reg.type)
    )
      continue;
    const seen = listing.find((d) => d.type === reg.type && d.id === reg.id);
    const reason =
      deviceEnabledFor(reg, project) && !(seen && usableDevice(seen))
        ? deviceUnavailableReason(seen?.state)
        : undefined;
    const usable = listing.filter(
      (d) =>
        usableDevice(d) &&
        deviceEnabledFor(registry.get(machine, d.type, d.id), project),
    );
    const cards = reason
      ? waitingCards(store, project, machine, reg, usable, available)
      : [];
    if (reason && cards.length)
      reconcile(store, project, clock, {
        key: key("unavailable"),
        open: {
          instructions: `${machine} 上的${label(reg)}${reason}，${cards.join("、")} 的工作在等它。重新接好、在设备上重新允许调试后，系统下次检查机器时自动恢复并结项。`,
          why_human: `${machine} 的${deviceProvider(reg.type)?.label ?? reg.type}${reason}，有工作在等它`,
          expected_return: "设备恢复后系统自动结项，无需回填。",
          reopen_key: `${reason}:${cards.join(",")}`,
        },
      });
    else
      reconcile(store, project, clock, {
        key: key("unavailable"),
        close: {
          outcome: "cancelled",
          text: reason ? "没有工作在等这台设备了" : "设备已恢复",
        },
      });
  }
}

/** After a registry change: every project registering the machine. */
export function syncDeviceActionsEverywhere(
  store: Store,
  machine: string,
  clock: Clock,
) {
  for (const project of machineProjects(store, machine))
    syncDeviceActions(store, project, machine, clock);
}

/**
 * A person's device request (human-only callers: the Workbench session of
 * the owner, the host CLI). The registry change is audited globally and
 * every project's to-dos follow; the initialization itself runs in the next
 * machine check.
 */
export function requestDevice(
  store: Store,
  input: Omit<Parameters<DeviceRegistry["request"]>[0], "now">,
  clock: Clock,
  audit: { via: "cli" | "workbench"; member_id?: string } = { via: "cli" },
) {
  const reg = new DeviceRegistry(store).request({ ...input, now: clock.now() });
  store.uow.run((tx) =>
    tx.global_events.append({
      id: tx.global_ids.nextEventId(),
      seq: tx.global_ids.nextEventSequence(),
      created_at: clock.now(),
      type: "machine_device_requested",
      actor: { kind: "human" },
      payload: {
        machine_id: reg.machine,
        resource: deviceResourceName(reg.type, reg.id),
        request: input.request,
        status: reg.status,
        projects: [...reg.projects],
        via: audit.via,
        ...(audit.member_id ? { member_id: audit.member_id } : {}),
      },
    }),
  );
  syncDeviceActionsEverywhere(store, input.machine, clock);
  return reg;
}
