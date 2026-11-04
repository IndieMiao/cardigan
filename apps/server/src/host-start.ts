import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  Actor,
  Assignment,
  Clock,
  CommandState,
  ProjectId,
  Role,
  Run,
  Runtime,
  RuntimeLaunch,
  RuntimeRef,
} from "@cardigan/domain";
import { abortDispatch, dispatchRun } from "@cardigan/domain";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import {
  compileAssignmentLaunch,
  firstPrompt,
  type LaunchConfig,
  resolveProfile,
} from "@cardigan/roles";
import {
  clearAgentSentinel,
  type ExecutionConfig,
  executionPaths,
  prepareAgentProject,
  START_FILE_NAME,
  scrubAgentLaunch,
  secureDataDirectory,
  writeAgentLaunch,
  writeAgentSentinel,
} from "@cardigan/runtime-herdr";
import { getRoleVersion, type Store } from "@cardigan/store";

/**
 * M3.5 host adapter: start a terminal for a Run the Dispatcher already queued.
 *
 * The Dispatcher decides *who* to wake and *what* the bell says; this module
 * does the M2.6 part (§4 steps 3–9) for that specific Run: a fresh token (the
 * old one is revoked), a compiled run directory whose first prompt is the bell,
 * a provisioned terminal, and `dispatchRun` on the same Run id. It never queues
 * a Run, and it compensates exactly like the CLI: release the terminal, scrub
 * the plaintext files, revoke the token, then abort the Run.
 */
export interface StartRunHost {
  readonly store: Store;
  readonly runtime: Runtime;
  readonly launch: {
    readonly config: LaunchConfig;
    readonly secrets: Readonly<Record<string, string>>;
  };
  readonly mcpUrl: string;
  readonly dataDir: string;
  readonly execution?: ExecutionConfig;
  readonly clock?: Clock;
}

export interface StartRunInput {
  readonly project: ProjectId;
  readonly assignment: Assignment;
  readonly run: Run;
  readonly bell: string;
}

const hostActor = (project: ProjectId): Actor => ({
  kind: "system",
  project_id: project,
});

function present<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

/** Assignment, its fixed Role version, and the card/work item it serves. */
function entities(store: Store, project: ProjectId, id: Assignment["id"]) {
  return store.uow.run((tx) => {
    const assignment = present(
      tx.assignments.get(project, id),
      `Assignment ${id} not found`,
    );
    const role = present(
      getRoleVersion(tx, project, assignment.role_id, assignment.role_version),
      `Role ${assignment.role_id} v${assignment.role_version} not found`,
    ) as Role;
    const item =
      assignment.scope === "work_item"
        ? tx.work_items.get(project, assignment.work_item_id)
        : undefined;
    const card = item ? tx.cards.get(project, item.card_id) : undefined;
    return { assignment, role, workItem: item, card };
  });
}

function issueToken(
  store: Store,
  project: ProjectId,
  assignment: Assignment,
  role: Role,
) {
  return store.uow.run((tx) => {
    for (const token of tx.tokensForAssignment(project, assignment.id))
      if (token.revoked_at === null) tx.revokeToken(token.id);
    return tx.issueToken({
      project_id: project,
      assignment_id: assignment.id,
      role: { role_version: role.version, allowed_tools: role.allowed_tools },
    });
  });
}

function agentName(input: {
  role_id: string;
  project: ProjectId;
  card?: string | undefined;
  item?: string | undefined;
  assignment: string;
}): string {
  // Same derivation as M2.6; the name only has to be unique and readable.
  const tail = [
    input.card?.toLowerCase(),
    input.item?.toLowerCase(),
    input.assignment.toLowerCase(),
  ]
    .filter((part): part is string => part !== undefined)
    .map((part) => part.replace(/[^a-z0-9_-]/gu, "-"))
    .join("-");
  return `agt-${tail}`.replace(/[^a-z0-9_-]/gu, "-").slice(0, 32);
}

function machineRecord(): never {
  return {
    id: "local",
    label: "local",
    herdr_machine: "local",
    os: "linux",
    arch: "x64",
    tags: [],
    max_assignments: 1,
    status: "online",
    last_seen: new Date().toISOString(),
  } as never;
}

/**
 * Start and dispatch `input.run`. Throws after compensating when any step
 * fails; the Dispatcher treats a thrown error as `delivery_call_failed`.
 */
