import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  Actor,
  Assignment,
  Clock,
  Machine,
  ProjectId,
  Run,
  Runtime,
  RuntimeLaunch,
  RuntimeRef,
} from "@cardigan/domain";
import { abortDispatch, dispatchRun } from "@cardigan/domain";
import {
  type CompiledAssignmentLaunch,
  compileAssignmentLaunch,
  firstPrompt,
  type LaunchConfig,
  resolveProfile,
  SECRETS_FILE_NAME,
  START_FILE_NAME,
  TOKEN_FILE_NAME,
} from "@cardigan/roles";
import {
  clearAgentSentinel,
  type ExecutionConfig,
  executionPaths,
  prepareAgentProject,
  scrubAgentLaunch,
  secureDataDirectory,
  writeAgentLaunch,
  writeAgentSentinel,
} from "@cardigan/runtime-herdr";
import type { Store } from "@cardigan/store";
import {
  applyCommand,
  issueAssignmentToken,
  launchEntities,
  wallClock,
} from "./commands.js";
import { HostLaunchError, type LaunchStep, messageOf } from "./errors.js";
import { agentNameFor } from "./naming.js";

/**
 * The one host-side start flow (M2 plan §4 steps 3–9).
 *
 * `cardigan assignment start` and the Dispatcher both end up here once a Run is
 * queued: the CLI with a Run it just queued and a worktree it prepared, the
 * server with a Run the Router queued and a bell as the first prompt. Everything
 * after that point — a fresh token (the old one is revoked), the compiled run
 * directory, provisioning, `dispatchRun`, the start sentinel, and the failure
 * compensation — exists once, so the two entries cannot drift apart.
 */

/** The worktree the host prepared before the Agent may start (M2.5). */
export interface PreparedWorktree {
  readonly path: string;
  readonly branch?: string | undefined;
  readonly base_sha: string;
}

export interface LaunchHost {
  readonly store: Store;
  readonly runtime: Runtime;
  readonly launch: {
    readonly config: LaunchConfig;
    readonly secrets: Readonly<Record<string, string>>;
  };
  readonly mcpUrl: string;
  readonly dataDir: string;
  readonly execution?: ExecutionConfig | undefined;
  readonly clock?: Clock | undefined;
  /**
   * Cleanup problems are reported and never thrown: a failed release or scrub
   * must not skip token revocation or Run cancellation (§13.4).
   */
  readonly report?: ((message: string) => void) | undefined;
}

export interface LaunchRunInput {
  readonly project: ProjectId;
  readonly assignment_id: Assignment["id"];
  /** The Run to start; it must already exist in `queued` state. */
  readonly run: Run;
  /** Human for the CLI, system for the Dispatcher: the domain checks differ. */
  readonly actor: Actor;
  /** Set when the caller prepared a worktree (M2.5); otherwise the Assignment's. */
  readonly worktree?: PreparedWorktree | undefined;
  /** The doorbell (M3 §3.2); without it the M2 initial prompt is generated. */
  readonly first_prompt?: string | undefined;
}

export interface LaunchedRun {
  readonly assignment: Assignment;
  readonly run: Run;
  readonly runtime_ref: RuntimeRef;
  readonly run_dir: string;
  readonly work_dir: string;
  readonly worktree_path?: string | undefined;
  readonly token_id: string;
}

/** Local machines are the only ones M2/M3 dispatch to (§13.1). */
function localMachine(clock: Clock): Machine {
  return {
    id: "local",
    label: "local",
    herdr_machine: "local",
    os: "linux",
    arch: "x64",
    tags: [],
    max_assignments: 1,
    status: "online",
    last_seen: clock.now(),
  };
}

