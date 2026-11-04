import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type {
  Actor,
  Assignment,
  Card,
  ProjectId,
  Role,
  Runtime,
  RuntimeLaunch,
  RuntimeRef,
  WorkItem,
} from "@cardigan/domain";
import { abortDispatch, dispatchRun, queueRun } from "@cardigan/domain";
import { GitWorktreeService } from "@cardigan/git-service";
import { LocalGitTransport } from "@cardigan/git-transport";
import {
  type CompiledAssignmentLaunch,
  compileAssignmentLaunch,
  firstPrompt,
  type LaunchConfig,
  resolveProfile,
  SECRETS_FILE_NAME,
  TOKEN_FILE_NAME,
} from "@cardigan/roles";
import {
  type ExecutionConfig,
  executionPaths,
  HerdrRuntime,
  prepareAgentProject,
  resolveExecutionConfig,
  scrubAgentLaunch,
  secureDataDirectory,
  writeAgentLaunch,
} from "@cardigan/runtime-herdr";
import { getRoleVersion, Store, writeRole } from "@cardigan/store";
import { AgentGitTransport } from "./agent-git.js";
import { loadConfig, loadSecrets } from "./config.js";
import { CliError, EXIT } from "./errors.js";
import {
  issueTokenForAssignment,
  resolveDataDir,
  resolveProject,
  runCommand,
  systemClock,
} from "./host.js";
import type { CliIo } from "./io.js";
import { resolveLaunchPaths } from "./paths.js";

/**
 * M2.6: one-command Assignment start (M2 plan §4).
 *
 * The CLI is the host side: it queues the Run, prepares the worktree, issues the
 * Assignment token, writes the run directory, provisions the runtime and then
 * dispatches the Run. Any failure releases the terminal, aborts the Run and
 * revokes the token again (§4 step 9).
 */

/** Project ids become directory names, so they must be safe segments. */
export function projectSegment(project_id: ProjectId): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(project_id)) {
    throw new CliError(`项目编号不能用作目录名：${project_id}`, EXIT.usage, [
      "只允许字母、数字和 . _ -",
    ]);
  }
  return project_id;
}

/** First 8 hex characters of sha256(project_id); M2 plan §3. */
export function projectShortCode(project_id: ProjectId): string {
  return createHash("sha256")
    .update(project_id, "utf8")
    .digest("hex")
    .slice(0, 8);
}

/**
 * `<role>-<project short code>-<card>-<work item>-<assignment>`, lowercased and
 * at most 32 characters; the role is truncated first so the codes survive.
 */
export function agentNameFor(input: {
  readonly role_id: string;
  readonly project_id: ProjectId;
  readonly card_id?: string;
  readonly work_item_id?: string;
  readonly assignment_id: string;
}): string {
  const parts = [
    input.role_id.toLowerCase(),
    projectShortCode(input.project_id),
    ...(input.card_id === undefined ? [] : [input.card_id.toLowerCase()]),
    ...(input.work_item_id === undefined
      ? []
      : [input.work_item_id.toLowerCase()]),
    input.assignment_id.toLowerCase(),
  ].map((part) => part.replace(/[^a-z0-9_-]/gu, "-"));
  const name = parts.join("-");
  if (name.length <= 32) return name;
  // Drop the role first, then shorten the role prefix if still too long.
  const tail = parts.slice(1).join("-");
  if (tail.length <= 32) {
    const room = 32 - tail.length - 1;
    return `${parts[0]?.slice(0, Math.max(1, room))}-${tail}`.slice(0, 32);
  }
  return tail.slice(-32);
}

export interface RunDirectory {
  readonly root: string;
  readonly runDir: string;
  readonly workDir: string;
}

