import { isDeepStrictEqual } from "node:util";
import type {
  Assignment,
  Clock,
  Precheck,
  PrecheckRecoveryRequest,
  ProjectId,
} from "@cardigan/domain";
import {
  pendingPrecheckRecovery,
  prechecks,
  recordPrecheck,
  validPrecheckSummary,
} from "@cardigan/domain";
import type { CentralProject } from "@cardigan/git-service";
import {
  centralBranch,
  PrecheckMergeConflict,
  RepositoryLockTimeoutError,
} from "@cardigan/git-service";
import {
  acquireMergeCheckCapacity,
  boundedCheckSummary,
  type CheckExecutor,
  CheckExecutorSuspended,
  type CheckRecovery,
  checkStepFingerprint,
  createMergeCheckLog,
  DeploymentInProgress,
  type ExternalGithubRun,
  executorExecution,
  GITHUB_POLL_DEFAULTS,
  type GithubDispatchIntent,
  GithubDispatchJournal,
  GithubRetryLater,
  type GithubRun,
  type MergeGateConfiguration,
  mergeCheckAttemptRunning,
  type ProjectMergeGate,
  runCheckExecutor,
  SshCheckExecutor,
  safeCheckDiagnostic,
} from "@cardigan/host";
import { loadCommandState, persistEffect } from "@cardigan/mcp-server";
import type { ExecutionConfig } from "@cardigan/runtime-herdr";
import {
  CheckAdmissionClosed,
  CheckHandoffs,
  type ReadRepositories,
  type Store,
} from "@cardigan/store";
import { recordCheckFlakes } from "./check-flake-ledger.js";

type Settings = Extract<ProjectMergeGate, { status: "enabled" }>;
type StoreTx = Parameters<Parameters<Store["uow"]["run"]>[0]>[0];
/** C-773: bound for the one read-only GitHub lookup of a stale or abandoned check. */
const INSPECT_TIMEOUT_MS = 60_000;
/** C-773: a HEAD lock busy this long is not a transient wait any more. */
export const DEFAULT_HEAD_LOCK_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 2_000;
/** C-773: failures in these stages happen before any executor is called. */
const PRE_EXECUTION_STAGES = new Set(["读取分支HEAD", "准备候选", "创建日志"]);
const RECOVERY_TEXT = { reinspect: "重新核对", abandon: "放弃" } as const;
const HANDLED_TEXT = {
  reattach: "重新接上已绑定的 GitHub 运行核对结果",
  active: "检查正在本主机执行，继续等待远端结果",
  unbound: "尚未绑定 GitHub 运行，按原排队继续",
  abandoned: "已按放弃收尾",
} as const;
/**
 * C-773: a precheck can legitimately wait up to the queue wait (the GitHub
 * queue, or a slot behind merge checks) and then run up to the total
 * timeout. One more total timeout is slack.
 */
export function defaultPrecheckStaleAfterMs(settings: Settings): number {
  const executor = settings.executor;
  const queue =
    (executor?.type === "github" ? executor.queueWaitMs : undefined) ??
    GITHUB_POLL_DEFAULTS.queueWaitMs;
  return queue + 2 * settings.totalTimeoutMs;
}
/** GitHub's status words only; anything else is not echoed into a summary. */
const word = (value: unknown) =>
  typeof value === "string" && /^[a-z_]{1,32}$/u.test(value)
    ? value
    : undefined;
function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("GitHub lookup timed out")),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}
/** An explicit rejection of the check evidence, not a failure to persist it. */
class PrecheckVerificationFailure extends Error {}