export async function startQueuedRun(
  host: StartRunHost,
  input: StartRunInput,
): Promise<void> {
  const { store, runtime, project } = { ...input, ...host };
  const clock = host.clock ?? { now: () => new Date().toISOString() };
  const execution: ExecutionConfig = host.execution ?? {
    mode: "local",
    dataDir: host.dataDir,
  };
  await secureDataDirectory(execution);
  if (execution.mode === "agent-ssh")
    await prepareAgentProject(execution, project, input.assignment.id);

  const { assignment, role, card, workItem } = entities(
    store,
    project,
    input.assignment.id,
  );
  if (assignment.status !== "active")
    throw new Error(`Assignment ${assignment.id} is ${assignment.status}`);
  const current = store.uow.read((tx) => tx.runs.get(project, input.run.id));
  if (current?.status !== "queued")
    throw new Error(`Run ${input.run.id} is not queued`);

  const { runDir } = executionPaths(execution, project, assignment.id);
  const workDir = assignment.worktree_path ?? runDir;
  const issued = issueToken(store, project, assignment, role);
  const tokenId = issued.record.id;
  let ref: RuntimeRef | undefined;

  const abort = (reason: string) => {
    store.uow.run((tx) =>
      persistEffect(
        tx,
        project,
        unwrap(
          abortDispatch(
            loadCommandState(tx, project),
            hostActor(project),
            { run_id: input.run.id, reason },
            { clock: clock, ids: tx.ids },
          ),
        ),
      ),
    );
  };
  const scrub = async () => {
    try {
      if (execution.mode === "agent-ssh")
        await scrubAgentLaunch(execution, project, assignment.id);
      else
        for (const name of ["token", "secrets.env", START_FILE_NAME])
          await rm(join(runDir, name), { force: true });
    } catch {
      // Cleanup failures must not skip token revocation or Run cancellation.
    }
  };

  try {
    const model = resolveProfile(host.launch.config, role.launch_profile_ref)
      .profile.model;
    if (model === undefined)
      throw new Error(`Launch profile ${role.launch_profile_ref} has no model`);
    const compiled = compileAssignmentLaunch({
      assignment: {
        assignment_id: assignment.id,
        run_id: input.run.id,
        project_id: project,
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
      launch: host.launch.config,
      mcp: { url: host.mcpUrl },
      run_dir: runDir,
      work_dir: workDir,
      // The merged bell is the first prompt (M3 §3.2).
      first_prompt:
        input.bell ||
        firstPrompt({
          assignment_id: assignment.id,
          run_id: input.run.id,
          ...(card === undefined ? {} : { card_id: card.id }),
          ...(workItem === undefined ? {} : { work_item_id: workItem.id }),
        }),
      secrets: host.launch.secrets,
    });
    await clearAgentSentinel(execution, project, assignment.id);
    if (execution.mode === "agent-ssh")
      await writeAgentLaunch(
        execution,
        project,
        assignment.id,
        compiled.files,
        issued.token,
      );
    else {
      for (const file of compiled.files) {
        await mkdir(dirname(file.path), { recursive: true, mode: 0o700 });
        await writeFile(file.path, file.content, { mode: file.mode });
      }
      await writeFile(compiled.token_file, `${issued.token}\n`, {
        mode: 0o600,
      });
    }

    const launchDesc: RuntimeLaunch = {
      command: compiled.launch_script,
      args: [],
      cwd: workDir,
      agent_name: agentName({
        role_id: role.role_id,
        project,
        card: card?.id,
        item: workItem?.id,
        assignment: assignment.id,
      }),
      labels: {
        cardigan: "1",
        project,
        assignment: assignment.id,
        run: input.run.id,
      },
    };
    const provisioned = await runtime.provision(
      assignment,
      role,
      machineRecord(),
      launchDesc,
    );
    if (!provisioned.ok)
      throw new Error(`provision failed: ${provisioned.error.code}`);
    ref = provisioned.value;

    const dispatched = ref;
    store.uow.run((tx) =>
      persistEffect(
        tx,
        project,
        unwrap(
          dispatchRun(
            loadCommandState(tx, project),
            hostActor(project),
            {
              run_id: input.run.id,
              runtime_ref: dispatched,
              ...(assignment.base_sha === undefined
                ? {}
                : { base_sha: assignment.base_sha }),
            },
            { clock, ids: tx.ids },
          ),
        ),
      ),
    );
    // Only now may the wrapper start the Agent (see START_FILE_NAME).
    await writeAgentSentinel(execution, project, assignment.id);
  } catch (error) {
    if (ref) await runtime.release(ref, { force: true });
    await scrub();
    store.revokeToken(tokenId);
    try {
      abort("host start failed");
    } catch {
      // The Run may already be gone; the Dispatcher reports the failure.
    }
    throw error;
  }
}

export type { CommandState };
