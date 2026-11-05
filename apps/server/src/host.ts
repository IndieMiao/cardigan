import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Assignment, Clock, Run } from "@cardigan/domain";
import { agentCliVersion, harnessBinary } from "@cardigan/host";
import {
  type LaunchConfig,
  parseLaunchConfig,
  parseSecretsText,
  resolveProfile,
} from "@cardigan/roles";
import {
  type ExecutionConfig,
  HerdrRuntime,
  resolveExecutionConfig,
} from "@cardigan/runtime-herdr";
import { getRoleVersion, type Store } from "@cardigan/store";
import { parse as parseYaml } from "yaml";
import { standingResolver } from "./assembly.js";
import type { ServerEnv } from "./config.js";
import { startQueuedRun } from "./host-start.js";

const exec = promisify(execFile);

/**
 * M3.5 production wiring: everything the Dispatcher needs that is host policy
 * rather than domain logic — the launch configuration, the hc runtime, the
 * model/CLI snapshot for a fresh terminal, and the M2.6 start adapter.
 */
export interface HostWiring {
  readonly runtime: HerdrRuntime;
  readonly snapshot: (
    assignment: Assignment,
  ) => Promise<Pick<Run, "model" | "agent_cli_version">>;
  readonly startRun: (input: {
    project: string;
    assignment: Assignment;
    run: Run;
    bell: string;
  }) => Promise<void>;
  readonly standing: ReturnType<typeof standingResolver>;
}

export interface HostEnv extends ServerEnv {
  readonly CARDIGAN_CONFIG_DIR?: string | undefined;
  readonly CARDIGAN_HC_SESSION?: string | undefined;
  readonly XDG_RUNTIME_DIR?: string | undefined;
  readonly CARDIGAN_MCP_URL?: string | undefined;
}

export const configDir = (env: HostEnv): string =>
  env.CARDIGAN_CONFIG_DIR ?? join(homedir(), ".config", "cardigan");

/** `launch.yaml` and `secrets.env` are read once at startup, like the CLI does. */
export async function loadLaunchFiles(dir: string): Promise<{
  config: LaunchConfig;
  secrets: Readonly<Record<string, string>>;
}> {
  const launchFile = join(dir, "launch.yaml"),
    secretsFile = join(dir, "secrets.env");
  let text: string;
  try {
    text = await readFile(launchFile, "utf8");
  } catch {
    throw new Error(
      `找不到启动配置：${launchFile}（先运行 cardigan launch import-claude-settings 或手写）`,
    );
  }
  const config = parseLaunchConfig(parseYaml(text) ?? {});
  let secrets: Readonly<Record<string, string>> = {};
  try {
    const entry = await stat(secretsFile);
    // The host never sources a credential file other users can read (§9.1).
    if ((entry.mode & 0o077) !== 0)
      throw new Error(`${secretsFile} 的权限必须收紧到 600（chmod 600）`);
    secrets = parseSecretsText(await readFile(secretsFile, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { config, secrets };
}

/** Ask the harness binary for its version (local mode only); the Run records it. */
async function cliVersion(binary: string): Promise<string> {
  const { stdout } = await exec(binary, ["--version"], { timeout: 10_000 });
  const line = stdout.trim().split("\n")[0]?.trim();
  if (!line) throw new Error(`${binary} --version printed nothing`);
  return line;
}

export async function createHostWiring(options: {
  readonly env: HostEnv;
  readonly store: Store;
  readonly dataDir: string;
  readonly execution?: ExecutionConfig;
  readonly clock?: Clock;
  readonly url?: string;
}): Promise<HostWiring> {
  const env = options.env;
  const execution =
    options.execution ??
    resolveExecutionConfig({
      ...env,
      CARDIGAN_DATA_DIR: options.dataDir,
    });
  const created = await HerdrRuntime.create({
    execution,
    session: env.CARDIGAN_HC_SESSION ?? "cardigan",
  });
  if (!created.ok)
    throw new Error(
      `运行时不可用：${created.error.code} ${created.error.message}`,
    );
  const runtime = created.value;
  const launch = await loadLaunchFiles(configDir(env));
  const url =
    options.url ?? env.CARDIGAN_MCP_URL ?? "http://127.0.0.1:3004/mcp";
  const versions = new Map<string, string>();

  return {
    runtime,
    standing: standingResolver(options.store),
    snapshot: async (assignment) => {
      // The port hands the Assignment without a project id; the role version
      // is unique per project, so look it up where it lives.
      const project = options.store
        .listProjects()
        .map((entry) => entry.id)
        .find(
          (id) =>
            options.store.uow.read((tx) =>
              tx.assignments.get(id, assignment.id),
            )?.id === assignment.id,
        );
      if (project === undefined)
        throw new Error(`Assignment ${assignment.id} is not in any project`);
      const role = options.store.uow.run((tx) =>
        getRoleVersion(
          tx,
          project,
          assignment.role_id,
          assignment.role_version,
        ),
      );
      if (role === undefined)
        throw new Error(`Role ${assignment.role_id} is missing`);
      const profile = resolveProfile(
        launch.config,
        role.launch_profile_ref,
      ).profile;
      if (profile.model === undefined)
        throw new Error("The launch profile has no model");
      // In agent-ssh mode the binary only exists for the agent account, so the
      // probe goes through the runtime instead of the host's PATH (M2.7, §13.4).
      const binary = harnessBinary(role.harness);
      const cached = versions.get(binary);
      const version =
        cached ??
        (await agentCliVersion(
          {
            execution,
            captureAgent: (command, args) =>
              runtime.captureAgent(command, args),
            captureLocal: cliVersion,
          },
          binary,
        ));
      versions.set(binary, version);
      return { model: profile.model, agent_cli_version: version };
    },
    startRun: (input) =>
      startQueuedRun(
        {
          store: options.store,
          runtime,
          launch,
          mcpUrl: url,
          dataDir: options.dataDir,
          execution,
          ...(options.clock === undefined ? {} : { clock: options.clock }),
        },
        {
          project: input.project as never,
          assignment: input.assignment,
          run: input.run,
          bell: input.bell,
        },
      ),
  };
}