async function writeRunDirectory(
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
 * Remove every plaintext secret from the run directory. The token is revoked
 * separately, but `secrets.env` holds provider credentials, so it is removed
 * even if `launch.sh` never ran (§10.2, §14).
 */
export async function scrubRunCredentials(
  execution: ExecutionConfig,
  project: ProjectId,
  assignment_id: Assignment["id"],
): Promise<void> {
  if (execution.mode === "agent-ssh") {
    await scrubAgentLaunch(execution, project, assignment_id);
    return;
  }
  const { runDir } = executionPaths(execution, project, assignment_id);
  for (const name of [TOKEN_FILE_NAME, SECRETS_FILE_NAME, START_FILE_NAME]) {
    await rm(join(runDir, name), { force: true });
  }
}

export function projectActor(
  kind: "human" | "system",
  project: ProjectId,
): Actor {
  return { kind, project_id: project };
}

/**
 * §3.4: a standing PM learns from its first prompt whether it is the foreground
 * Office or the background Ops. The two share the `pm` role, so the token scope
 * that was just issued is the only place the distinction lives (§7.1).
 */
export function standingModeLine(
  assignment: Assignment,
  allowed_tools: readonly string[],
): string | undefined {
  if (assignment.scope !== "standing" || assignment.role_id !== "pm")
    return undefined;
  return allowed_tools.includes("record_decision")
    ? "mode=foreground 当前身份：PM Office（前台）。只在 Needs You 新增项和重大风险时被打断；用 record_decision 记录人的原话。"
    : "mode=background 当前身份：PM Ops（后台）。接收 Router 升级的事件，按 Assignment 合并后投递，不直接打扰人。";
}

export async function launchRun(
  host: LaunchHost,
  input: LaunchRunInput,
): Promise<LaunchedRun> {
  const clock = host.clock ?? wallClock;
  const execution: ExecutionConfig = host.execution ?? {
    mode: "local",
    dataDir: host.dataDir,
  };
  const report = host.report ?? (() => undefined);
  const project = input.project;

  await secureDataDirectory(execution);
  const { assignment, role, card, workItem } = launchEntities(
    host.store,
    project,
    input.assignment_id,
  );
  if (assignment.status !== "active")
    throw new HostLaunchError(
      "directory preparation",
      `Assignment ${assignment.id} is ${assignment.status}`,
    );
  const current = host.store.uow.read((tx) =>
    tx.runs.get(project, input.run.id),
  );
  if (current?.status !== "queued")
    throw new HostLaunchError(
      "directory preparation",
      `Run ${input.run.id} is not queued`,
    );

  const { runDir } = executionPaths(execution, project, assignment.id);
  const workDir = input.worktree?.path ?? assignment.worktree_path ?? runDir;
  const agentName = agentNameFor({
    role_id: role.role_id,
    project_id: project,
    ...(card?.id === undefined ? {} : { card_id: card.id }),
    ...(workItem?.id === undefined ? {} : { work_item_id: workItem.id }),
    assignment_id: assignment.id,
  });

  let step: LaunchStep = "directory preparation";
  let tokenId: string | undefined;
  let ref: RuntimeRef | undefined;
  try {
    if (execution.mode === "agent-ssh")
      await prepareAgentProject(execution, project, assignment.id);

    step = "token issuance";
    const issued = issueAssignmentToken(host.store, project, {
      assignment,
      role,
    });
    tokenId = issued.record.id;

    step = "launch compilation";
    const model = resolveProfile(host.launch.config, role.launch_profile_ref)
      .profile.model;
    if (model === undefined)
      throw new Error(`Launch profile ${role.launch_profile_ref} has no model`);
    const compiled = compileAssignmentLaunch({
      assignment: {
        assignment_id: assignment.id,
        run_id: input.run.id,
        project_id: project,
        ...(card?.id === undefined ? {} : { card_id: card.id }),
        ...(workItem?.id === undefined ? {} : { work_item_id: workItem.id }),
      },
      role: {
        role_id: role.role_id,
        harness: role.harness,
        launch_profile: role.launch_profile_ref,
        core_prompt: role.core_prompt,
        // The harness advertises the tool scope the token actually carries, so
        // a rotated Ops session never even sees record_decision (§7.1).
        allowed_tools: issued.record.allowed_tools,
        worktree: role.worktree,
      },
      launch: host.launch.config,
      mcp: { url: host.mcpUrl },
      run_dir: runDir,
      work_dir: workDir,
      // The merged bell is the first prompt when the caller has one (M3 §3.2).
      first_prompt: [
        input.first_prompt ||
          firstPrompt({
            assignment_id: assignment.id,
            run_id: input.run.id,
            ...(card?.id === undefined ? {} : { card_id: card.id }),
            ...(workItem?.id === undefined
              ? {}
              : { work_item_id: workItem.id }),
          }),
        standingModeLine(assignment, issued.record.allowed_tools),
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n"),
      secrets: host.launch.secrets,
    });

    step = "run directory write";
    await clearAgentSentinel(execution, project, assignment.id);
    if (execution.mode === "agent-ssh")
      await writeAgentLaunch(
        execution,
        project,
        assignment.id,
        compiled.files,
        issued.token,
      );
    else await writeRunDirectory(compiled, issued.token);

    step = "runtime provision";
    const launchDesc: RuntimeLaunch = {
      command: compiled.launch_script,
      args: [],
      cwd: workDir,
      agent_name: agentName,
      labels: {
        cardigan: "1",
        project,
        assignment: assignment.id,
        run: input.run.id,
      },
    };
    const provisioned = await host.runtime.provision(
      assignment,
      role,
      localMachine(clock),
      launchDesc,
    );
    if (!provisioned.ok)
      throw new Error(
        `provision failed: ${provisioned.error.code} ${provisioned.error.message}`,
      );
    ref = provisioned.value;

    // The worktree is the host's fact, not the runtime's: hand it to dispatch
    // through the ref so the assignment records path, branch and base SHA.
    const dispatchRef: RuntimeRef =
      input.worktree === undefined
        ? ref
        : {
            ...ref,
            worktree_path: input.worktree.path,
            ...(input.worktree.branch === undefined
              ? {}
              : { branch: input.worktree.branch }),
          };
    const baseSha = input.worktree?.base_sha ?? assignment.base_sha;
    step = "dispatch";
    applyCommand(host.store, {
      project,
      actor: input.actor,
      clock,
      reduce: (state, actor, ports) =>
        dispatchRun(
          state,
          actor,
          {
            run_id: input.run.id,
            runtime_ref: dispatchRef,
            ...(baseSha === undefined ? {} : { base_sha: baseSha }),
          },
          ports,
        ),
    });

    // Only now may the wrapper start the Agent (M2 §4 step 5–8).
    step = "sentinel write";
    await writeAgentSentinel(execution, project, assignment.id);

    const started = launchEntities(host.store, project, assignment.id);
    const run = host.store.uow.read((tx) => tx.runs.get(project, input.run.id));
    if (run === undefined)
      throw new Error(`Run ${input.run.id} disappeared after dispatch`);
    return {
      assignment: started.assignment,
      run,
      runtime_ref: dispatchRef,
      run_dir: runDir,
      work_dir: workDir,
      ...(input.worktree === undefined
        ? {}
        : { worktree_path: input.worktree.path }),
      token_id: tokenId,
    };
  } catch (error) {
    await compensate({
      host,
      execution,
      project,
      assignment,
      run: input.run,
      actor: input.actor,
      clock,
      step,
      report,
      ...(ref === undefined ? {} : { ref }),
      ...(tokenId === undefined ? {} : { tokenId }),
    });
    throw error instanceof HostLaunchError
      ? error
      : new HostLaunchError(step, messageOf(error), { cause: error });
  }
}

interface Compensation {
  readonly host: LaunchHost;
  readonly execution: ExecutionConfig;
  readonly project: ProjectId;
  readonly assignment: Assignment;
  readonly run: Run;
  readonly actor: Actor;
  readonly clock: Clock;
  readonly step: LaunchStep;
  readonly report: (message: string) => void;
  readonly ref?: RuntimeRef | undefined;
  readonly tokenId?: string | undefined;
}

/** §4 step 9 / §13.4: release, scrub, revoke, cancel — each step independently. */
async function compensate(input: Compensation): Promise<void> {
  const { host, report } = input;
  if (input.ref !== undefined) {
    try {
      const released = await host.runtime.release(input.ref, { force: true });
      if (!released.ok) report(`终端回收失败：${released.error.code}`);
    } catch {
      report("终端回收失败，需要人工检查");
    }
  }
  try {
    await scrubRunCredentials(
      input.execution,
      input.project,
      input.assignment.id,
    );
  } catch {
    report("凭据文件清理失败，需要人工检查");
  }
  if (input.tokenId !== undefined) {
    try {
      if (!host.store.revokeToken(input.tokenId))
        report("Token 作废失败，需要人工检查");
    } catch {
      report("Token 作废失败，需要人工检查");
    }
  }
  try {
    applyCommand(host.store, {
      project: input.project,
      actor: input.actor,
      clock: input.clock,
      reduce: (state, actor, ports) =>
        abortDispatch(
          state,
          actor,
          { run_id: input.run.id, reason: `${input.step} failed` },
          ports,
        ),
    });
  } catch {
    // The Run may already be gone; the caller reports the original failure.
  }
}
