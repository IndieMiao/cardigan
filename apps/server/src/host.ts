import { execFile } from "node:child_process";
import { open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Assignment, Clock, ProjectId } from "@cardigan/domain";
import {
  adoptInstalledCatalog,
  agentCliVersion,
  harnessBinary,
  isAcceptedLaunchRevision,
  launchFilesStamp,
  launchFingerprint,
  type PreparationRetryOptions,
  parseCachedLaunchConfig,
  prepareRoleWorktree,
  publishLaunchRefresh,
  RuntimeTargets,
  recordLaunchNotice,
  recoverLaunchPublications,
  resolveMcpUrl,
  selectableLaunchConfig,
  stageModelLaunchConfig,
  withLaunchSnapshot,
  withPreparationQueue,
  withPreparationRetry,
  worktreeBaselinePrompt,
} from "@cardigan/host";
import {
  type LaunchConfig,
  parseSecretsText,
  profileLaunchSettings,
  reportLaunchWarnings,
  resolveProfile,
  validateLaunchSecrets,
} from "@cardigan/roles";
import {
  type ExecutionConfig,
  type HcClient,
  resolveDataDirectory,
  resolveExecutionConfig,
} from "@cardigan/runtime-herdr";
import {
  getRoleVersion,
  recordAcceptedBrowserPath,
  type Store,
} from "@cardigan/store";
import { parse as parseYaml } from "yaml";
import { standingResolver } from "./assembly.js";
import type { ServerEnv } from "./config.js";
import type { DispatcherOptions, LaunchSnapshot } from "./dispatch.js";
import { startQueuedRun } from "./host-start.js";

import { type LaunchGeneration, liveLaunch } from "./live-launch.js";

const exec = promisify(execFile);

/**
 * M3.5 production wiring: everything the Dispatcher needs that is host policy
 * rather than domain logic — the launch configuration, the hc runtime, the
 * model/CLI snapshot for a fresh terminal, and the M2.6 start adapter.
 */
