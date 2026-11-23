import type { Clock, ProjectId } from "@cardigan/domain";
import type { CentralProject } from "@cardigan/git-service";
import type {
  CentralRepackMode,
  CentralRepackResult,
} from "@cardigan/git-transport";
import type { Store } from "@cardigan/store";
import { type LoopStartup, startTimerLoop, type TimerLoop } from "./loop.js";

/**
 * C-637: off-peak object maintenance of the central repositories.
 *
 * Inside the configured local-time window each project gets one run per
 * window: a geometric repack (rolls the day's small packs and loose objects
 * into a geometric progression), or a cruft repack when the newest cruft pack
 * is older than the cruft interval. Neither expires an object, and neither
 * holds the host repository lock, so preparations and merges never wait on
 * maintenance. Ref retention is not part of this loop.
 */
export const DEFAULT_CENTRAL_MAINTENANCE_WINDOW = "03:00-06:00";
export const DEFAULT_CENTRAL_MAINTENANCE_INTERVAL_MS = 900_000;
export const DEFAULT_CENTRAL_CRUFT_INTERVAL_MS = 7 * 86_400_000;

/** Minutes after local midnight; `start` inclusive, `end` exclusive, may wrap. */
export interface MaintenanceWindow {
  readonly start: number;
  readonly end: number;
}

const clockTime = /^([01]\d|2[0-3]):([0-5]\d)$/u;
/** `HH:MM-HH:MM` in host local time, or `off`. */
export function parseMaintenanceWindow(
  text: string,
  name = "CARDIGAN_CENTRAL_MAINTENANCE_WINDOW",
): MaintenanceWindow | undefined {
  const value = text.trim();
  if (value === "off") return undefined;
  const [from, to, ...rest] = value.split("-");
  const minutes = (part: string | undefined) => {
    const match = clockTime.exec(part ?? "");
    return match ? Number(match[1]) * 60 + Number(match[2]) : undefined;
  };
  const start = minutes(from),
    end = minutes(to);
  if (start === undefined || end === undefined || rest.length || start === end)
    throw new Error(`${name} must be HH:MM-HH:MM (local time) or off`);
  return { start, end };
}

/**
 * The local date (YYYY-MM-DD) on which the window containing `at` opened, or
 * undefined outside the window; one maintenance run per occurrence.
 */
export function windowOccurrence(
  window: MaintenanceWindow,
  at: Date,
): string | undefined {
  const minute = at.getHours() * 60 + at.getMinutes();
  const wraps = window.start > window.end;
  const inside = wraps
    ? minute >= window.start || minute < window.end
    : minute >= window.start && minute < window.end;
  if (!inside) return undefined;
  const opened = new Date(at);
  if (wraps && minute < window.end) opened.setDate(opened.getDate() - 1);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${opened.getFullYear()}-${pad(opened.getMonth() + 1)}-${pad(opened.getDate())}`;
}

export interface CentralMaintenanceTarget {
  /** Newest cruft pack time in epoch milliseconds; undefined without one. */
  lastCruftPack(): Promise<number | undefined>;
  repack(mode: CentralRepackMode): Promise<CentralRepackResult>;
}
export interface CentralMaintenanceGit {
  projectOf(project_id: ProjectId): CentralProject | undefined;
  /** Undefined when the project has no central repository or another process maintains it. */
  centralMaintenance?(
    project: CentralProject,
  ): Promise<
    | { readonly target: CentralMaintenanceTarget; release(): Promise<void> }
    | undefined
  >;
}

export interface CentralMaintenanceOptions {
  readonly store: Pick<Store, "listProjects">;
  readonly git: CentralMaintenanceGit;
  readonly window: MaintenanceWindow;
  readonly cruftIntervalMs?: number;
  readonly clock?: Clock;
  /** One structured line per finished run (timings and object counts). */
  readonly log?: (line: Record<string, unknown>) => void;
  readonly report?: (message: string) => void;
}

export class CentralMaintenanceExecutor {
  private serial: Promise<void> = Promise.resolve();
  /** Process-local: a restart may run once more in the same window, harmlessly. */
  private readonly finished = new Map<string, string>();
  /** Git writes no cruft pack when nothing is unreachable; remember the run. */
  private readonly cruftRuns = new Map<string, number>();
  constructor(private readonly options: CentralMaintenanceOptions) {}

  private now() {
    const clock = this.options.clock;
    return clock ? new Date(clock.now()) : new Date();
  }

  tick(): Promise<void> {
    const next = this.serial.then(async () => {
      for (const { id } of this.options.store.listProjects()) {
        // Re-read per project: never start a repack after the window closed.
        const at = this.now();
        const occurrence = windowOccurrence(this.options.window, at);
        if (occurrence === undefined) return;
        if (this.finished.get(id) === occurrence) continue;
        const project = this.options.git.projectOf(id as ProjectId);
        if (project === undefined) continue;
        try {
          if (await this.maintain(id, project, at))
            this.finished.set(id, occurrence);
        } catch (error) {
          this.options.report?.(
            `central maintenance of ${id} failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    });
    this.serial = next.catch(() => {});
    return next;
  }

  private async maintain(id: string, project: CentralProject, at: Date) {
    const held = await this.options.git.centralMaintenance?.(project);
    if (held === undefined) return false;
    try {
      const packed = await held.target.lastCruftPack(),
        ran = this.cruftRuns.get(id);
      const last =
        packed === undefined || ran === undefined
          ? (packed ?? ran)
          : Math.max(packed, ran);
      const mode: CentralRepackMode =
        last === undefined ||
        at.getTime() - last >=
          (this.options.cruftIntervalMs ?? DEFAULT_CENTRAL_CRUFT_INTERVAL_MS)
          ? "cruft"
          : "geometric";
      const result = await held.target.repack(mode);
      if (mode === "cruft") this.cruftRuns.set(id, at.getTime());
      this.options.log?.({
        event: "central_maintenance",
        project_id: id,
        mode: result.mode,
        duration_ms: result.duration_ms,
        // Maintenance never takes the host repository lock.
        repository_lock_ms: 0,
        packs_before: result.before.packs,
        packs_after: result.after.packs,
        loose_before: result.before.loose,
        loose_after: result.after.loose,
        size_pack_kib_before: result.before.size_pack_kib,
        size_pack_kib_after: result.after.size_pack_kib,
      });
      return true;
    } finally {
      await held.release();
    }
  }
}

export function startCentralMaintenanceLoop(
  options: CentralMaintenanceOptions & {
    readonly startup?: LoopStartup | undefined;
    readonly intervalMs?: number;
    readonly onError?: (error: unknown) => void;
    readonly signal?: AbortSignal;
  },
): { readonly executor: CentralMaintenanceExecutor; readonly loop: TimerLoop } {
  const executor = new CentralMaintenanceExecutor(options);
  const intervalMs =
    options.intervalMs ?? DEFAULT_CENTRAL_MAINTENANCE_INTERVAL_MS;
  const loop = startTimerLoop({
    startup: options.startup,
    name: "central-maintenance",
    initialDelayMs: Math.min(60_000, intervalMs),
    tick: () => executor.tick(),
    intervalMs,
    // The first roll-up of a neglected repository can take a minute.
    slowTickMs: 10 * 60_000,
    onError: options.onError ?? (() => undefined),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return { executor, loop };
}
