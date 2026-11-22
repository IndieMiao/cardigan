import { createHash } from "node:crypto";
import { dirname } from "node:path";
import {
  type ActionCommand,
  type Clock,
  type HumanActionId,
  requestDeploymentAction,
  retireWorkerMaintenanceActions,
} from "@cardigan/domain";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import type { ExecutionConfig } from "@cardigan/runtime-herdr";
import type {
  MachineCapability,
  MachineHealth,
  Store,
  StoreTransactionContext,
} from "@cardigan/store";
import {
  AGENT_TOOLS,
  AGENT_TOOLS_CAPABILITY,
  agentToolsCapability,
  agentToolsProblem,
  agentToolsReinstallable,
  agentToolsRelease,
} from "./agent-tools.js";
import {
  type CapabilityProbe,
  probeMachineCapability,
} from "./machine-capability-probe.js";
import type { AgentToolsOutcome } from "./machine-check-types.js";
import { runtimeWorkersPath } from "./runtime-workers-config.js";
import { stageWorkerUpgrade, upgradeMaterials } from "./worker-upgrade.js";
import { enrolledUpgradeIdentity } from "./worker-upgrade-enrollment.js";
import { upgradeKey, upgradeState } from "./worker-upgrade-gate.js";

type Worker = Extract<ExecutionConfig, { mode: "agent-ssh" }>;

export type AgentToolsState = "stale" | "current" | "unknown";
/**
 * Whether a remote binding lacks the current attachment tools. A failed probe,
 * unparseable output or an unverifiable controller release is "unknown": never
 * a reason to install, and never remembered as current either.
 */
export async function agentToolsStale(
  execution: ExecutionConfig,
  machine: string,
  os: string,
  signal?: AbortSignal,
  probe: CapabilityProbe = probeMachineCapability,
): Promise<AgentToolsState> {
  const current = agentToolsRelease();
  if (!current) return "unknown";
  const result = await probe(
    execution,
    os,
    agentToolsCapability(execution, machine, current).check,
    signal,
  );
  if (!result.ok) return "unknown";
  const problem = agentToolsProblem(result.output);
  if (problem === undefined) return "current";
  return agentToolsReinstallable(problem) ? "stale" : "unknown";
}

// Release keys whose tools a patrol probe found current, per store and machine.
// Only "current" is remembered; any later stale observation forgets it.
const confirmed = new WeakMap<Store, Map<string, string>>();
const slot = (project: string, machine: string) => `${project}\0${machine}`;
export const agentToolsConfirmed = {
  has(store: Store, project: string, machine: string, key: string) {
    return confirmed.get(store)?.get(slot(project, machine)) === key;
  },
  set(store: Store, project: string, machine: string, key: string) {
    const seen = confirmed.get(store) ?? new Map<string, string>();
    seen.set(slot(project, machine), key);
    confirmed.set(store, seen);
  },
  forget(store: Store, project: string, machine: string) {
    confirmed.get(store)?.delete(slot(project, machine));
  },
};

export type { AgentToolsOutcome };

export const agentToolsActionPrefix = (machine: string) =>
  `worker-agent-tools:${machine}:`;
/** Changes with the binding, the tools and every byte of the staged command. */
export const agentToolsActionKey = (
  machine: string,
  binding: string,
  command: string | null,
) =>
  `${agentToolsActionPrefix(machine)}${createHash("sha256")
    .update(
      JSON.stringify([binding, agentToolsRelease()?.digests ?? null, command]),
    )
    .digest("hex")}`;

// Cheap guard so a healthy machine's routine observation never loads the project state.
function hasOpenNotice(store: Store, project: string, machine: string) {
  const prefix = agentToolsActionPrefix(machine).replace(/[\\%_]/gu, "\\$&");
  return !!store.database
    .prepare(
      `SELECT 1 FROM events e JOIN human_actions h
         ON h.project_id = e.project_id AND h.id = json_extract(e.doc, '$.payload.human_action_id')
       WHERE e.project_id = ? AND e.card_id IS NULL AND e.type = 'host_deployment_action_requested'
         AND json_extract(e.doc, '$.payload.key') LIKE ? ESCAPE '\\'
         AND json_extract(h.doc, '$.status') = 'open' LIMIT 1`,
    )
    .get(project, `${prefix}%`);
}

function retire(
  tx: StoreTransactionContext,
  project: string,
  machine: string,
  clock: Clock,
  reason: string,
  keep?: string,
) {
  persistEffect(
    tx,
    project,
    unwrap(
      retireWorkerMaintenanceActions(
        loadCommandState(tx, project),
        { kind: "system", project_id: project },
        {
          prefix: agentToolsActionPrefix(machine),
          reason,
          ...(keep ? { keep } : {}),
        },
        { ids: tx.ids, clock },
      ),
    ),
  );
}