type Candidate = { candidate_sha: string; tree_sha: string; base_sha: string };
export interface AuthorCheckGit {
  projectOf(project: ProjectId): CentralProject | undefined;
  checkHead(project: ProjectId, assignment: Assignment): Promise<string>;
  preparePrecheck(
    project: CentralProject,
    assignment: string,
    head: string,
    attempt: string,
  ): Promise<Candidate>;
  distribute(
    project: CentralProject,
    execution?: ExecutionConfig,
  ): Promise<void>;
}
/** Independent author queue; the owner supplies the same target slots/providers as merge checks. */
export class AuthorPrechecks {
  private readonly pendingFailures = new Set<string>();
  private readonly retry = new Map<string, number>();
  private readonly active = new Map<string, Promise<void>>();
  constructor(
    private readonly options: {
      store: Store;
      clock: Clock;
      execution: ExecutionConfig;
      configuration: MergeGateConfiguration;
      git: Partial<AuthorCheckGit>;
      signal: AbortSignal;
      onError(error: unknown): void;
      reserve(
        settings: Settings,
      ): Promise<{ index: number; release(): void } | undefined>;
      github(
        check: Precheck,
        project: CentralProject,
        settings: Settings,
        bind: (run: NonNullable<Precheck["external_run"]>) => void,
      ): CheckExecutor;
      executor?: CheckExecutor;
      run?: ConstructorParameters<typeof SshCheckExecutor>[0]["run"];
      recovery: CheckRecovery;
      createLog?: typeof createMergeCheckLog;
      /** C-773: one read-only lookup of a bound run; never dispatches or cancels. */
      inspect?(run: ExternalGithubRun, settings: Settings): Promise<GithubRun>;
      /** C-773: how long a queued or running precheck may stay unsettled. */
      staleAfterMs?(settings: Settings): number;
      /** C-773: how long consecutive HEAD-lock timeouts may last. */
      headLockTimeoutMs?: number;
      /** C-773: how long a pre-execution failure waits for a shutdown signal. */
      shutdownGraceMs?: number;
    },
  ) {}
  /** C-773: stale or abandoned attempts being settled from a GitHub lookup. */
  private readonly expiring = new Map<string, Promise<void>>();
  /** C-773: bound attempts this process has already announced re-attaching. */
  private readonly reattached = new Set<string>();
  private readonly since = new Map<
    string,
    { queued?: number; started?: number }
  >();
  /** C-773: when this attempt's current run of HEAD-lock timeouts began. */
  private readonly headLockSince = new Map<string, number>();
  /**
   * C-773: the limit, once this attempt's consecutive HEAD-lock timeouts have
   * lasted that long; a successful read resets the run.
   */
  private headLockExpired(check: Precheck): number | undefined {
    const now = Date.parse(this.options.clock.now());
    const first = this.headLockSince.get(check.attempt_id);
    if (first === undefined) this.headLockSince.set(check.attempt_id, now);
    const limit =
      this.options.headLockTimeoutMs ?? DEFAULT_HEAD_LOCK_TIMEOUT_MS;
    return now - (first ?? now) >= limit ? limit : undefined;
  }
  /**
   * C-773: whether this host is shutting down. A SIGTERM can kill a Git child
   * just before the controller's abort signal fires, so a pre-execution
   * failure waits briefly for that signal before it becomes a terminal.
   */
  private async shuttingDown(): Promise<boolean> {
    const { signal } = this.options;
    const ms = this.options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
    if (!signal.aborted && ms > 0)
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, ms);
        signal.addEventListener("abort", done, { once: true });
      });
    return signal.aborted;
  }
  owns(attempt: string) {
    return this.active.has(attempt);
  }
  async idle() {
    await Promise.all([...this.active.values(), ...this.expiring.values()]);
  }
  private reportFailure(
    stage: string,
    error: unknown,
    env: Readonly<Record<string, string>>,
  ): string {
    const projected = boundedCheckSummary(
      `预检查环境故障（${stage}）：${safeCheckDiagnostic(error, env)}`,
    );
    const summary = validPrecheckSummary(projected)
      ? projected
      : "预检查环境故障（诊断内容已省略）";
    const safeError = new Error(summary);
    safeError.stack = summary;
    try {
      this.options.onError(safeError);
    } catch {
      /* Reporting cannot prevent the terminal record or capacity release. */
    }
    return summary;
  }
  private state(project: ProjectId) {
    return this.options.store.uow.read((tx) => loadCommandState(tx, project));
  }
  private proof(project: ProjectId, check: Precheck): Precheck | undefined {
    const row = this.options.store.database
      .prepare(`SELECT result FROM precheck_head_proofs
      WHERE project_id=? AND card_id=? AND attempt_id=?`)
      .get(project, check.card_id, check.attempt_id);
    return row ? (JSON.parse(String(row.result)) as Precheck) : undefined;
  }
  /** The indexed projection is updated by the same transaction as its system event. */
  private current(project: ProjectId, check: Precheck): Precheck | undefined {
    const row = this.options.store.database
      .prepare(`SELECT doc FROM check_recovery_attempts
      WHERE project_id=? AND card_id=? AND attempt_id=?`)
      .get(project, check.card_id, check.attempt_id);
    return row ? (JSON.parse(String(row.doc)) as Precheck) : undefined;
  }
  private async verify(project: ProjectId, result: Precheck) {
    const owner = this.owner(project, result);
    let same = false;
    if (owner) {
      if (!this.options.git.checkHead)
        throw new PrecheckVerificationFailure("No trusted Git adapter");
      try {
        same =
          (await this.options.git.checkHead(project, owner)) ===
          result.head_sha;
      } catch (error) {
        // Another tick (or controller after restart) retries only the proof,
        // until the lock has stayed busy past its limit (C-773).
        if (error instanceof RepositoryLockTimeoutError) {
          const limit = this.headLockExpired(result);
          if (limit !== undefined) {
            this.headLockSince.delete(result.attempt_id);
            this.update(
              project,
              {
                ...result,
                status: "interrupted",
                summary: `核对分支HEAD时主机仓库锁持续被占用超过 ${Math.ceil(limit / 60_000)} 分钟，按超时结束；检查结果未能核验，不作为通过依据，请重新 request_check`,
              },
              true,
            );
          }
          return;
        }
        throw new PrecheckVerificationFailure("Could not verify branch HEAD", {
          cause: error,
        });
      }
      this.headLockSince.delete(result.attempt_id);
    }
    this.update(
      project,
      same
        ? result
        : {
            ...result,
            status: "interrupted",
            summary: "分支HEAD或负责人已变化，原结果不再有效",
          },
      true,
    );
  }
  private update(
    project: ProjectId,
    check: Precheck,
    verifyOwner = false,
    after?: (tx: StoreTx) => void,
  ) {
    this.options.store.uow.run((tx) => {
      // A stale queue observer cannot interrupt/requeue a completed execution;
      // concurrent proof readers cannot publish a second terminal result.
      if (verifyOwner !== !!this.proof(project, check)) {
        if (["queued", "running"].includes(check.status))
          throw new CheckExecutorSuspended();
        return;
      }
      if (verifyOwner && !this.ownerIn(tx, project, check))
        check = {
          ...check,
          status: "interrupted",
          summary: "分支HEAD或负责人已变化，原结果不再有效",
        };
      const effect = recordPrecheck(
        loadCommandState(tx, project),
        { kind: "system", project_id: project },
        check,
        { ids: tx.ids, clock: this.options.clock },
      );
      if (!effect.ok)
        throw new PrecheckVerificationFailure(
          `Precheck record: ${effect.error.code}`,
        );
      persistEffect(tx, project, effect.value);
      after?.(tx);
      if (!["queued", "running"].includes(check.status))
        this.options.store.database
          .prepare(`DELETE FROM precheck_head_proofs
          WHERE project_id=? AND card_id=? AND attempt_id=?`)
          .run(project, check.card_id, check.attempt_id);
    });
    // A terminal pre-dispatch failure has no remote run or unsettled publisher.
    if (
      check.executor?.type === "github" &&
      !["queued", "running"].includes(check.status)
    )
      new GithubDispatchJournal(this.options.store).reconcile([project], (id) =>
        this.options.configuration.forProject(id),
      );
  }
  private reportFixed(summary: string): void {
    const safeError = new Error(summary);
    safeError.stack = summary;
    try {
      this.options.onError(safeError);
    } catch {
      /* A broken reporter cannot resume execution. */
    }
  }
  /** Preserve a durable settlement intent before a terminal fallback can fail. */
  private settleFailure(project: ProjectId, check: Precheck): void {
    this.pendingFailures.add(check.attempt_id);
    // Reads may fail independently of writes; fence restart before reading state.
    try {
      this.options.store.uow.run((tx) => {
        const exists = tx.events
          .listAfter(project, check.card_id, 0)
          .some(
            (e) =>
              e.type === "precheck_settlement_pending" &&
              e.actor.kind === "system" &&
              (e.payload as { attempt_id?: string })?.attempt_id ===
                check.attempt_id,
          );
        if (!exists)
          tx.events.append(project, {
            id: tx.ids.nextEventId(),
            seq: tx.ids.nextEventSequence(project, check.card_id),
            card_id: check.card_id,
            type: "precheck_settlement_pending",
            actor: { kind: "system", project_id: project },
            payload: { attempt_id: check.attempt_id },
            created_at: this.options.clock.now(),
          });
      });
    } catch {
      this.reportFixed(
        "作者预检查终态保存意图暂时无法写入，保留收尾隔离，禁止重新执行检查",
      );
    }
    let fallback: Precheck;
    try {
      const persisted = prechecks(this.state(project).events).find(
        (c) => c.attempt_id === check.attempt_id,
      );
      if (!persisted || !["queued", "running"].includes(persisted.status)) {
        this.pendingFailures.delete(check.attempt_id);
        return;
      }
      fallback = {
        ...persisted,
        status: this.owner(project, persisted)
          ? "environment_failed"
          : "interrupted",
        summary:
          "预检查环境故障，诊断摘要无法保存；改用固定安全摘要，检查不会自动重新执行，请重新请求预检查",
      };
    } catch {
      this.reportFixed(
        "作者预检查收尾状态暂不可读，保留收尾隔离，禁止重新执行检查",
      );
      return;
    }
    try {
      this.update(project, fallback);
      this.pendingFailures.delete(check.attempt_id);
    } catch {
      this.reportFixed(
        "作者预检查固定终态保存失败，后续仅补记终态，不重新执行检查",
      );
    }
  }
  private finishFailure(project: ProjectId, check: Precheck): void {
    this.pendingFailures.add(check.attempt_id);
    try {
      this.update(project, {
        ...check,
        status: this.owner(project, check)
          ? "environment_failed"
          : "interrupted",
      });
      this.pendingFailures.delete(check.attempt_id);
    } catch {
      this.reportFixed(
        "作者预检查终态投影被拒或无法保存，改用固定安全摘要收尾",
      );
      this.settleFailure(project, check);
    }
  }
  private owner(project: ProjectId, check: Precheck) {
    return this.options.store.uow.read((tx) =>
      this.ownerIn(tx, project, check),
    );
  }
  private ownerIn(tx: ReadRepositories, project: ProjectId, check: Precheck) {
    const a = tx.assignments.get(project, check.assignment_id),
      item = tx.work_items.get(project, check.work_item_id),
      card = tx.cards.get(project, check.card_id);
    return a?.status === "active" &&
      a.scope === "work_item" &&
      a.work_item_id === item?.id &&
      item.assignment_id === a.id &&
      item.card_id === check.card_id &&
      item.status !== "cancelled" &&
      a.branch === check.branch &&
      a.machine_id === check.machine_id &&
      card &&
      !["done", "cancelled"].includes(card.status)
      ? a
      : undefined;
  }
  private held(project: ProjectId, check: Precheck) {
    if (check.status === "running" || check.external_run) return false;
    if (
      !this.options.store.uow.read(
        (tx) => tx.cards.get(project, check.card_id)?.hold,
      )
    )
      return false;
    return !new GithubDispatchJournal(this.options.store)
      .unfinished()
      .some(
        (i) =>
          i.project === project &&
          i.attempt === check.attempt_id &&
          i.phase === "dispatching",
      );
  }
  async schedule(projects: readonly ProjectId[]) {
    const started: Promise<void>[] = [];
    for (const project of projects) {
      const { events } = this.state(project);
      for (const check of prechecks(events)) {
        if (!["queued", "running"].includes(check.status)) {
          // A retry deadline is useful only while the attempt can run again.
          // Drop settled attempts, including ones settled by another process.
          this.retry.delete(check.attempt_id);
          this.reattached.delete(check.attempt_id);
          this.since.delete(check.attempt_id);
          this.headLockSince.delete(check.attempt_id);
          continue;
        }
        if (this.options.signal.aborted || this.expiring.has(check.attempt_id))
          continue;
        const active = this.active.has(check.attempt_id);
        if (
          !active &&
          (this.pendingFailures.has(check.attempt_id) ||
            this.options.store.uow.read(() =>
              this.options.store.database
                .prepare(`SELECT 1 FROM events
              WHERE project_id=? AND type='precheck_settlement_pending'
              AND json_extract(doc,'$.actor.kind')='system'
              AND json_extract(doc,'$.payload.attempt_id')=? LIMIT 1`)
                .get(project, check.attempt_id),
            ))
        ) {
          this.settleFailure(project, check);
          continue;
        }
        if (
          new CheckHandoffs(
            this.options.store,
            "precheck-observer",
          ).blockedProject(project)
        )
          continue;
        let expiring: Promise<void> | undefined;
        try {
          expiring = this.recover(project, events, check, active);
        } catch {
          this.options.onError(
            new Error("作者预检查恢复请求处理失败，下轮重试"),
          );
          continue;
        }
        if (expiring) {
          started.push(expiring);
          continue;
        }
        if (active) continue;

        const work = this.execute(project, check)
          .catch(() => {
            this.options.onError(new Error("作者预检查收尾失败，保留当前记录"));
          })
          .finally(() => this.active.delete(check.attempt_id));
        this.active.set(check.attempt_id, work);
        started.push(work);
      }
    }
    return { done: Promise.all(started).then(() => {}) };
  }
  /**
   * C-773: the journal intent bound to this attempt's GitHub run. A finished
   * intent still counts: the poller may have confirmed the remote terminal
   * just before a restart lost the precheck's own result.
   */
  private boundIntent(
    project: ProjectId,
    check: Precheck,
    executor: string,
  ): GithubDispatchIntent | undefined {
    return new GithubDispatchJournal(this.options.store)
      .all()
      .find(
        (i) =>
          i.project === project &&
          i.card === check.card_id &&
          i.attempt === check.attempt_id &&
          i.executor === executor &&
          i.phase === "dispatching" &&
          !!i.externalRun &&
          !i.abandoned &&
          !i.deleting,
      );
  }
  /**
   * C-773: an attempt whose GitHub run is already bound needs no new
   * admission. Re-attaching only re-reads that run through the trusted
   * poller; the executor's start never reaches its POST for a bound intent.
   */
  private reattachable(
    project: ProjectId,
    check: Precheck,
    executor: string,
  ): GithubDispatchIntent | undefined {
    if (
      !check.candidate_sha ||
      !check.tree_sha ||
      !check.base_sha ||
      check.executor?.type !== "github" ||
      check.executor.name !== executor
    )
      return undefined;
    const intent = this.boundIntent(project, check, executor);
    const run = intent?.externalRun;
    if (
      !intent ||
      !run ||
      (intent.candidate && intent.candidate.sha !== check.candidate_sha) ||
      (check.external_run &&
        (check.external_run.run_id !== run.run_id ||
          check.external_run.html_url !== run.html_url))
    )
      return undefined;
    return intent;
  }
  /**
   * C-773: when this attempt last made trusted progress: when it started
   * running on the host clock, or else when it was queued. Both events are
   * append-only, so a seen value never moves.
   */
  private unsettledSince(
    project: ProjectId,
    check: Precheck,
  ): number | undefined {
    const known = this.since.get(check.attempt_id);
    if (known?.started !== undefined) return known.started;
    if (check.status === "queued" && known?.queued !== undefined)
      return known.queued;
    const at = (type: string) =>
      Date.parse(
        this.options.store.uow
          .read((tx) => tx.events.listAfter(project, check.card_id, 0))
          .find(
            (e) =>
              e.type === type &&
              e.actor.kind === "system" &&
              (e.payload as { attempt_id?: unknown } | null)?.attempt_id ===
                check.attempt_id,
          )?.created_at ?? "",
      );
    const started = at("precheck_started");
    const queued = known?.queued ?? at("precheck_queued");
    this.since.set(check.attempt_id, {
      ...(Number.isFinite(started) ? { started } : {}),
      ...(Number.isFinite(queued) ? { queued } : {}),
    });
    if (Number.isFinite(started)) return started;
    return Number.isFinite(queued) ? queued : undefined;
  }
  /**
   * C-773: host_ops requests and the stale fallback. Returns the settlement
   * work when this pass ends the attempt instead of running it;
   * reinspection only clears local waits and continues below.
   */
  private recover(
    project: ProjectId,
    events: Parameters<typeof prechecks>[0],
    check: Precheck,
    active: boolean,
  ): Promise<void> | undefined {
    const settings = this.options.configuration.forProject(project);
    if (settings.status !== "enabled") return undefined;
    const github =
      settings.executor?.type === "github" ? settings.executor.name : undefined;
    const request = github
      ? pendingPrecheckRecovery(events, check.card_id, check.attempt_id)
      : undefined;
    if (github && request?.action === "reinspect") {
      this.retry.delete(check.attempt_id);
      this.reattached.delete(check.attempt_id);
      this.headLockSince.delete(check.attempt_id);
      const outcome = active
        ? "active"
        : this.reattachable(project, check, github)
          ? "reattach"
          : "unbound";
      this.options.store.uow.run((tx) =>
        this.handled(tx, project, check, request, outcome),
      );
      return undefined;
    }
    let limit: number | undefined;
    if (request?.action !== "abandon") {
      // Queued or running, bound or not: nothing may stay unsettled forever.
      const since = this.unsettledSince(project, check);
      limit =
        this.options.staleAfterMs?.(settings) ??
        defaultPrecheckStaleAfterMs(settings);
      if (
        since === undefined ||
        Date.parse(this.options.clock.now()) - since < limit
      )
        return undefined;
    }
    const work = this.expire(
      project,
      check,
      settings,
      request?.action === "abandon" ? { request } : { limit: limit ?? 0 },
    )
      .catch(() => {
        this.options.onError(
          new Error("作者预检查超时或放弃收尾失败，下轮重试"),
        );
      })
      .finally(() => this.expiring.delete(check.attempt_id));
    this.expiring.set(check.attempt_id, work);
    return work;
  }
  private handled(
    tx: StoreTx,
    project: ProjectId,
    check: Precheck,
    request: PrecheckRecoveryRequest,
    outcome: keyof typeof HANDLED_TEXT,
  ): void {
    const seq = tx.ids.nextEventSequence(project, check.card_id),
      at = this.options.clock.now();
    tx.events.append(project, {
      id: tx.ids.nextEventId(),
      seq,
      card_id: check.card_id,
      type: "precheck_recovery_handled",
      actor: { kind: "system", project_id: project },
      payload: {
        attempt_id: check.attempt_id,
        request_id: request.request_id,
        action: request.action,
        outcome,
      },
      created_at: at,
    });
    const id = tx.ids.nextTimelineEntryId(project, check.card_id);
    tx.timeline.put(project, {
      id,
      short_id: id,
      card_id: check.card_id,
      event_seq: seq,
      type: "system",
      author: "system",
      refs: [],
      mentions: [],
      retracted: false,
      created_at: at,
      body: `作者预检查 ${check.attempt_id}：已处理主机运维的${RECOVERY_TEXT[request.action]}请求，${HANDLED_TEXT[outcome]}`,
    });
  }
  /** One read-only GitHub lookup; the summary states what it could verify. */
  private async observeRun(
    run: ExternalGithubRun | undefined,
    intent: GithubDispatchIntent | undefined,
    settings: Settings,
  ): Promise<string> {
    if (!run) return "未核实：本次预检查没有绑定的 GitHub 运行";
    if (!this.options.inspect) return "未核实：主机没有可用的 GitHub 只读查询";
    let observed: GithubRun;
    try {
      observed = await within(
        this.options.inspect(run, settings),
        INSPECT_TIMEOUT_MS,
      );
    } catch {
      return "未核实：读取 GitHub 运行状态失败";
    }
    if (
      observed.id !== run.run_id ||
      observed.html_url !== run.html_url ||
      (intent?.identity && observed.created_at !== intent.identity.created_at)
    )
      return "未核实：GitHub 返回的运行身份不符";
    return observed.status === "completed"
      ? `已向 GitHub 核实运行 ${run.run_id} 已结束（结论 ${word(observed.conclusion) ?? "未知"}）`
      : `已向 GitHub 核实运行 ${run.run_id} 仍为 ${word(observed.status) ?? "未知"} 状态`;
  }
  /**
   * C-773: end a stale or abandoned attempt as interrupted. The lookup is
   * evidence for the summary only: a remote success is never recorded as a
   * pass without the poller's full step verification. The journal then
   * abandons the intent, and merge maintenance cancels a still-running run.
   */
  private async expire(
    project: ProjectId,
    original: Precheck,
    settings: Settings,
    cause: { request: PrecheckRecoveryRequest } | { limit: number },
  ): Promise<void> {
    const executor = settings.executor?.name ?? "";
    const intent = this.boundIntent(project, original, executor);
    const run = intent?.externalRun ?? original.external_run;
    const observed = run
      ? await this.observeRun(run, intent, settings)
      : new GithubDispatchJournal(this.options.store).hasUnboundIntent(
            project,
            original.card_id,
            original.attempt_id,
          )
        ? "未核实：GitHub 派发结果尚未确认，没有绑定的运行"
        : original.status === "queued"
          ? "尚未开始执行检查"
          : "未核实远端状态";
    const request = "request" in cause ? cause.request : undefined;
    const check = prechecks(this.state(project).events).find(
      (c) => c.attempt_id === original.attempt_id,
    );
    if (!check || !["queued", "running"].includes(check.status)) return;
    const after = request
      ? (tx: StoreTx) => this.handled(tx, project, check, request, "abandoned")
      : undefined;
    // A saved result still awaiting its HEAD proof must also settle here:
    // schedule() skips execute() for an expiring attempt, so nothing else
    // would ever verify it again.
    const saved = this.options.store.uow.read(() => this.proof(project, check));
    if (saved) {
      if (!request) {
        // The stale fallback gives the proof one more chance first.
        try {
          await this.verify(project, saved);
        } catch {
          /* Falls through to the unverified terminal below. */
        }
        if (!this.options.store.uow.read(() => this.proof(project, check)))
          return;
      }
      this.headLockSince.delete(check.attempt_id);
      // Settles only while the checkpoint remains, so a concurrent verifier
      // and this pass can never publish two terminals.
      this.update(
        project,
        {
          ...check,
          status: "interrupted",
          summary:
            "limit" in cause
              ? `预检查超过 ${Math.ceil(cause.limit / 60_000)} 分钟仍未收尾，检查结果已保存但未能核验分支HEAD，按核对超时结束；不作为通过依据，请重新 request_check`
              : "主机运维已放弃此次预检查；检查结果已保存但未能核验分支HEAD，不作为通过依据，请重新 request_check",
        },
        true,
        after,
      );
      return;
    }
    const summary =
      "limit" in cause
        ? `预检查超过 ${Math.ceil(cause.limit / 60_000)} 分钟仍未收尾，按核对超时结束；${observed}；结果未经主机完整核验，不作为通过依据，请重新 request_check`
        : `主机运维已放弃此次预检查；${observed}；结果未经主机完整核验，不作为通过依据，请重新 request_check`;
    this.update(
      project,
      { ...check, status: "interrupted", summary },
      false,
      after,
    );
  }
  private recordMutexWait(
    project: ProjectId,
    check: Precheck,
    blocker: string,
  ): void {
    this.options.store.uow.run((tx) => {
      const events = tx.events.listAfter(project, check.card_id, 0);
      if (
        events.some(
          (e) =>
            e.type === "precheck_waiting" &&
            e.actor.kind === "system" &&
            (e.payload as { attempt_id?: string }).attempt_id ===
              check.attempt_id &&
            (e.payload as { blocking_attempt?: string }).blocking_attempt ===
              blocker,
        )
      )
        return;
      const reason = `等待同卡 GitHub 检查 ${blocker} 释放占用`;
      const seq = tx.ids.nextEventSequence(project, check.card_id),
        at = this.options.clock.now();
      tx.events.append(project, {
        id: tx.ids.nextEventId(),
        seq,
        card_id: check.card_id,
        type: "precheck_waiting",
        actor: { kind: "system", project_id: project },
        payload: {
          attempt_id: check.attempt_id,
          blocking_attempt: blocker,
          reason,
        },
        created_at: at,
      });
      const id = tx.ids.nextTimelineEntryId(project, check.card_id);
      tx.timeline.put(project, {
        id,
        short_id: id,
        card_id: check.card_id,
        event_seq: seq,
        type: "system",
        author: "system",
        refs: [],
        mentions: [],
        retracted: false,
        created_at: at,
        body: `作者预检查 ${check.attempt_id}：${reason}`,
      });
    });
  }
  private async execute(projectId: ProjectId, original: Precheck) {
    let check = original,
      stage = "配置",
      log: Awaited<ReturnType<typeof createMergeCheckLog>> | undefined;
    let slot: { index: number; release(): void } | undefined,
      release: ReturnType<typeof acquireMergeCheckCapacity> | undefined;
    // If the checkpoint cannot be read, neither dispatch nor settle a fallback.
    const pending = this.options.store.uow.read(() =>
      this.proof(projectId, check),
    );
    let finishedLog = false,
      verifying = !!pending;
    let errorEnv: Readonly<Record<string, string>> = {};
    try {
      if (
        !pending &&
        (this.held(projectId, check) ||
          Date.parse(this.options.clock.now()) <
            (this.retry.get(check.attempt_id) ?? 0))
      )
        return;
      const settings = this.options.configuration.forProject(projectId);
      if (settings.status !== "enabled" || !settings.executor)
        throw new PrecheckVerificationFailure("No trusted remote executor");
      errorEnv = settings.env;
      const target = settings.executor;
      if (
        check.executor &&
        (check.executor.name !== target.name ||
          check.executor.type !== (target.type ?? "ssh"))
      )
        throw new PrecheckVerificationFailure(
          "Precheck target configuration changed",
        );
      if (pending) {
        stage = "核对分支HEAD";
        await this.verify(projectId, pending);
        return;
      }
      if (
        new CheckHandoffs(this.options.store, "precheck-observer").blocked(
          target.name,
        )
      )
        return;
      if (
        mergeCheckAttemptRunning(
          this.options.store,
          projectId,
          check.attempt_id,
        )
      )
        return;
      const assignment = this.owner(projectId, check);
      if (!assignment) {
        this.update(projectId, {
          ...check,
          status: "interrupted",
          summary: "负责人或卡片已失效",
        });
        return;
      }
      if (check.status === "running" && target.type !== "github") {
        this.update(projectId, {
          ...check,
          status: "interrupted",
          summary: "主机重启后原执行已结束，请重新 request_check",
        });
        return;
      }
      // C-773: a bound GitHub run already holds its executor admission in the
      // journal. Re-attaching skips every new-dispatch gate (HEAD read, slot,
      // capacity lease); the owner and HEAD are proven on its result instead.
      const reattach =
        target.type === "github"
          ? this.reattachable(projectId, check, target.name)
          : undefined;
      if (
        !this.options.git.checkHead ||
        !this.options.git.preparePrecheck ||
        !this.options.git.distribute ||
        !this.options.git.projectOf
      )
        throw new Error("No trusted Git adapter");
      if (!reattach) {
        stage = "读取分支HEAD";
        let head: string;
        try {
          head = await this.options.git.checkHead(projectId, assignment);
        } catch (error) {
          // No executor has been called. Leave this exact queued attempt
          // for the next scheduling pass, until the lock has stayed busy
          // past its limit (C-773).
          if (error instanceof RepositoryLockTimeoutError) {
            const limit = this.headLockExpired(check);
            if (limit !== undefined) {
              this.headLockSince.delete(check.attempt_id);
              this.update(projectId, {
                ...check,
                status: "interrupted",
                summary: `读取分支HEAD时主机仓库锁持续被占用超过 ${Math.ceil(limit / 60_000)} 分钟，按超时结束；尚未开始执行检查，请重新 request_check`,
              });
            }
            return;
          }
          throw error;
        }
        this.headLockSince.delete(check.attempt_id);
        if (head !== check.head_sha) {
          this.update(projectId, {
            ...check,
            status: "interrupted",
            summary: "分支HEAD已改变，请重新 request_check",
          });
          return;
        }
      }
      const distribute = this.options.git.distribute;
      const registered = this.options.git.projectOf(projectId);
      if (!registered) throw new Error("Missing project");
      // The candidate merges into the card's own baseline branch.
      const branch = this.options.store.uow.read(
        (tx) => tx.cards.get(projectId, check.card_id)?.base_branch,
      );
      const project = branch ? centralBranch(registered, branch) : registered;
      const journal = new GithubDispatchJournal(this.options.store);
      if (target.type === "github" && !reattach) {
        const admitted = journal.admitted();
        const unfinished = admitted.filter((i) => i.executor === target.name);
        const blocker = admitted.find(
          (i) =>
            i.project === projectId &&
            i.card === check.card_id &&
            i.attempt !== check.attempt_id,
        );
        if (blocker) {
          this.recordMutexWait(projectId, check, blocker.attempt);
          return;
        }
        if (
          !unfinished.some(
            (i) => i.attempt === check.attempt_id && i.project === projectId,
          ) &&
          unfinished.length >= target.maxConcurrent
        )
          return;
      }
      if (!reattach) {
        slot = await this.options.reserve(settings);
        if (!slot || this.options.signal.aborted) return;
        // Admission and capacity are rechecked under the same SQLite write lock.
        release = acquireMergeCheckCapacity(
          this.options.store,
          projectId,
          check.attempt_id,
          undefined,
          target.name,
          undefined,
          target.maxConcurrent,
        );
      }
      // Admission awaited a slot/HEAD. A different controller may have already
      // completed execution for our old queue snapshot and released its slot.
      if (
        this.options.store.uow.read(
          () =>
            this.proof(projectId, check) ||
            !isDeepStrictEqual(this.current(projectId, check), original),
        )
      )
        return;
      stage = "准备候选";
      const candidate =
        check.candidate_sha && check.base_sha && check.tree_sha
          ? {
              candidate_sha: check.candidate_sha,
              base_sha: check.base_sha,
              tree_sha: check.tree_sha,
            }
          : await this.options.git.preparePrecheck(
              project,
              check.assignment_id,
              check.head_sha,
              check.attempt_id,
            );
      check = {
        ...check,
        ...candidate,
        executor: { name: target.name, type: target.type ?? "ssh" },
      };
      if (!reattach) {
        if (this.held(projectId, check)) return;
        if (check.status === "queued") this.update(projectId, check);
      }
      if (this.options.signal.aborted) return;
      stage = "创建日志";
      log = await (this.options.createLog ?? createMergeCheckLog)({
        dataDir: this.options.execution.dataDir,
        project: projectId,
        attempt: check.attempt_id,
        env: settings.env,
        redactPaths: true,
        // A queued attempt may have been held after creating its private log.
        resume: true,
        ...(target.type === "github"
          ? {
              failureExcerptBytes: target.failureExcerptBytes ?? 4096,
            }
          : {}),
      });
      const execution =
        target.type === "github"
          ? this.options.execution
          : executorExecution(target, this.options.execution);
      let bound = check.external_run;
      const executor =
        target.type === "github"
          ? this.options.github(check, project, settings, (run) => {
              bound = run;
            })
          : (this.options.executor ??
            new SshCheckExecutor({
              execution,
              distribute: async () => {
                stage = "分发候选";
                await distribute(project, execution);
                if (
                  !this.owner(projectId, check) ||
                  this.options.signal.aborted
                )
                  throw new Error("Stale author check");
              },
              ...(this.options.run ? { run: this.options.run } : {}),
            }));
      if (!reattach && this.held(projectId, check)) return;
      if (reattach && !this.reattached.has(check.attempt_id)) {
        this.reattached.add(check.attempt_id);
        journal.progress(
          projectId,
          check.card_id,
          check.attempt_id,
          "主机已重新接上已绑定的 GitHub 检查，正在核对远端状态",
          this.options.clock.now(),
        );
      }
      stage = "执行检查";
      const steps = settings.checks.map((s) => ({
        name: s.name,
        run: s.run,
        ...(s.timeoutMs !== undefined ? { timeoutMs: s.timeoutMs } : {}),
      }));
      // C-798: the configuration these exact steps run with, fixed when the
      // attempt starts running. A reattached run keeps its recorded value.
      const fingerprints = steps.map((step) => ({
        name: step.name,
        fingerprint: checkStepFingerprint(step),
      }));
      const result = await runCheckExecutor(
        executor,
        {
          beforeDispatch: () => {
            if (!this.owner(projectId, check) || this.held(projectId, check))
              throw new CheckExecutorSuspended();
          },
          kind: "precheck",
          project: projectId,
          attempt: check.attempt_id,
          sha: candidate.candidate_sha,
          tree: candidate.tree_sha,
          checks: steps,
          env: settings.env,
          totalTimeoutMs: settings.totalTimeoutMs,
          serialize: true,
          ...(slot ? { lockSlot: slot.index } : {}),
          ...(target.type === "github"
            ? { hostSignal: this.options.signal }
            : { signal: this.options.signal }),
          onReady: (owner) => {
            if (target.type !== "github") release?.transfer(owner);
            if (check.status !== "running") {
              check = {
                ...check,
                status: "running",
                ...(bound ? { external_run: bound } : {}),
                check_fingerprints: fingerprints,
              };
              this.update(projectId, check);
            }
            // Remote journal retains its slot through verified terminal/recovery.
            if (target.type === "github") release?.();
          },
          onProgress: (summary) => {
            if (this.owner(projectId, check))
              new GithubDispatchJournal(this.options.store).progress(
                projectId,
                check.card_id,
                check.attempt_id,
                summary,
                this.options.clock.now(),
              );
          },
          onRegistered: (binding) =>
            this.options.recovery.register(
              projectId,
              check.card_id,
              check.attempt_id,
              candidate.candidate_sha,
              binding,
              target,
            ),
          resetFailureLog: (name) => log?.resetOutput(name),
          onOutput: (name, text) => log?.append(name, text),
        },
        (error) => this.options.onError(error),
      );
      stage = "保存日志";
      finishedLog = true;
      const saved = await log.finish(
        result,
        target.type === "github" ? bound : undefined,
        bound
          ? recordCheckFlakes(
              this.options.store,
              projectId,
              check.card_id,
              check.attempt_id,
              this.options.clock.now(),
              result.recovered,
            )
          : undefined,
      );
      const completed: Precheck = {
        ...check,
        ...(bound ? { external_run: bound } : {}),
        status: saved.status,
        checks: saved.checks,
        summary: saved.summary,
        log_ref: saved.log_ref,
      };
      // Save only the host's redacted structured result, never raw executor output.
      // The public status stays queued/running until recordPrecheck validates it.
      const recorded = this.options.store.uow.run(() => {
        const latest = this.current(projectId, check);
        if (!latest || !["queued", "running"].includes(latest.status))
          return false;
        return (
          this.options.store.database
            .prepare(`INSERT INTO precheck_head_proofs
          (project_id,card_id,attempt_id,result) VALUES (?,?,?,?)
          ON CONFLICT(project_id,card_id,attempt_id) DO NOTHING`)
            .run(
              projectId,
              check.card_id,
              check.attempt_id,
              JSON.stringify(completed),
            ).changes === 1
        );
      });
      release?.();
      release = undefined;
      slot?.release();
      slot = undefined;
      if (recorded) {
        verifying = true;
        stage = "核对分支HEAD";
        await this.verify(projectId, completed);
      }
    } catch (error) {
      if (
        error instanceof CheckAdmissionClosed ||
        error instanceof DeploymentInProgress
      )
        return;
      if (error instanceof CheckExecutorSuspended) return;
      if (error instanceof GithubRetryLater) {
        this.retry.set(check.attempt_id, error.retryAt);
        return;
      }
      // C-773: a restart interrupting the HEAD read or candidate preparation
      // is not an environment failure. No executor was called, so the queued
      // attempt is left as it is and the next controller continues it.
      if (
        !verifying &&
        PRE_EXECUTION_STAGES.has(stage) &&
        !(error instanceof PrecheckMergeConflict) &&
        !(error instanceof PrecheckVerificationFailure) &&
        (await this.shuttingDown())
      )
        return;
      if (verifying && !(error instanceof PrecheckVerificationFailure)) {
        // A rolled-back transaction says nothing about the saved check result.
        // Keep it private and repeat the owner and HEAD proof on the next pass.
        this.reportFixed(
          "作者预检查结果暂未能核验入库，下轮重新核验，不重跑检查",
        );
        return;
      }
      const primaryDiagnostic = this.reportFailure(
        stage,
        error instanceof PrecheckVerificationFailure
          ? (error.cause ?? error)
          : error,
        errorEnv,
      );
      const diagnostics = [primaryDiagnostic];
      if (log && !finishedLog) {
        finishedLog = true;
        try {
          await log.finish({
            status: "failed",
            checks: [],
            cleanup_errors: [],
            reason: primaryDiagnostic,
          });
        } catch (logError) {
          diagnostics.push(this.reportFailure("保存日志", logError, errorEnv));
        }
      }
      const summary = boundedCheckSummary(...diagnostics);
      if (verifying) {
        // Still require the checkpoint when publishing a proof failure: a
        // different verifier may already have settled it. A write fault leaves
        // the checkpoint intact for the next pass, never eligible to dispatch.
        this.update(
          projectId,
          { ...check, status: "environment_failed", summary },
          true,
        );
        return;
      }
      this.finishFailure(projectId, {
        ...check,
        summary,
        ...(stage === "准备候选" && error instanceof PrecheckMergeConflict
          ? {
              failure_kind: "candidate_conflict" as const,
              base_sha: error.baseSha,
            }
          : {}),
      });
    } finally {
      release?.();
      slot?.release();
    }
  }
}
