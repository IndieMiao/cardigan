import type { RuntimeRef } from "@cardigan/domain";
import { RuntimeTargets } from "@cardigan/host";
import {
  DEFAULT_HC_SESSION,
  describeRuntime,
  type ExecutionConfig,
  type RegisteredRuntime,
  readRegisteredRuntime,
  resolveExecutionConfig,
  runtimeDifferences,
  runtimeOwnsRef,
} from "@cardigan/runtime-herdr";
import type { Store } from "@cardigan/store";
import { CliError, EXIT } from "./errors.js";
import type { CliIo } from "./io.js";

/**
 * C-152: the server registers its runtime and hc session in the data
 * directory (`runtime.json`). Commands that open a terminal must run with the
 * same runtime; commands that only reach an existing terminal follow the
 * runtime recorded on that terminal and the server's session.
 */
const LOAD_HINT =
  "请改用 deploy/install-cli.sh 安装的 cardigan 命令（每次执行会自动加载 runtime.env），或在当前 shell 先执行：set -a; . ~/.config/cardigan/agent-ssh/runtime.env; set +a";

async function registered(
  dataDir: string,
): Promise<RegisteredRuntime | undefined> {
  try {
    return await readRegisteredRuntime(dataDir);
  } catch (error) {
    throw new CliError(
      `无法读取 server 登记的运行时配置：${error instanceof Error ? error.message : String(error)}；它可能记录着 agent-ssh，不能当作未登记。请修复该文件的权限或内容；确认要重新登记时先把它移走，再用正确的运行环境启动 cardigan-server`,
      EXIT.failure,
    );
  }
}

function fromEnv(io: CliIo, dataDir: string): ExecutionConfig {
  try {
    return resolveExecutionConfig({ ...io.env, CARDIGAN_DATA_DIR: dataDir });
  } catch (error) {
    throw new CliError(
      `当前 shell 的运行时配置不合法：${error instanceof Error ? error.message : String(error)}`,
      EXIT.usage,
      [LOAD_HINT],
    );
  }
}

const nice = (io: CliIo) => {
  const value = io.env.CARDIGAN_AGENT_NICE;
  return value !== undefined && /^(?:[0-9]|1[0-9])$/.test(value)
    ? { agentNice: Number(value) }
    : {};
};

function fromRegistered(
  io: CliIo,
  dataDir: string,
  r: RegisteredRuntime,
): ExecutionConfig {
  if (r.mode === "local") return { mode: "local", dataDir, ...nice(io) };
  const { session: _session, ...agent } = r;
  return { ...agent, dataDir, ...nice(io) };
}

const explicitMode = (io: CliIo) => (io.env.CARDIGAN_RUNTIME_MODE ?? "") !== "";

/**
 * For `assignment start`, `pm start`, `pm rotate`, `assign --start` and
 * workspace Git: the shell's runtime and hc session must equal the server's
 * registration. Nothing falls back to local implicitly: without a
 * registration the shell must name its mode explicitly.
 */
export async function launchExecution(
  io: CliIo,
  dataDir: string,
  session: string = io.env.CARDIGAN_HC_SESSION ?? DEFAULT_HC_SESSION,
): Promise<ExecutionConfig> {
  const server = await registered(dataDir);
  if (server === undefined) {
    if (!explicitMode(io))
      throw new CliError(
        "拒绝启动：server 还没有在这个数据目录登记运行时（runtime.json），当前 shell 也没有设置 CARDIGAN_RUNTIME_MODE；不会默认按本机模式以你的账号启动 Agent。",
        EXIT.usage,
        [
          `先用正确的运行环境启动一次 cardigan-server（它会登记运行时）；${LOAD_HINT}`,
          "确实要在本机、当前账号下运行（没有账号隔离）时，显式设置 CARDIGAN_RUNTIME_MODE=local。",
        ],
      );
    return fromEnv(io, dataDir);
  }
  if (server.mode === "agent-ssh" && !explicitMode(io))
    throw new CliError(
      `拒绝启动：当前 shell 没有加载运行环境（CARDIGAN_RUNTIME_MODE 未设置），而 server 登记的运行时是 ${describeRuntime(server)}；继续会在本机以你的账号启动 Agent，没有账号隔离。`,
      EXIT.usage,
      [LOAD_HINT],
    );
  const current = fromEnv(io, dataDir);
  const differences = runtimeDifferences(server, current, session);
  if (differences.length > 0)
    throw new CliError(
      `拒绝启动：当前 shell 的运行时配置和 server 登记的不一致（server：${describeRuntime(server)}，会话 ${server.session}；当前 shell：${describeRuntime(current)}，会话 ${session}）。`,
      EXIT.usage,
      [
        ...differences,
        `${LOAD_HINT}；如果 server 的配置才是过期的，请用正确的 runtime.env 重启 cardigan-server。`,
      ],
    );
  return current;
}

/**
 * For `assignment attach` and `stop`: pick the runtime that owns the recorded
 * terminal and the server's hc session, so the command works from a plain
 * shell and explains a terminal that lives elsewhere instead of failing with
 * a generic invalid_launch. An explicit `--hc-session` still wins.
 */
export async function terminalExecution(
  io: CliIo,
  dataDir: string,
  ref: RuntimeRef | null,
  id: string,
  sessionFlag?: string,
  context?: { readonly store: Store; readonly project: string },
): Promise<{ readonly execution: ExecutionConfig; readonly session: string }> {
  const server = await registered(dataDir);
  const session =
    sessionFlag ??
    server?.session ??
    io.env.CARDIGAN_HC_SESSION ??
    DEFAULT_HC_SESSION;
  const base =
    server === undefined
      ? fromEnv(io, dataDir)
      : fromRegistered(io, dataDir, server);
  if (ref?.target && context) {
    const runtime = await RuntimeTargets.create({
      execution: base,
      session,
      env: io.env,
      store: context.store,
      project: context.project,
    });
    if (
      !runtime.ok ||
      !runtime.value.ownsRef(ref) ||
      (sessionFlag && sessionFlag !== ref.target.session)
    )
      throw new CliError(
        "终端的受信目标绑定不匹配，已保留旧引用供核对。",
        EXIT.failure,
      );
    return { execution: base, session };
  }
  if (ref === null || runtimeOwnsRef(base, ref))
    return { execution: base, session };
  // A terminal started in local mode stays reachable from the same host account.
  if (ref.machine_id === "local" && ref.runtime_machine === "local")
    return { execution: { mode: "local", dataDir, ...nice(io) }, session };
  throw new CliError(
    `${id} 的终端 ${ref.terminal_ref} 记录在运行时机器 ${ref.runtime_machine}，不属于${server === undefined ? "当前 shell 的" : " server 登记的"}运行时 ${describeRuntime(base)}，从这里无法接入或停止。`,
    EXIT.failure,
    server === undefined && base.mode === "local"
      ? [`当前 shell 没有加载运行环境，server 也还没有登记运行时；${LOAD_HINT}`]
      : [
          "终端所在的运行时没有接入当前 server；如需重启，请让主机运维走 host_ops 重启，按 Needs You 中的步骤确认旧终端已退出。",
        ],
  );
}
