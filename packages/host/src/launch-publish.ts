import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  type Assignment,
  type Clock,
  type ProjectId,
  type Run,
  type Runtime,
  type RuntimeLaunch,
  type RuntimeLaunchRecovery,
  recordLaunchPublication,
} from "@cardigan/domain";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import {
  type ExecutionConfig,
  type LaunchFile,
  type WorkerFileIdentity,
  workerFileRequest,
  workerFiles,
  workerLaunchPath,
  workerPublishLimits,
} from "@cardigan/runtime-herdr";
import { type Store, unfinishedBellAttempts } from "@cardigan/store";
import { wallClock } from "./commands.js";
import { type LaunchStep, messageOf } from "./errors.js";
import { safeCheckDiagnostic } from "./merge-gate-log.js";
import { deferTargetAttempt, refreshTargetWait } from "./run-target.js";
import { RuntimeTargets } from "./runtime-targets.js";
import { stopRunRuntime } from "./stop-run.js";
import { redactSecrets } from "./wake-preparation.js";

/** One bounded host diagnostic for the journal and the dispatcher's failure log. */
export function launchFailureReason(
  step: LaunchStep,
  error: unknown,
  secrets: Readonly<Record<string, string>>,
  token?: string,
): string {
  try {
    const stderr =
      error && typeof error === "object" && "stderr" in error
        ? error.stderr
        : undefined;
    // execFile includes argv in its message, sometimes behind a runtime prefix.
    let text = stripVTControlCharacters(
      typeof stderr === "string" && stderr.trim() ? stderr : messageOf(error),
    ).replace(
      /\bCommand failed:[^\r\n]*/iu,
      "command failed (arguments omitted)",
    );
    if (token) text = text.replaceAll(token, "***");
    for (const value of Object.values(secrets)
      .filter(Boolean)
      .sort((a, b) => b.length - a.length))
      text = text.replaceAll(value, "***");
    const diagnostic = safeCheckDiagnostic(
      redactSecrets(text),
      secrets,
    ).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ");
    return `${step}: ${diagnostic}`.slice(0, 300);
  } catch {
    // Diagnostic formatting must never prevent credential revocation and stop.
    return `${step}: diagnostic unavailable`;
  }
}

