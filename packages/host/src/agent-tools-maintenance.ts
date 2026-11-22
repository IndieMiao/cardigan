import type { ExecutionConfig } from "@cardigan/runtime-herdr";
import type { Store } from "@cardigan/store";
import {
  AGENT_TOOLS,
  agentToolsCapability,
  agentToolsProblem,
  agentToolsRelease,
} from "./agent-tools.js";
import { probeMachineCapability } from "./machine-capability-probe.js";
import { notifyWorkerMaintenance } from "./worker-maintenance.js";
import { stageWorkerUpgrade } from "./worker-upgrade.js";

/**
 * Whether a remote binding lacks the current attachment tools. Unknown (probe
 * failure) and an unverifiable controller release never count as stale: neither
 * would let an installation succeed.
 */
export async function agentToolsStale(
  execution: ExecutionConfig,
  machine: string,
  os: string,
  signal?: AbortSignal,
  probe = probeMachineCapability,
) {
  const current = agentToolsRelease();
  if (!current) return false;
  const result = await probe(
    execution,
    os,
    agentToolsCapability(execution, machine, current).check,
    signal,
  );
  return (
    result.ok &&
    /^agent-tools (?:ok|(?:missing|mismatch|not_executable):)/u.test(
      result.output,
    ) &&
    agentToolsProblem(result.output) !== undefined
  );
}

export const agentToolsActionKey = (machine: string) =>
  `worker-agent-tools:${machine}:${Object.values(agentToolsRelease()?.digests ?? {}).join(":")}`;

/**
 * Administrator route for bindings the automatic upgrade cannot complete: the
 * staged, digest-checked manual upgrade installs the tools and migrates an
 * entry enrolled before C-595 to v2, so later signed upgrades carry them.
 */
export async function requestAgentToolsMigration(
  store: Store,
  project: string,
  machine: string,
  execution: Extract<ExecutionConfig, { mode: "agent-ssh" }>,
  os: string,
  reason: string,
  signal?: AbortSignal,
  stage = stageWorkerUpgrade,
) {
  let terminal: Awaited<ReturnType<typeof stageWorkerUpgrade>> | undefined;
  try {
    terminal = await stage(execution, os, signal);
  } catch {
    /* Never surface raw SSH diagnostics or advertise unstaged files. */
  }
  const digests = agentToolsRelease()?.digests;
  store.uow.run((tx) =>
    notifyWorkerMaintenance(
      tx,
      project,
      { now: () => new Date().toISOString() },
      agentToolsActionKey(machine),
      `项目 ${project} 的机器 ${machine}：${reason}。附件助手（${AGENT_TOOLS.join("、")}）未装到 libexec/agent-tools，Agent 在该机无法用固定入口下载附件、上传证据；这不挡派发。${
        terminal
          ? "暂存已就绪：请先暂停派发、确认无活跃任务，再登录目标机执行下方命令。命令核对发行材料摘要后更新 deploy 目录、装入附件助手，并把已登记的签名升级入口迁移到 v2，之后自动升级会一并更新附件助手。"
          : "发行材料暂存失败，没有可执行命令。请主机运维核对 worker 连接后重跑 machine check。"
      }\n${Object.entries(digests ?? {})
        .map(([name, sha]) => `${sha}  agent-tools/${name}`)
        .join("\n")}`,
      terminal ? { terminal } : {},
    ),
  );
}