export interface HostWiring {
  readonly recoverLaunches: (project: ProjectId) => Promise<void>;
  readonly publishWhileBackgroundOwner: () => () => void;
  readonly refreshLaunch: () => Promise<unknown>;
  readonly upstream: LaunchConfig;
  readonly adoptLaunch: (generation: LaunchGeneration) => void;
  readonly selectableLaunchConfig: () => LaunchConfig;
  readonly runtime: RuntimeTargets;
  readonly beforeWake: NonNullable<DispatcherOptions["beforeWake"]>;
  readonly snapshot: (
    assignment: Assignment,
    project: ProjectId,
  ) => Promise<LaunchSnapshot>;
  readonly startRun: DispatcherOptions["startRun"];
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

/** Load a complete generation; never publish individual file changes. */
export async function loadLaunchFiles(
  dir: string,
  report: (message: string) => void = console.warn,
  dataDir = resolveDataDirectory(),
  store?: Store,
): Promise<LaunchGeneration> {
  const launchFile = join(dir, "launch.yaml"),
    secretsFile = join(dir, "secrets.env");
  // Isolated callers may validate without publishing; runtime wiring supplies the shared store.
  const fence = store
    ? withLaunchSnapshot(store, dir, dataDir, (f) => f)
    : {
        files: launchFilesStamp(dir),
        revision: 0,
        catalogFile: "",
        canAdoptCatalog: false,
      };
  let text: string;
  try {
    text = await readFile(launchFile, "utf8");
  } catch {
    throw new Error(
      `找不到启动配置：${launchFile}（先运行 cardigan launch import-claude-settings 或手写）`,
    );
  }
  const raw = parseYaml(text, { prettyErrors: false });
  if (raw == null) throw new Error("启动配置为空");
  let secrets: Readonly<Record<string, string>> = {};
  try {
    const file = await open(secretsFile, "r");
    try {
      if (((await file.stat()).mode & 0o777) !== 0o600)
        throw new Error(`${secretsFile} 的权限必须收紧到 600（chmod 600）`);
      secrets = parseSecretsText(await file.readFile("utf8"));
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // A committed projection is already validated. Its TTL governs the *next* refresh,
  // not whether the host can catch up to this revision (even if a GET recovered it).
  const staged = fence.canAdoptCatalog
    ? { config: parseCachedLaunchConfig(raw, dataDir), catalog: undefined }
    : await stageModelLaunchConfig(raw, dataDir);
  validateLaunchSecrets(staged.config, secrets);
  reportLaunchWarnings(staged.config, report); // no callbacks inside the publication critical section
  if (store) {
    const profiles = Object.keys(
      selectableLaunchConfig({ config: staged.config, secrets }).profiles,
    );
    const revision = fence.canAdoptCatalog
      ? adoptInstalledCatalog(store, dir, dataDir, fence, profiles)
      : publishLaunchRefresh(store, dir, dataDir, fence, {
          catalog: staged.catalog,
          hostProfiles: profiles,
        });
    return { config: staged.config, secrets, revision };
  }
  if (fence.files !== launchFilesStamp(dir))
    throw new Error("加载期间配置已变化");
  return { config: staged.config, secrets };
}

/** Ask the harness binary for its version (local mode only); the Run records it. */
async function cliVersion(
  binary: string,
  args: readonly string[],
): Promise<string> {
  const { stdout } = await exec(binary, args, { timeout: 10_000 });
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
    browsersPath: async () =>
      (await live.refresh()).config.browser?.browsers_path,
    execution,
    session: env.CARDIGAN_HC_SESSION ?? "cardigan",
    // C-608: an MCP timeout at launch refreshes the readiness patrol now.
    refreshAfterLaunchFailure: true,
    ...(options.client === undefined ? {} : { client: options.client }),
  });
  if (!created.ok)
    throw new Error(
      `运行时不可用：${created.error.code} ${created.error.message}`,
    );
  const runtime = created.value;
  const dir = configDir(env);
  const live = await liveLaunch(
    dir,
    () => loadLaunchFiles(dir, undefined, options.dataDir, options.store),
    () => {
      const message =
        "主机启动配置重载失败，继续使用上一版。请检查 launch.yaml、secrets.env 及其权限。";
      console.warn(message);
      options.store.uow.run((tx) =>
        recordLaunchNotice(options.store, tx, "launch_reload_failed", message),
      );
    },
    (next) => isAcceptedLaunchRevision(options.store, dir, next.revision),
  );
  const generations = new WeakMap<
    LaunchSnapshot,
    Awaited<ReturnType<typeof loadLaunchFiles>>
  >();
  const mcpUrl = hostMcpUrl(options.url, env);
  const versions = new Map<string, string>();

  return {
    runtime,
    get upstream() {
      return live.current().config;
    },
    refreshLaunch: live.refresh,
    adoptLaunch: live.adopt,
    selectableLaunchConfig: () => {
      const current = live.current();
      // Reference saves call this inside their SQLite write transaction. Another host
      // can install first; never authorize an old name while this process catches up.
      return isAcceptedLaunchRevision(options.store, dir, current.revision)
        ? selectableLaunchConfig(current)
        : { ...current.config, profiles: {} };
    },
    publishWhileBackgroundOwner: () =>
      live.publishWhileOwned(({ config }) =>
        recordAcceptedBrowserPath(options.store, config.browser?.browsers_path),
      ),
    // Lock contention and transient network errors retry briefly inside this
    // delivery; the final error carries a sanitized category (§6.5, §12.4).
    beforeWake: async ({ project, assignment }) => {
      if (assignment.scope !== "work_item") return undefined;
      const target = await runtime.forSession(project, assignment);
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
      const target = await runtime.forSession(project, assignment);
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
      const launch = await live.refresh();
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
      const snapshot = {
        launch_fingerprint: launchFingerprint(
          options.store,
          launch,
          profileRef,
          role.capabilities.includes("browser"),
        ),
        model: profile.model,
        agent_cli_version: version,
        launch_profile_ref: profileRef,
        // C-106: the launch replaces these with the compiled arguments' values.
        ...profileLaunchSettings(profile),
      };
      generations.set(snapshot, launch);
      return snapshot;
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
    startRun: async (input) =>
      startQueuedRun(
        {
          store: options.store,
          runtime,
          launch:
            (input.snapshot && generations.get(input.snapshot)) ??
            (await live.refresh()),
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
          ...(input.resourceAccess
            ? { resourceAccess: input.resourceAccess }
            : {}),
          ...(input.resourcePreflight
            ? { resourcePreflight: input.resourcePreflight }
            : {}),
          ...(input.resourceGate ? { resourceGate: input.resourceGate } : {}),
          ...(input.replacement ? { replacement: input.replacement } : {}),
        },
      ),
  };
}