type Publication = NonNullable<Run["launch_publication"]>;
interface PublicationHost {
  readonly store: Store;
  readonly runtime: Runtime & Partial<RuntimeLaunchRecovery>;
  readonly execution?: ExecutionConfig | undefined;
  readonly clock?: Clock | undefined;
}
/** All IO stays on the configured worker; this object never opens a worker path on the host. */
export class LaunchPublication {
  readonly identity: WorkerFileIdentity;
  readonly runDir: string;
  readonly sessionDir: string;
  readonly clock: Clock;
  recoveryOperation = "journal";
  constructor(
    readonly host: PublicationHost,
    readonly execution: Extract<ExecutionConfig, { mode: "agent-ssh" }>,
    readonly project: ProjectId,
    readonly assignment: Assignment,
    readonly run: Run,
    readonly generation: string,
  ) {
    this.clock = host.clock ?? wallClock;
    this.identity = {
      project,
      assignment: assignment.id,
      run: run.id,
      generation,
      target: execution.target?.fingerprint ?? "",
    };
    this.runDir = workerLaunchPath(execution, this.identity).value;
    this.sessionDir = posix.join(
      execution.agentRoot,
      "runs",
      project,
      assignment.id,
      "sessions",
      generation,
    );
    workerPublishLimits(execution.publication);
    if (!execution.fileHelper)
      throw new Error("Worker file helper is not configured");
  }
  static begin(
    host: PublicationHost,
    execution: Extract<ExecutionConfig, { mode: "agent-ssh" }>,
    project: ProjectId,
    assignment: Assignment,
    run: Run,
    agentName: string,
    workDir: string,
  ) {
    const publication = new LaunchPublication(
      host,
      execution,
      project,
      assignment,
      run,
      randomUUID().replaceAll("-", ""),
    );
    const attempt = unfinishedBellAttempts(host.store.database, project).find(
      (a) => a.run_id === run.id,
    );
    if (
      !attempt ||
      attempt.lease_until <= publication.clock.now() ||
      !execution.target
    )
      throw new Error(
        "Worker launch requires a current durable delivery intent",
      );
    publication.save(
      {
        generation: publication.generation,
        target: execution.target,
        phase: "preparing",
        lease_until: attempt.lease_until,
        agent_name: agentName,
        work_dir: workDir,
        sha: assignment.base_sha ?? null,
        token_id: null,
        runtime_ref: null,
        process: null,
        log_offset: 0,
        artifacts: [],
        wait: false,
        provision_attempted: false,
      },
      true,
    );
    return publication;
  }
  current(): Publication {
    const value = this.host.store.uow.read(
      (tx) => tx.runs.get(this.project, this.run.id)?.launch_publication,
    );
    if (!value || value.generation !== this.generation)
      throw new Error("Launch generation changed");
    return value;
  }
  private save(value: Publication, fresh = false) {
    return this.host.store.uow.run((tx) => {
      const old = tx.runs.get(this.project, this.run.id)?.launch_publication;
      if (
        (!fresh && old?.generation !== this.generation) ||
        (fresh && old && old.phase !== "exited")
      )
        throw new Error("Launch generation is already in progress");
      const effect = unwrap(
        recordLaunchPublication(
          loadCommandState(tx, this.project),
          { kind: "system", project_id: this.project },
          {
            run_id: this.run.id,
            publication: value,
            ...(old ? { expected_generation: old.generation } : {}),
          },
          { clock: this.clock, ids: tx.ids },
        ),
      );
      if (value.phase === "stopping")
        for (const token of tx.tokensForAssignment(
          this.project,
          this.assignment.id,
        ))
          if (
            token.revoked_at === null &&
            (value.token_id === null || token.id === value.token_id) &&
            !tx.revokeToken(token.id)
          )
            throw new Error("Launch identity revocation failed");
      persistEffect(tx, this.project, effect);
      return value;
    });
  }
  update(phase: Publication["phase"], patch: Partial<Publication> = {}) {
    return this.save({ ...this.current(), ...patch, phase });
  }
  assertCurrent() {
    if (this.host.runtime instanceof RuntimeTargets)
      this.host.runtime.assertLaunchAllowed(this.project, this.assignment);
    const current = this.current();
    const assignment = this.host.store.uow.read((tx) =>
      tx.assignments.get(this.project, this.assignment.id),
    );
    const machine = this.host.store.uow.read((tx) =>
      tx.machines.get(this.project, this.assignment.machine_id),
    );
    const target =
      this.host.runtime instanceof RuntimeTargets
        ? this.host.runtime.resolve(this.project, this.assignment.machine_id)
            .execution.target
        : this.execution.target;
    if (
      current.lease_until <= this.clock.now() ||
      assignment?.status !== "active" ||
      !machine ||
      !["online", "degraded"].includes(machine.status) ||
      JSON.stringify(target) !== JSON.stringify(current.target)
    )
      throw new Error("Launch target or delivery lease changed");
  }
  wrapper() {
    const packet = workerFileRequest(this.execution, this.identity, "status");
    return {
      session_dir: this.sessionDir,
      command: [
        this.execution.fileHelper?.python ?? "",
        "-I",
        "-B",
        this.execution.fileHelper?.path ?? "",
        JSON.stringify(workerPublishLimits(this.execution.publication)),
        "run",
        packet.subarray(0, packet.indexOf(10)).toString(),
      ],
    };
  }
  async worktree(path: string) {
    return (
      await workerFiles(this.execution, this.identity, "inspect", [], path)
    ).worktree;
  }
  async publish(files: readonly LaunchFile[], token: string) {
    // Compilation can await worker inspection after MCP preflight. Fence the
    // credential publication itself against changes during either operation.
    this.assertCurrent();
    await workerFiles(this.execution, this.identity, "publish", [
      ...files,
      {
        path: posix.join(this.runDir, "token"),
        content: `${token}\n`,
        mode: 0o600,
      },
    ]);
    this.update("published", {
      artifacts: files
        .filter(
          (file) =>
            !["token", "secrets.env"].includes(posix.basename(file.path)),
        )
        .map((file) => ({
          evidence_name: posix.relative(this.runDir, file.path),
          size: Buffer.byteLength(file.content),
          sha256: createHash("sha256").update(file.content).digest("hex"),
        })),
    });
  }
  async observeProcess() {
    const observed = await workerFiles(this.execution, this.identity, "status");
    this.update("provisioned", { process: observed.process });
  }
  description(): RuntimeLaunch {
    const value = this.current();
    return {
      command: posix.join(this.runDir, "launch.sh"),
      args: [],
      cwd: value.work_dir,
      agent_name: value.agent_name,
      labels: {
        cardigan: "1",
        project: this.project,
        assignment: this.assignment.id,
        run: this.run.id,
        generation: this.generation,
      },
    };
  }
  async commit() {
    this.assertCurrent();
    await workerFiles(this.execution, this.identity, "commit");
    this.update("started");
  }
  /** Revocation and durable reservation precede every worker call or terminal stop. */
  async stop(wait = false, failureReason?: string): Promise<boolean> {
    this.recoveryOperation = "revoke_identity";
    let current = this.update("stopping", {
      wait,
      ...(failureReason ? { failure_reason: failureReason } : {}),
    });
    this.recoveryOperation = "worker_clear";
    const cleared = await workerFiles(this.execution, this.identity, "clear");
    this.recoveryOperation = "journal";
    current = this.update("stopping", { process: cleared.process });
    let ref = current.runtime_ref;
    if (!ref && current.provision_attempted && this.host.runtime.find_launch) {
      this.recoveryOperation = "locate_process";
      const located = await this.host.runtime.find_launch(
        this.assignment,
        this.description(),
      );
      if (located.ok) {
        ref = located.value;
        current = this.update("stopping", { runtime_ref: ref });
      }
    }
    this.recoveryOperation = "stop_process";
    const exited =
      !current.provision_attempted ||
      (ref
        ? (await stopRunRuntime(
            this.host.runtime,
            ref,
            () => this.current().phase === "stopping",
          )) === "exited"
        : false);
    if (!exited) return false;
    this.recoveryOperation = "worker_clear";
    await workerFiles(this.execution, this.identity, "clear");
    this.recoveryOperation = "journal";
    this.update("exited");
    return true;
  }
}