/** `<data>/runs/<project>/<assignment>/`; worktree paths follow the same idea. */
export function runDirectory(input: {
  readonly dataDir: string;
  readonly project_id: ProjectId;
  readonly assignment_id: string;
  readonly worktreePath?: string;
  readonly execution?: ExecutionConfig;
}): RunDirectory {
  const { runDir } = executionPaths(
    input.execution ?? { mode: "local", dataDir: resolve(input.dataDir) },
    projectSegment(input.project_id),
    input.assignment_id,
  );
  const root = dirname(dirname(runDir));
  return { root, runDir, workDir: input.worktreePath ?? runDir };
}

/** The worktree the host must prepare before the Agent starts (M2.5). */
export interface WorktreeRequest {
  readonly project_id: ProjectId;
  /** The project's registered local repository. */
  readonly source_repo: string;
  readonly assignment: Assignment;
  readonly role: Role;
  readonly card?: Card | undefined;
  readonly work_item?: WorkItem | undefined;
}
export interface PreparedWorktree {
  readonly path: string;
  readonly branch?: string;
  readonly base_sha: string;
}
export type WorktreeProvider = (
  request: WorktreeRequest,
) => Promise<PreparedWorktree | undefined>;

export type LaunchRuntime = Runtime &
  Partial<Pick<HerdrRuntime, "captureAgent">>;

export interface StartOptions {
  readonly store: Store;
  readonly io: CliIo;
  readonly project_id: ProjectId;
  readonly assignment_id: Assignment["id"];
  readonly launch: {
    readonly config: LaunchConfig;
    readonly secrets: Readonly<Record<string, string>>;
  };
  readonly mcpUrl: string;
  readonly runtime: LaunchRuntime;
  readonly dataDir: string;
  readonly worktree?: WorktreeProvider;
}

export interface StartedAssignment {
  readonly assignment: Assignment;
  readonly run_id: string;
  readonly runtime_ref: RuntimeRef;
  readonly run_dir: string;
  readonly worktree_path?: string;
  readonly token_id: string;
}

const host = (project_id: ProjectId): Actor => ({ kind: "human", project_id });

function requireAssignment(
  store: Store,
  project_id: ProjectId,
  assignment_id: Assignment["id"],
): {
  assignment: Assignment;
  role: Role;
  card?: Card | undefined;
  workItem?: WorkItem | undefined;
} {
  return store.uow.run((tx) => {
    const assignment = tx.assignments.get(project_id, assignment_id);
    if (assignment === undefined) {
      throw new CliError(`Assignment ${assignment_id} 不存在`, EXIT.usage);
    }
    const role = getRoleVersion(
      tx,
      project_id,
      assignment.role_id,
      assignment.role_version,
    );
    if (role === undefined) {
      throw new CliError(
        `角色 ${assignment.role_id} v${assignment.role_version} 不存在`,
        EXIT.usage,
      );
    }
    if (assignment.scope !== "work_item") {
      return { assignment, role };
    }
    const workItem = tx.work_items.get(project_id, assignment.work_item_id);
    const card =
      workItem === undefined
        ? undefined
        : tx.cards.get(project_id, workItem.card_id);
    return { assignment, role, workItem, card };
  });
}