export interface AgentToolsReconcileOptions {
  readonly store: Store;
  readonly project: string;
  readonly machine: string;
  readonly observation: string;
  readonly health: MachineHealth;
  readonly capabilities: readonly MachineCapability[];
  /** Absent when the observation failed before its binding fence. */
  readonly target:
    | { execution: ExecutionConfig; machine: { os: string } }
    | undefined;
  /** Re-resolves the binding after staging; a change abandons this outcome. */
  readonly currentBinding: () => Promise<string | undefined>;
  /** True while this observation is still the machine's latest record. */
  readonly stillCurrent: (tx: StoreTransactionContext) => boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly stage?: typeof stageWorkerUpgrade;
  readonly signal?: AbortSignal;
  readonly now: () => string;
}

/**
 * C-599: keep at most one open administrator notice per machine for missing or
 * stale attachment tools, tied to the current binding and the fully verified,
 * freshly staged release. Every other notice of this machine is retired, so a
 * retry after a staging failure, a new release or a rebinding never leaves an
 * old command behind. Never blocks dispatch and never installs anything itself.
 */
export async function reconcileAgentToolsAction(
  o: AgentToolsReconcileOptions,
): Promise<AgentToolsOutcome | undefined> {
  try {
    return await reconcile(o);
  } catch {
    // Never keep an earlier command when this outcome could not be recorded.
    try {
      if (o.machine !== "local" && hasOpenNotice(o.store, o.project, o.machine))
        o.store.uow.run((tx) =>
          retire(
            tx,
            o.project,
            o.machine,
            { now: o.now },
            "附件助手待办刷新失败，旧的补装命令作废",
          ),
        );
    } catch {
      /* The observation itself stays recorded; guidance reports no command. */
    }
    return { status: "unverifiable" };
  }
}

async function reconcile(
  o: AgentToolsReconcileOptions,
): Promise<AgentToolsOutcome | undefined> {
  const { store, project, machine } = o;
  if (machine === "local") return undefined;
  const clock = { now: o.now };
  const settle = (
    outcome: AgentToolsOutcome,
    reason: string,
  ): AgentToolsOutcome | undefined =>
    store.uow.run((tx) => {
      if (!o.stillCurrent(tx)) return undefined;
      if (hasOpenNotice(store, project, machine))
        retire(tx, project, machine, clock, reason);
      return outcome;
    });
  // Nothing about the tools was verified (helper mismatch, a new release,
  // offline, rebinding): no earlier command may outlive this check.
  if (o.health.status !== "passed" || !o.target) {
    settle({ status: "unverifiable" }, "本次机器检查未通过，旧的补装命令作废");
    return undefined;
  }
  if (o.capabilities.some((c) => c.key === AGENT_TOOLS_CAPABILITY))
    return settle(
      { status: "current" },
      "附件助手已与当前发布一致，不再需要补装",
    );
  const problem = o.health.capability_failures?.find(
    (f) => f.key === AGENT_TOOLS_CAPABILITY,
  )?.reason;
  if (!problem) return undefined;
  const { execution, machine: registered } = o.target;
  const pinned = execution.target;
  const stale = "当前绑定或控制端发行材料无法核验，旧的补装命令作废";
  if (
    !agentToolsReinstallable(problem) ||
    execution.mode !== "agent-ssh" ||
    !pinned ||
    pinned.machine_id !== machine ||
    pinned.project_id !== project
  )
    return settle({ status: "unverifiable" }, stale);
  // The outer observation saw stale tools: any earlier "current" probe is void.
  agentToolsConfirmed.forget(store, project, machine);
  // Re-evaluated after staging: enrollment or an upgrade attempt may change meanwhile.
  const route = ():
    | { outcome: AgentToolsOutcome; reason: string }
    | { note: string } => {
    let enrolled: string | undefined;
    try {
      enrolled = enrolledUpgradeIdentity(
        dirname(runtimeWorkersPath(o.env)),
        project,
        machine,
      );
    } catch {
      return { outcome: { status: "unverifiable" }, reason: stale };
    }
    if (!enrolled) return { note: "该机未登记签名自动升级" };
    const row = upgradeState(store, project, machine);
    // The signed upgrade owns the first attempt for each release key.
    if (row?.release_key !== upgradeKey(pinned.fingerprint))
      return {
        outcome: { status: "automatic" },
        reason: "已登记签名自动升级，等待巡检按当前发布安装",
      };
    if (row.state === "failed" || row.state === "worker_checked")
      return {
        outcome: { status: "held" },
        reason: "签名自动升级未通过核验，按升级待办恢复",
      };
    return {
      note: "签名自动升级已对本版本执行一次，附件助手仍未就绪：C-595 之前登记的 v1 入口只能更新三个 helper，需要本命令迁移；v2 入口则是安装后复查未通过",
    };
  };
  const first = route();
  if ("outcome" in first) return settle(first.outcome, first.reason);
  const { note } = first;
  let terminal: ActionCommand | undefined;
  try {
    terminal = await (o.stage ?? stageWorkerUpgrade)(
      execution as Worker,
      registered.os,
      o.signal,
    );
  } catch {
    /* Never surface raw SSH diagnostics or advertise unstaged files. */
  }
  let binding: string | undefined;
  try {
    binding = await o.currentBinding();
  } catch {
    binding = undefined;
  }
  // Rebound while staging: this observation's command is void, and so are older ones.
  if (binding !== pinned.fingerprint)
    return settle(
      { status: "unverifiable" },
      "暂存期间机器绑定已变化，旧的补装命令作废",
    );
  const key = agentToolsActionKey(
    machine,
    pinned.fingerprint,
    terminal?.command ?? null,
  );
  const digests = agentToolsRelease()?.digests;
  const instructions = `项目 ${project} 的机器 ${machine}：${problem}。${note}。Agent 在该机无法用固定入口下载附件、上传证据；这不挡派发。${
    terminal
      ? "暂存已就绪：请先暂停派发、确认无活跃任务，再登录目标机执行下方命令。命令先核对完整发行材料的摘要，再更新 deploy 目录、把附件助手装到 libexec/agent-tools，并把本项目已登记的 v1 签名升级入口迁移到 v2。换发行版或换绑定后本待办自动作废。"
      : "发行材料暂存失败，没有可执行命令。下次巡检或重跑 machine check 会重新备料并刷新本待办。"
  }\n${AGENT_TOOLS.map((name) => `${digests?.[name]}  agent-tools/${name}`).join("\n")}`;
  return store.uow.run((tx) => {
    if (!o.stillCurrent(tx)) return undefined;
    const again = route();
    if (!("note" in again) || again.note !== note) {
      const changed =
        "outcome" in again
          ? again
          : {
              outcome: { status: "unverifiable" } as AgentToolsOutcome,
              reason: "暂存期间签名升级登记已变化，旧的补装命令作废",
            };
      if (hasOpenNotice(store, project, machine))
        retire(tx, project, machine, clock, changed.reason);
      return changed.outcome;
    }
    retire(
      tx,
      project,
      machine,
      clock,
      "已由当前绑定和发行材料的附件助手待办取代",
      key,
    );
    const action = unwrap(
      requestDeploymentAction(
        loadCommandState(tx, project),
        { kind: "system", project_id: project },
        {
          key,
          reason: "worker_maintenance",
          instructions,
          ...(terminal ? { terminal } : {}),
        },
        { ids: tx.ids, clock },
      ),
    );
    persistEffect(tx, project, action);
    return {
      status: terminal ? "ready" : "staging_failed",
      human_action_id: action.data.id,
      key,
    } satisfies AgentToolsOutcome;
  });
}

