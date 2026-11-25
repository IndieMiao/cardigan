import type { ProjectId } from "@cardigan/domain";
import {
  DEFAULT_RUN_DIR_RETENTION_DAYS,
  type RunDirReply,
  type RuntimeTargets,
  reclaimableRunDirectories,
  reclaimRunDirectories,
} from "@cardigan/host";
import { loadCommandState } from "@cardigan/mcp-server";
import type { Store } from "@cardigan/store";
import { type LoopStartup, startTimerLoop } from "./loop.js";

/**
 * C-743: released Assignments' run directories on every machine (the control
 * host and remote workers) are reclaimed once released for more than the
 * configured days. Each round writes `host_run_dirs_reclaimed` on the project
 * stream, which PM reads and diagnostics summarize.
 */
export const RUN_DIR_RECLAIMED = "host_run_dirs_reclaimed";
export type RunDirMode = "auto" | "preview" | "off";
export interface RunDirSettings {
  readonly days: number;
  readonly mode: RunDirMode;
}
export function runDirSettings(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.CARDIGAN_RUN_DIR_RETENTION_DAYS;
  const days = raw === undefined ? DEFAULT_RUN_DIR_RETENTION_DAYS : Number(raw);
  if (
    (raw !== undefined && !/^[1-9]\d*$/u.test(raw)) ||
    !Number.isSafeInteger(days) ||
    days > 3650
  )
    throw new Error("Invalid run directory retention days");
  const mode = (env.CARDIGAN_RUN_DIR_RETENTION ?? "auto") as RunDirMode;
  if (!["auto", "preview", "off"].includes(mode))
    throw new Error("Invalid run directory retention mode");
  return { days, mode } satisfies RunDirSettings;
}

const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
const LISTED = 50;

export class RunDirRetention {
  private pending: { project: ProjectId; machine: string }[] = [];
  private more = false;
  /** Last unchanged "nothing could be removed" outcome per machine: say it once. */
  private readonly quiet = new Map<string, string>();
  constructor(
    private readonly store: Store,
    private readonly targets: Pick<RuntimeTargets, "resolve">,
    private readonly settings: RunDirSettings,
    private readonly options: {
      readonly reclaim?: typeof reclaimRunDirectories;
      readonly now?: () => number;
      readonly budgetMs?: number;
      readonly report?: (message: string) => void;
    } = {},
  ) {}
  /** Another machine is due in this pass, or a machine ran out of budget. */
  continueSoon() {
    return this.pending.length > 0 || this.more;
  }
  async tick() {
    if (this.settings.mode === "off") return;
    if (!this.pending.length) {
      this.more = false;
      this.pending = this.store.uow
        .read((tx) =>
          this.store.listProjects().flatMap(({ id: project }) =>
            tx.machines
              .list(project)
              .filter((m) => ["online", "degraded"].includes(m.status))
              .map((m) => ({ project, machine: m.id })),
          ),
        )
        .reverse();
    }
    const next = this.pending.pop();
    if (next) await this.machine(next.project, next.machine);
  }
  /** One full pass over every machine. */
  async sweep() {
    this.pending = [];
    do await this.tick();
    while (this.pending.length);
  }
  private async machine(project: ProjectId, machine: string) {
    const now = (this.options.now ?? Date.now)();
    // Re-read immediately before the call: a later fence or keep wins.
    const state = this.store.uow.read((tx) => loadCommandState(tx, project));
    const names =
      reclaimableRunDirectories(state, this.settings.days, now).get(machine) ??
      [];
    if (!names.length) return;
    let reply: RunDirReply;
    try {
      const { execution } = this.targets.resolve(project, machine);
      reply = await (this.options.reclaim ?? reclaimRunDirectories)(
        execution,
        project,
        names,
        {
          preview: this.settings.mode === "preview",
          hostOwnsParent: machine === "local",
          ...(this.options.budgetMs === undefined
            ? {}
            : { budgetMs: this.options.budgetMs }),
        },
      );
    } catch {
      this.options.report?.(`run directory retention on ${machine} failed`);
      this.record(project, machine, now, undefined);
      return;
    }
    if (!reply.complete) this.more = true;
    this.record(project, machine, now, reply);
  }
  private record(
    project: ProjectId,
    machine: string,
    now: number,
    reply: RunDirReply | undefined,
  ) {
    const by = (state: string) =>
      reply?.results.filter((r) => r.state === state) ?? [];
    const removed = by("removed"),
      preview = by("preview"),
      kept =
        reply?.results.filter((r) =>
          ["emptied", "partial", "skipped"].includes(r.state),
        ) ?? [];
    const freed = (reply?.results ?? []).reduce((n, r) => n + r.freed_bytes, 0);
    const progress = removed.length > 0 || preview.length > 0 || freed > 0;
    const signature = JSON.stringify([
      reply === undefined,
      kept.map((r) => r.name),
    ]);
    const key = `${project}/${machine}`;
    if (!progress) {
      if (!kept.length && reply) return;
      if (this.quiet.get(key) === signature) return;
      this.quiet.set(key, signature);
    } else this.quiet.delete(key);
    const mode = this.settings.mode === "preview" ? "preview" : "auto";
    const count = mode === "preview" ? preview.length : removed.length;
    const notice =
      reply === undefined
        ? `机器 ${machine} 的运行目录回收本轮未完成，下轮重试`
        : mode === "preview"
          ? `预览：机器 ${machine} 上 ${count} 个已释放超过 ${this.settings.days} 天的指派运行目录可回收，约 ${gib(freed)}`
          : `已回收机器 ${machine} 上 ${count} 个已释放超过 ${this.settings.days} 天的指派运行目录，腾出 ${gib(freed)}${kept.length ? `；${kept.length} 个未能完全删除，下轮重试` : ""}`;
    this.store.uow.run((tx) =>
      tx.events.append(project, {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(project),
        type: RUN_DIR_RECLAIMED,
        actor: { kind: "system", project_id: project },
        created_at: new Date(now).toISOString(),
        payload: {
          machine_id: machine,
          mode,
          status: reply === undefined ? "failed" : "completed",
          released_days: this.settings.days,
          removed: count,
          freed_bytes: freed,
          names: (mode === "preview" ? preview : removed)
            .slice(0, LISTED)
            .map((r) => r.name),
          retained: kept.slice(0, LISTED).map((r) => r.name),
          retained_count: kept.length,
          remaining: reply ? !reply.complete : true,
          notice,
        },
      }),
    );
  }
}

export function startRunDirLoop(
  store: Store,
  targets: Pick<RuntimeTargets, "resolve">,
  report: (message: string) => void,
  startup?: LoopStartup,
  intervalMs = 15 * 60_000,
  settings: RunDirSettings = runDirSettings(),
) {
  const executor = new RunDirRetention(store, targets, settings, { report });
  return startTimerLoop({
    name: "run_dir_retention",
    startup,
    initialDelayMs: Math.min(intervalMs, 60_000),
    intervalMs,
    continueSoon: () => executor.continueSoon(),
    onError: () => report("run directory retention tick failed"),
    tick: () => executor.tick(),
  });
}