/** Recovery resumes exact-generation compensation, never replays provisioning or start. */
export async function recoverLaunchPublications(
  host: PublicationHost,
  project: ProjectId,
) {
  const clock = host.clock ?? wallClock;
  const failures: Error[] = [];
  const liveAttempts = new Set(
    unfinishedBellAttempts(host.store.database, project)
      .filter((attempt) => attempt.lease_until > clock.now())
      .map((attempt) => attempt.run_id),
  );
  for (const run of host.store.uow.read((tx) => tx.runs.list(project))) {
    const value = run.launch_publication;
    const retiredStart =
      value?.phase === "started" &&
      run.status === "cancelled" &&
      value.runtime_ref !== null;
    if (
      !value ||
      (["started", "exited"].includes(value.phase) && !retiredStart) ||
      (value.lease_until > clock.now() &&
        !retiredStart &&
        (value.phase !== "stopping" || liveAttempts.has(run.id)))
    )
      continue;
    const assignment = host.store.uow.read((tx) =>
      tx.assignments.get(project, run.assignment_id),
    );
    let operation = "resolve_target";
    let publication: LaunchPublication | undefined;
    const report = (reason: string) => {
      failures.push(
        new Error(
          JSON.stringify({
            project_id: project,
            run_id: run.id,
            generation: value.generation,
            operation: publication?.recoveryOperation ?? operation,
            reason,
          }),
        ),
      );
    };
    if (!assignment) {
      report("assignment_missing");
      continue;
    }
    try {
      const execution =
        host.runtime instanceof RuntimeTargets
          ? host.runtime.resolve(project, assignment.machine_id).execution
          : host.execution;
      if (
        execution?.mode !== "agent-ssh" ||
        JSON.stringify(execution.target) !== JSON.stringify(value.target)
      ) {
        report("target_mismatch");
        continue;
      }
      if (retiredStart && value.runtime_ref) {
        operation = "observe_process";
        const observed = await host.runtime.status(value.runtime_ref);
        if (
          observed.ok
            ? observed.value.process !== "exited"
            : observed.error.code !== "runtime_not_found"
        )
          continue;
      }
      operation = "refresh_target";
      const wait =
        value.wait || refreshTargetWait(host.store, project, run.id, clock);
      operation = "configuration";
      publication = new LaunchPublication(
        host,
        execution,
        project,
        assignment,
        run,
        value.generation,
      );
      const settled = await publication.stop(wait);
      if (!settled) report("exit_unconfirmed");
      if (wait && settled)
        for (const attempt of unfinishedBellAttempts(
          host.store.database,
          project,
        ))
          if (attempt.run_id === run.id)
            deferTargetAttempt(host.store, attempt, clock);
    } catch {
      // Never include exception messages, SSH output, paths or credentials.
      report("operation_failed");
    }
  }
  if (failures.length)
    throw new AggregateError(
      failures,
      `Launch recovery incomplete: ${failures.map((e) => e.message).join("; ")}`,
    );
}