export interface AgentToolsGuidance {
  readonly status: AgentToolsOutcome["status"] | "changed";
  readonly message: string;
  readonly human_action_id?: string;
  readonly terminal?: ActionCommand;
}

const MESSAGES: Record<AgentToolsGuidance["status"], string> = {
  current: "附件助手与当前发布一致。",
  automatic:
    "该机已登记签名自动升级：下次巡检会按当前发布安装附件助手，之后重跑 machine check 核对。",
  held: "签名自动升级未通过核验，请先按升级待办恢复，再重跑 machine check。",
  unverifiable:
    "无法核验当前绑定或控制端发行材料，没有可执行命令。修复后重跑 machine check。",
  staging_failed:
    "发行材料暂存失败，没有可执行命令。稍后重跑 machine check 会重新备料并刷新待办。",
  ready:
    "请先暂停派发、确认无活跃任务，再按待办在目标机执行下方命令；完成后重跑 machine check。",
  changed:
    "本次检查之后绑定、发行材料或待办已变化，旧命令作废。请重跑 machine check。",
};

/**
 * For the explicit caller only (never `machine show`, the patrol or history):
 * return this observation's command after re-deriving it from the current
 * binding and verified release; any difference returns no command.
 */
export function agentToolsGuidance(
  store: Store,
  project: string,
  machine: string,
  outcome: AgentToolsOutcome | undefined,
  target: { execution: ExecutionConfig; machine: { os: string } } | undefined,
): AgentToolsGuidance | undefined {
  if (!outcome || outcome.status === "current") return undefined;
  const reply = (status: AgentToolsGuidance["status"], extra = {}) => ({
    status,
    message: MESSAGES[status],
    ...extra,
  });
  if (outcome.status !== "ready")
    return reply(
      outcome.status,
      outcome.human_action_id
        ? { human_action_id: outcome.human_action_id }
        : {},
    );
  const changed = reply("changed");
  const execution = target?.execution;
  const pinned = execution?.target;
  if (
    !target ||
    execution?.mode !== "agent-ssh" ||
    !pinned ||
    pinned.machine_id !== machine ||
    pinned.project_id !== project ||
    !outcome.human_action_id
  )
    return changed;
  let command: string;
  try {
    command = upgradeMaterials(execution, target.machine.os).terminal.command;
  } catch {
    return changed;
  }
  if (agentToolsActionKey(machine, pinned.fingerprint, command) !== outcome.key)
    return changed;
  const action = store.uow.read((tx) =>
    tx.human_actions.get(project, outcome.human_action_id as HumanActionId),
  );
  if (action?.status !== "open" || action.terminal?.command !== command)
    return changed;
  return reply("ready", {
    human_action_id: action.id,
    terminal: action.terminal,
  });
}