async function cliVersion(io: CliIo, binary: string): Promise<string> {
  const captured = await io.captureCommand(binary, ["--version"], {
    cwd: io.cwd,
    env: Object.fromEntries(
      Object.entries(io.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    timeoutMs: 10000,
  });
  const text =
    `${captured.stdout}\n${captured.stderr}`.trim().split("\n")[0] ?? "";
  if (captured.code !== 0 || text.length === 0) {
    throw new CliError(
      `无法获取 ${binary} 的版本（${captured.code ?? "no exit code"}）`,
      EXIT.usage,
    );
  }
  return text;
}

async function writeCompiledFiles(
  compiled: CompiledAssignmentLaunch,
  token: string,
): Promise<void> {
  for (const file of compiled.files) {
    await mkdir(dirname(file.path), { recursive: true, mode: 0o700 });
    await writeFile(file.path, file.content, {
      encoding: "utf8",
      mode: file.mode,
    });
  }
  // The token file is written last and consumed (deleted) by launch.sh.
  await writeFile(compiled.token_file, `${token}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

/**
 * §4 step 9: no plaintext secret may survive a failed start. The token is
 * revoked, but `secrets.env` holds provider credentials, so both files are
 * removed from the run directory even if `launch.sh` never ran.
 */
async function scrubRunDirectory(runDir: string): Promise<void> {
  for (const name of [TOKEN_FILE_NAME, SECRETS_FILE_NAME]) {
    await rm(join(runDir, name), { force: true });
  }
}

interface StartProgress {
  execution: ExecutionConfig;
  step: string;
  runId?: string;
  tokenId?: string;
  ref?: RuntimeRef;
}
const executionFor = (io: CliIo, dataDir: string) =>
  resolveExecutionConfig({
    ...io.env,
    CARDIGAN_DATA_DIR: resolveDataDir(io, dataDir),
  });
async function agentCapture(
  runtime: LaunchRuntime,
  command: "git" | "claude" | "codex" | "pi",
  args: readonly string[],
) {
  if (!runtime.captureAgent)
    throw new CliError("agent-ssh 启动需要 Agent 执行入口", EXIT.failure);
  const result = await runtime.captureAgent(command, args);
  if (!result.ok)
    throw new CliError(`Agent 命令失败：${result.error.code}`, EXIT.failure);
  return result.value;
}
async function scrubExecution(
  config: ExecutionConfig,
  project: ProjectId,
  assignment: string,
) {
  if (config.mode === "agent-ssh")
    await scrubAgentLaunch(config, project, assignment);
  else
    await scrubRunDirectory(executionPaths(config, project, assignment).runDir);
}
/** Run the M2 plan §4 flow, compensating every step after a successful queue. */
export async function startAssignment(
  options: StartOptions,
): Promise<StartedAssignment> {
  const progress: StartProgress = {
    execution: executionFor(options.io, options.dataDir),
    step: "preflight",
  };
  await secureDataDirectory(progress.execution);
  try {
    return await startAssignmentSteps(options, progress);
  } catch (error) {
    if (progress.runId) {
      // Cleanup failures must not skip token revocation or Run cancellation.
      if (progress.ref) {
        try {
          const released = await options.runtime.release(progress.ref, {
            force: true,
          });
          if (!released.ok)
            options.io.stderr(`终端回收失败：${released.error.code}`);
        } catch {
          options.io.stderr("终端回收失败，需要人工检查");
        }
      }
      try {
        await scrubExecution(
          progress.execution,
          options.project_id,
          options.assignment_id,
        );
      } catch {
        options.io.stderr("凭据文件清理失败，需要人工检查");
      }
      try {
        if (progress.tokenId && !options.store.revokeToken(progress.tokenId))
          options.io.stderr("Token 作废失败，需要人工检查");
      } catch {
        options.io.stderr("Token 作废失败，需要人工检查");
      }
      abort(
        options.store,
        options.project_id,
        progress.runId,
        `${progress.step} failed`,
      );
    }
    throw error;
  }
}
async function startAssignmentSteps(
  options: StartOptions,
  progress: StartProgress,
): Promise<StartedAssignment> {
  const { store, io, project_id } = options;
  const { assignment, role, card, workItem } = requireAssignment(
    store,
    project_id,
    options.assignment_id,
  );
  if (assignment.status !== "active") {
    throw new CliError(
      `Assignment 状态是 ${assignment.status}，只有 active 能启动`,
      EXIT.usage,
    );
  }

  // 2. queue the Run with a model/CLI snapshot (invariant 12).
  const profile = resolveProfile(
    options.launch.config,
    role.launch_profile_ref,
  ).profile;
  const model = profile.model;
  if (model === undefined) {
    throw new CliError(
      `启动配置 ${role.launch_profile_ref} 没有 model，Run 无法记录快照`,
      EXIT.usage,
    );
  }
  const binary = role.harness === "claude-code" ? "claude" : role.harness;
  const version =
    progress.execution.mode === "local"
      ? await cliVersion(io, binary)
      : (await agentCapture(options.runtime, binary, ["--version"]))
          .trim()
          .split("\n")[0];
  if (!version) throw new CliError("Agent CLI 没有返回版本", EXIT.usage);
  const run = runCommand(store, {
    project_id,
    actor: host(project_id),
    reduce: (state, actor, ports) =>
      queueRun(
        state,
        actor,
        {
          assignment_id: assignment.id,
          model,
          agent_cli_version: version,
        },
        ports,
      ),
  });

  progress.runId = run.id;
  progress.step = "directory preparation";
  if (progress.execution.mode === "agent-ssh")
    await prepareAgentProject(progress.execution, project_id, assignment.id);

  // 3. worktree (roles that do not need one skip it).
  progress.step = "worktree preparation";
  let worktree: PreparedWorktree | undefined;
  if (role.worktree !== "none") {
    if (options.worktree === undefined) {
      throw new CliError(
        "这个角色需要 worktree，但没有配置 Git 服务",
        EXIT.usage,
      );
    }
    const project = store.getProject(project_id);
    const source_repo = project?.repo_path;
    if (source_repo === undefined || source_repo === null) {
      throw new CliError(
        `项目 ${project_id} 没有登记本地仓库，先运行 cardigan project set-repo --path <目录>`,
        EXIT.usage,
      );
    }
    const placed = await options.worktree({
      project_id,
      source_repo,
      assignment,
      role,
      ...(card === undefined ? {} : { card }),
      ...(workItem === undefined ? {} : { work_item: workItem }),
    });
    if (placed === undefined) {
      throw new CliError("Git 服务没有给出 worktree", EXIT.failure);
    }
    worktree = placed;
  }

  const dirs = runDirectory({
    dataDir: options.dataDir,
    execution: progress.execution,
    project_id,
    assignment_id: assignment.id,
    ...(worktree === undefined ? {} : { worktreePath: worktree.path }),
  });

  // 4. token + run directory.
  progress.step = "launch compilation";
  const issued = store.uow.run((tx) =>
    issueTokenForAssignment(tx, project_id, assignment.id, {
      role_version: role.version,
      allowed_tools: role.allowed_tools,
    }),
  );
  progress.tokenId = issued.record.id;
  const compiled = compileAssignmentLaunch({
    assignment: {
      assignment_id: assignment.id,
      run_id: run.id,
      project_id,
      ...(card === undefined ? {} : { card_id: card.id }),
      ...(workItem === undefined ? {} : { work_item_id: workItem.id }),
    },
    role: {
      role_id: role.role_id,
      harness: role.harness,
      launch_profile: role.launch_profile_ref,
      core_prompt: role.core_prompt,
      allowed_tools: role.allowed_tools,
      worktree: role.worktree,
    },
    launch: options.launch.config,
    mcp: { url: options.mcpUrl },
    run_dir: dirs.runDir,
    work_dir: dirs.workDir,
    first_prompt: firstPrompt({
      assignment_id: assignment.id,
      run_id: run.id,
      ...(card === undefined ? {} : { card_id: card.id }),
      ...(workItem === undefined ? {} : { work_item_id: workItem.id }),
    }),
    secrets: options.launch.secrets,
  });
  progress.step = "run directory write";
  if (progress.execution.mode === "agent-ssh")
    await writeAgentLaunch(
      progress.execution,
      project_id,
      assignment.id,
      compiled.files,
      issued.token,
    );
  else await writeCompiledFiles(compiled, issued.token);

  // 5. provision the terminal.
  progress.step = "runtime provision";
  const agentName = agentNameFor({
    role_id: role.role_id,
    project_id,
    ...(card === undefined ? {} : { card_id: card.id }),
    ...(workItem === undefined ? {} : { work_item_id: workItem.id }),
    assignment_id: assignment.id,
  });
  const launchDesc: RuntimeLaunch = {
    command: compiled.launch_script,
    args: [],
    cwd: dirs.workDir,
    agent_name: agentName,
    labels: {
      cardigan: "1",
      project: project_id,
      assignment: assignment.id,
      run: run.id,
    },
  };
  const provisioned = await options.runtime.provision(
    assignment,
    role,
    machineRecord(project_id),
    launchDesc,
  );
  if (!provisioned.ok) {
    throw new CliError(
      `启动终端失败：${provisioned.error.code} ${provisioned.error.message}`,
      EXIT.failure,
    );
  }
  const ref = provisioned.value;
  progress.ref = ref;

  // 6. dispatch the Run with the runtime and worktree facts.
  progress.step = "dispatch";
  // The worktree is the host's fact, not the runtime's: hand it to dispatch
  // through the ref so the assignment records path, branch and base SHA.
  const dispatchRef: RuntimeRef =
    worktree === undefined
      ? ref
      : {
          ...ref,
          worktree_path: worktree.path,
          ...(worktree.branch === undefined ? {} : { branch: worktree.branch }),
        };
  runCommand(store, {
    project_id,
    actor: host(project_id),
    reduce: (state, actor, ports) =>
      dispatchRun(
        state,
        actor,
        {
          run_id: run.id,
          runtime_ref: dispatchRef,
          ...(worktree === undefined ? {} : { base_sha: worktree.base_sha }),
        },
        ports,
      ),
  });

  const started = requireAssignment(
    store,
    project_id,
    assignment.id,
  ).assignment;
  return {
    assignment: started,
    run_id: run.id,
    runtime_ref: dispatchRef,
    run_dir: dirs.runDir,
    ...(worktree === undefined ? {} : { worktree_path: worktree.path }),
    token_id: issued.record.id,
  };
}

function machineRecord(project_id: ProjectId) {
  return {
    id: "local",
    label: "local",
    herdr_machine: "local",
    os: "linux",
    arch: "x64",
    tags: [],
    max_assignments: 1,
    status: "online" as const,
    last_seen: systemClock.now(),
    project_id,
  } as never;
}

/** Abort the Run (best effort); the reason is recorded on it. */
export function abort(
  store: Store,
  project_id: ProjectId,
  run_id: string,
  reason: string,
): void {
  try {
    runCommand(store, {
      project_id,
      actor: host(project_id),
      reduce: (state, actor, ports) =>
        abortDispatch(state, actor, { run_id: run_id as never, reason }, ports),
    });
  } catch {
    // Nothing to abort (unknown or already finished Run).
  }
}

/** `cardigan assignment stop`: release the terminal, keep the worktree. */
export async function stopAssignment(input: {
  readonly store: Store;
  readonly project_id: ProjectId;
  readonly assignment_id: Assignment["id"];
  readonly runtime: Runtime;
  readonly execution?: ExecutionConfig;
}): Promise<{ released: boolean; aborted: boolean }> {
  const { assignment } = requireAssignment(
    input.store,
    input.project_id,
    input.assignment_id,
  );
  const ref = assignment.runtime_ref;
  if (ref === null) {
    throw new CliError(
      `Assignment ${assignment.id} 没有在运行的终端`,
      EXIT.usage,
    );
  }
  const released = await input.runtime.release(ref, { force: true });
  if (!released.ok && released.error.code !== "runtime_not_found") {
    throw new CliError(
      `释放终端失败：${released.error.code} ${released.error.message}`,
      EXIT.failure,
    );
  }
  const unfinished = input.store.uow.read((tx) =>
    tx.runs
      .list(input.project_id)
      .find(
        (run) =>
          run.assignment_id === assignment.id &&
          !["completed", "failed", "cancelled"].includes(run.status),
      ),
  );
  if (unfinished !== undefined) {
    abort(input.store, input.project_id, unfinished.id, "stopped by host");
  }
  // §9.1: the session is over, so its tokens die with it. A token that outlives
  // a stopped terminal could still read and write the project.
  const revoked = input.store.uow.run((tx) =>
    tx
      .tokensForAssignment(input.project_id, assignment.id)
      .filter((token) => token.revoked_at === null)
      .map((token) => tx.revokeToken(token.id)),
  );
  if (revoked.some((ok) => !ok)) {
    throw new CliError("作废 Token 失败", EXIT.failure);
  }
  if (input.execution)
    await scrubExecution(
      input.execution,
      input.project_id,
      input.assignment_id,
    );
  return { released: true, aborted: unfinished !== undefined };
}

/** `cardigan assignment attach`: print the command a human can paste. */
export async function attachAssignment(input: {
  readonly store: Store;
  readonly project_id: ProjectId;
  readonly assignment_id: Assignment["id"];
  readonly runtime: Runtime;
}): Promise<string> {
  const { assignment } = requireAssignment(
    input.store,
    input.project_id,
    input.assignment_id,
  );
  const ref = assignment.runtime_ref;
  if (ref === null) {
    throw new CliError(
      `Assignment ${assignment.id} 没有在运行的终端`,
      EXIT.usage,
    );
  }
  const entry = await input.runtime.human_entry(ref);
  if (!entry.ok) {
    throw new CliError(
      `无法给出进入方式：${entry.error.code} ${entry.error.message}`,
      EXIT.failure,
    );
  }
  return entry.value;
}

export { writeRole };

const USAGE = [
  "用法：",
  "  cardigan assignment start <A-n> [--project <p>] [--mcp-url <url>] [--hc-session <s>] [--data-dir <目录>]",
  "  cardigan assignment stop <A-n> [--project <p>] [--hc-session <s>] [--data-dir <目录>]",
  "  cardigan assignment attach <A-n> [--project <p>] [--hc-session <s>] [--data-dir <目录>]",
].join("\n");

const DEFAULT_MCP_URL = "http://127.0.0.1:3004/mcp";

function parseArgs(args: readonly string[]) {
  const [sub, ...rest] = args;
  if (sub !== "start" && sub !== "stop" && sub !== "attach") {
    throw new CliError(
      "用法：cardigan assignment start|stop|attach",
      EXIT.usage,
      [USAGE],
    );
  }
  const flags: Record<string, string> = {};
  const positionals: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] as string;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const value = rest[index + 1];
    if (value === undefined) {
      throw new CliError(`${token} 需要一个值`, EXIT.usage, [USAGE]);
    }
    flags[token.slice(2)] = value;
    index += 1;
  }
  const assignmentId = positionals[0];
  if (assignmentId === undefined) {
    throw new CliError("缺少 Assignment 编号（A-n）", EXIT.usage, [USAGE]);
  }
  return { sub, assignmentId: assignmentId as Assignment["id"], flags };
}

/** `cardigan assignment start|stop|attach` (M2.6). */
export async function runAssignmentCommand(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  const { sub, assignmentId, flags } = parseArgs(args);
  const dataDir = resolveDataDir(io, flags["data-dir"]);
  const execution = executionFor(io, dataDir);
  await secureDataDirectory(execution);
  const store = Store.open({ dataDir });
  try {
    const project_id = resolveProject(store, io, flags.project);
    const session =
      flags["hc-session"] ?? io.env.CARDIGAN_HC_SESSION ?? "cardigan";
    const created = await HerdrRuntime.create({ session, execution });
    if (!created.ok) {
      throw new CliError(
        `运行时不可用：${created.error.code} ${created.error.message}`,
        EXIT.failure,
      );
    }
    const runtime = created.value;

    if (sub === "stop") {
      const result = await stopAssignment({
        store,
        project_id,
        assignment_id: assignmentId,
        runtime,
        execution,
      });
      io.stdout(
        `已释放 ${assignmentId} 的终端${result.aborted ? "，未结束的 Run 已取消" : ""}（worktree 保留）`,
      );
      return EXIT.ok;
    }
    if (sub === "attach") {
      io.stdout(
        await attachAssignment({
          store,
          project_id,
          assignment_id: assignmentId,
          runtime,
        }),
      );
      return EXIT.ok;
    }
    return await startAssignmentCommand({
      store,
      io,
      project_id,
      assignment_id: assignmentId,
      runtime,
      dataDir: flags["data-dir"] ?? io.env.CARDIGAN_DATA_DIR ?? ".data",
      ...(flags["mcp-url"] === undefined ? {} : { mcpUrl: flags["mcp-url"] }),
    });
  } finally {
    store.close();
  }
}

export interface StartCommandOptions {
  readonly store: Store;
  readonly io: CliIo;
  readonly project_id: ProjectId;
  readonly assignment_id: Assignment["id"];
  readonly runtime: LaunchRuntime;
  readonly dataDir: string;
  readonly mcpUrl?: string;
}

/** Load the host config, wire the Git service and start one Assignment. */
export async function startAssignmentCommand(
  options: StartCommandOptions,
): Promise<number> {
  const { store, io, project_id, assignment_id, runtime } = options;
  const paths = resolveLaunchPaths(io.env);
  const dataDir = resolveDataDir(io, options.dataDir);
  const execution = executionFor(io, dataDir);
  const locations = executionPaths(execution, project_id, assignment_id);
  const transport =
    execution.mode === "local"
      ? new LocalGitTransport()
      : new AgentGitTransport(execution, project_id, assignment_id, (args) =>
          agentCapture(runtime, "git", args),
        );
  const gitService = new GitWorktreeService(transport, {
    dataDir,
    ...locations,
  });

  const started = await startAssignment({
    store,
    io,
    project_id,
    assignment_id,
    launch: {
      config: await loadConfig(paths),
      secrets: await loadSecrets(paths, io),
    },
    mcpUrl: options.mcpUrl ?? io.env.CARDIGAN_MCP_URL ?? DEFAULT_MCP_URL,
    runtime,
    dataDir,
    worktree: async (request) => {
      const placed = await gitService.ensureWorktree({
        project_id: request.project_id,
        source_repo: request.source_repo,
        assignment: request.assignment,
        role: request.role,
        ...(request.card === undefined ? {} : { card: request.card }),
        ...(request.work_item === undefined
          ? {}
          : { work_item: request.work_item }),
      });
      if (placed === undefined) return undefined;
      return {
        path: placed.worktree_path,
        ...(placed.branch === undefined ? {} : { branch: placed.branch }),
        base_sha: placed.base_sha,
      };
    },
  });

  io.stdout(
    [
      `已启动 ${started.assignment.id}（run ${started.run_id}）`,
      `终端：${started.runtime_ref.terminal_ref}（agent ${started.runtime_ref.agent_name}）`,
      `运行目录：${started.run_dir}`,
      ...(started.worktree_path === undefined
        ? []
        : [`worktree：${started.worktree_path}`]),
      "Token 已写入运行目录，由 launch.sh 读取后立即删除；这里不打印。",
    ].join("\n"),
  );
  return EXIT.ok;
}

export interface StartByIdOptions {
  readonly store: Store;
  readonly io: CliIo;
  readonly project_id: ProjectId;
  readonly assignment_id: Assignment["id"];
  readonly dataDir?: string;
  readonly mcpUrl?: string;
  readonly session?: string;
}
export type StartById = (options: StartByIdOptions) => Promise<number>;

/** Create the runtime and start one Assignment (used by `assign --start`). */
export async function startAssignmentById(
  options: StartByIdOptions,
): Promise<number> {
  const dataDir = resolveDataDir(options.io, options.dataDir);
  const execution = executionFor(options.io, dataDir);
  await secureDataDirectory(execution);
  const created = await HerdrRuntime.create({
    execution,
    session:
      options.session ?? options.io.env.CARDIGAN_HC_SESSION ?? "cardigan",
  });
  if (!created.ok) {
    throw new CliError(
      `运行时不可用：${created.error.code} ${created.error.message}`,
      EXIT.failure,
    );
  }
  return await startAssignmentCommand({
    ...options,
    runtime: created.value,
    dataDir,
  });
}
