import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  Assignment,
  Clock,
  DispatchRunParams,
  ProjectId,
  Run,
} from "@cardigan/domain";
import {
  agentCliVersion,
  harnessBinary,
  type PreparationRetryOptions,
  prepareRoleWorktree,
  RuntimeTargets,
  recoverLaunchPublications,
  resolveMcpUrl,
  withPreparationQueue,
  withPreparationRetry,
  worktreeBaselinePrompt,
} from "@cardigan/host";
import {
  type LaunchConfig,
  parseLaunchConfig,
  parseSecretsText,
  profileLaunchSettings,
  reportLaunchWarnings,
  resolveProfile,
} from "@cardigan/roles";
import {
  type ExecutionConfig,
  type HcClient,
  resolveExecutionConfig,
} from "@cardigan/runtime-herdr";
import { getRoleVersion, type Store } from "@cardigan/store";
import { parse as parseYaml } from "yaml";
import { standingResolver } from "./assembly.js";
import type { ServerEnv } from "./config.js";
import type { DispatcherOptions, LaunchSnapshot } from "./dispatch.js";
import { startQueuedRun } from "./host-start.js";

const exec = promisify(execFile);

/**
 * M3.5 production wiring: everything the Dispatcher needs that is host policy
 * rather than domain logic — the launch configuration, the hc runtime, the
 * model/CLI snapshot for a fresh terminal, and the M2.6 start adapter.
 */
export interface HostWiring {
  readonly recoverLaunches: (project: ProjectId) => Promise<void>;
  readonly upstream: LaunchConfig;
  readonly runtime: RuntimeTargets;
  readonly beforeWake: NonNullable<DispatcherOptions["beforeWake"]>;
  readonly snapshot: (
    assignment: Assignment,
    project: ProjectId,
  ) => Promise<LaunchSnapshot>;
  readonly startRun: (input: {
    project: string;
    assignment: Assignment;
    run: Run;
    bell: string;
    replacement?: DispatchRunParams["replacement"];
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
export async function loadLaunchFiles(
  dir: string,
  report: (message: string) => void = console.warn,
): Promise<{
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
  reportLaunchWarnings(config, report);
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

/**
 * Read the MCP URL at each launch (first start, wake, session replacement or
 * restart), never once at startup: the listener's port decides it (C-211).
 */
export function hostMcpUrl(
  option: string | (() => string) | undefined,
  env: HostEnv,
): () => string {
  if (typeof option === "function") return option;
  return () => option ?? resolveMcpUrl(env);
}

export async function createHostWiring(options: {
  readonly env: HostEnv;
  readonly store: Store;
  readonly dataDir: string;
  readonly execution?: ExecutionConfig;
  readonly clock?: Clock;
  /**
   * Card MCP endpoint for Agent configs. A function is read at each launch,
   * so the server can hand in the address it actually listens on (C-211).
   * Without it: `CARDIGAN_MCP_URL`, else `CARDIGAN_MCP_HOST`/`CARDIGAN_MCP_PORT`.
   */
  readonly url?: string | (() => string);
  /** Test harnesses pass a client that refuses calls after cleanup (§P2a-2). */
  readonly client?: HcClient;
  /** Tests shorten the in-delivery retry waits. */
  readonly preparationRetry?: PreparationRetryOptions;
}): Promise<HostWiring> {
  const env = options.env;
  const execution =
    options.execution ??
    resolveExecutionConfig({
      ...env,
      CARDIGAN_DATA_DIR: options.dataDir,
    });
  const created = await RuntimeTargets.create({
    store: options.store,
    env: { ...env },
    execution,
    session: env.CARDIGAN_HC_SESSION ?? "cardigan",
    ...(options.client === undefined ? {} : { client: options.client }),
  });
  if (!created.ok)
    throw new Error(
      `运行时不可用：${created.error.code} ${created.error.message}`,
    );
  const runtime = created.value;
  const launch = await loadLaunchFiles(configDir(env));
  const mcpUrl = hostMcpUrl(options.url, env);
  const versions = new Map<string, string>();

  return {
    runtime,
    upstream: launch.config,
    // Lock contention and transient network errors retry briefly inside this
    // delivery; the final error carries a sanitized category (§6.5, §12.4).
    beforeWake: async ({ project, assignment }) => {
      if (assignment.scope !== "work_item") return undefined;
      const target = await runtime.forLaunch(project, assignment);
      const worktree = await withPreparationQueue(
        target.execution.dataDir,
        project,
        () =>
          withPreparationRetry(
            () =>
              prepareRoleWorktree(
                {
                  store: options.store,
                  execution: target.execution,
                  runtime: runtime.forProject(project),
                },
                project,
                assignment.id,
              ),
            options.preparationRetry ?? {},
          ),
      );
      return worktreeBaselinePrompt(worktree);
    },
    standing: standingResolver(options.store),
    snapshot: async (assignment, project) => {
      const target = await runtime.forLaunch(project, assignment);
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
      const employee = options.store.uow.read((tx) =>
        assignment.employee_id
          ? tx.employees.get(assignment.employee_id)
          : undefined,
      );
      const profileRef =
        employee?.launch_profile_ref ?? role.launch_profile_ref;
      const profile = resolveProfile(launch.config, profileRef).profile;
      if (profile.model === undefined)
        throw new Error("The launch profile has no model");
      // In agent-ssh mode the binary only exists for the agent account, so the
      // probe goes through the runtime instead of the host's PATH (M2.7, §13.4).
      const binary = harnessBinary(profile.harness);
      const versionKey = `${target.execution.target?.fingerprint}:${binary}`;
      const cached = versions.get(versionKey);
      const version =
        cached ??
        (await agentCliVersion(
          {
            execution: target.execution,
            captureAgent: (command, args) =>
              runtime.captureFor(project, assignment, command, args),
            captureLocal: cliVersion,
          },
          binary,
        ));
      versions.set(versionKey, version);
      return {
        model: profile.model,
        agent_cli_version: version,
        launch_profile_ref: profileRef,
        // C-106: the launch replaces these with the compiled arguments' values.
        ...profileLaunchSettings(profile),
      };
    },
    recoverLaunches: (project) =>
      recoverLaunchPublications(
        {
          store: options.store,
          runtime,
          execution,
          ...(options.clock ? { clock: options.clock } : {}),
        },
        project,
      ),
    startRun: (input) =>
      startQueuedRun(
        {
          store: options.store,
          runtime,
          launch,
          mcpUrl: mcpUrl(),
          dataDir: options.dataDir,
          configDir: configDir(env),
          execution,
          ...(options.clock === undefined ? {} : { clock: options.clock }),
        },
        {
          project: input.project as never,
          assignment: input.assignment,
          run: input.run,
          bell: input.bell,
          ...(input.replacement ? { replacement: input.replacement } : {}),
        },
      ),
  };
}
