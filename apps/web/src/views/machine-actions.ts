import {
  ApiError,
  type CardiganClient,
  describeError,
  type MachineBindingView,
  type MachineCheckJob,
  type MachineView,
} from "../api.js";
import { checkStepLabel } from "../machine-labels.js";

/**
 * C-511 / Q-1074: what 立即检查 and 排空/恢复 are doing on one machine, kept
 * per project and machine for the whole page rather than in a drawer. The
 * requests are sent from here and their replies land here, so a drawer
 * closed and opened again (or opened twice) shows the same state, including
 * a reply that arrives after the drawer that sent it is gone.
 *
 * Q-1048 rules hold: only a reply speaks for a request. A request whose
 * reply never came (no reply, timeout, 5xx) stays unknown; reads of the
 * machine say what the machine is doing, never what became of the request.
 * Unknown writes and writes in flight are also kept in the tab's session
 * storage: a page reloaded while a write was in flight treats it as unknown.
 */

type RequestedCheck = NonNullable<MachineBindingView["last_requested_check"]>;
type Write = "check" | "drain" | "resume";
export interface ActionFeedback {
  readonly error: string;
  readonly message: string;
  /** The check's progress read failed; retrying reads it again. */
  readonly retry: boolean;
}
export interface MachineActionState {
  /** A write sent and not answered yet (one at a time per machine). */
  readonly sending?: Write | undefined;
  /**
   * A check request without a reply. `at`: the page clock when it became
   * unknown; only a read started later can describe the machine since.
   * `seen`: checks of this machine seen running in such a read.
   */
  readonly unknownCheck?:
    | { readonly at: number; readonly seen: readonly string[] }
    | undefined;
  readonly unknownDrain?:
    | { readonly at: number; readonly op: "drain" | "resume" }
    | undefined;
  /** The one check this page follows; its progress is read by id. */
  readonly following?:
    | { readonly id: string; readonly step: string }
    | undefined;
  readonly check: ActionFeedback;
  readonly drain: ActionFeedback;
}
interface Link {
  readonly client: CardiganClient;
  readonly pollMs: number;
  /** Read the detail (and list and capacity) again. */
  readonly reread: () => void;
}

/**
 * Orders reads against writes on this page: an unknown write takes a tick,
 * and so does every detail read when it starts. Reloading starts at zero,
 * so an unknown write restored from storage precedes every read.
 */
let clock = 0;
export const machineReadTick = () => ++clock;

const blank: ActionFeedback = { error: "", message: "", retry: false };
const NOTICE_MS = 4000;
const storageKey = (projectId: string, machineId: string) =>
  `cardigan:machine-actions:${projectId}:${machineId}`;
/** Used only where the tab's session storage is unavailable. */
const memory = new Map<string, string>();
type Stored = {
  check?: { seen: string[] };
  drain?: "drain" | "resume";
  sending?: Write;
};
function readStored(key: string): Stored {
  let raw: string | null | undefined;
  try {
    raw = window.sessionStorage.getItem(key);
  } catch {
    raw = memory.get(key);
  }
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return {};
    const { check, drain, sending } = value as Record<string, unknown>;
    const seen =
      check && typeof check === "object"
        ? (check as { seen?: unknown }).seen
        : undefined;
    return {
      ...(check && typeof check === "object"
        ? {
            check: {
              seen: Array.isArray(seen)
                ? seen.filter((id): id is string => typeof id === "string")
                : [],
            },
          }
        : {}),
      ...(drain === "drain" || drain === "resume" ? { drain } : {}),
      ...(sending === "check" || sending === "drain" || sending === "resume"
        ? { sending }
        : {}),
    };
  } catch {
    return {};
  }
}
function writeStored(key: string, value: Stored) {
  const raw =
    value.check || value.drain || value.sending ? JSON.stringify(value) : "";
  try {
    if (raw) window.sessionStorage.setItem(key, raw);
    else window.sessionStorage.removeItem(key);
  } catch {
    if (raw) memory.set(key, raw);
    else memory.delete(key);
  }
}

/** No reply, or a gateway/server error: the write may have taken effect. */
const uncertain = (cause: unknown) =>
  !(cause instanceof ApiError) || cause.status >= 500;

/** The running explicit check of a machine, from any project's binding. */
export function runningCheck(machine: MachineView | undefined) {
  return machine?.bindings
    .map((b) => b.last_requested_check)
    .find((r): r is RequestedCheck => r?.status === "running");
}
/** A health or worker check in progress, which has no id to follow. */
export function checkingWithoutId(machine: MachineView) {
  return machine.bindings.some(
    (b) =>
      b.machine_check?.status === "checking" ||
      b.worker_check?.status === "checking",
  );
}

class MachineActions {
  private state: MachineActionState;
  private readonly listeners = new Set<() => void>();
  private readonly links = new Set<Link>();
  /** Checks this page saw end: a later read never follows them again. */
  private readonly ended = new Set<string>();
  /**
   * Bumped whenever the followed check changes or ends and whenever the
   * progress loop restarts: a progress reply is used only with its token.
   */
  private token = 0;
  private timer: number | undefined;
  /** The token of a progress read in flight. */
  private inflight: number | undefined;
  private readonly notices: Record<"check" | "drain", number | undefined> = {
    check: undefined,
    drain: undefined,
  };

  constructor(
    private readonly projectId: string,
    private readonly machineId: string,
  ) {
    // A write in flight when the page went away was cut off: unknown.
    const stored = readStored(this.key);
    const check =
      stored.check ?? (stored.sending === "check" ? { seen: [] } : undefined);
    const drainOp =
      stored.drain ??
      (stored.sending === "drain" || stored.sending === "resume"
        ? stored.sending
        : undefined);
    this.state = {
      unknownCheck: check ? { at: 0, seen: check.seen } : undefined,
      unknownDrain: drainOp ? { at: 0, op: drainOp } : undefined,
      check: blank,
      drain: blank,
    };
    this.persist();
  }

  private get key() {
    return storageKey(this.projectId, this.machineId);
  }
  private get link() {
    return [...this.links].at(-1);
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  readonly getSnapshot = () => this.state;

  private set(patch: Partial<MachineActionState>) {
    this.state = { ...this.state, ...patch };
    this.persist();
    for (const listener of this.listeners) listener();
  }
  private persist() {
    const { unknownCheck, unknownDrain, sending } = this.state;
    writeStored(this.key, {
      ...(unknownCheck ? { check: { seen: [...unknownCheck.seen] } } : {}),
      ...(unknownDrain ? { drain: unknownDrain.op } : {}),
      ...(sending ? { sending } : {}),
    });
  }
  /** A result line that clears itself, as settings notices do. */
  private notice(kind: "check" | "drain", feedback: ActionFeedback) {
    window.clearTimeout(this.notices[kind]);
    this.set({ [kind]: feedback });
    if (!feedback.message) return;
    this.notices[kind] = window.setTimeout(() => {
      if (this.state[kind] === feedback)
        this.set({ [kind]: { ...feedback, message: "" } });
    }, NOTICE_MS);
  }
  private reread() {
    for (const link of this.links) link.reread();
  }

  /** A drawer showing this machine; the progress loop runs while one is. */
  attach(link: Link) {
    this.links.add(link);
    this.poll();
    return () => {
      this.links.delete(link);
      if (this.links.size) return;
      window.clearTimeout(this.timer);
      this.timer = undefined;
      // Plain results belong to the view that showed them; what is in
      // flight, unknown or followed stays for the next one.
      if (!this.state.check.retry) this.notice("check", blank);
      this.notice("drain", blank);
    };
  }

  /** A followed check ended or changed: replies already sent are void. */
  private stopPolling() {
    window.clearTimeout(this.timer);
    this.timer = undefined;
    this.token++;
  }
  /**
   * One loop per machine, reading the followed check by its id. A drawer
   * closed and opened again resumes it; a read still in flight for the same
   * check is not doubled.
   */
  private poll() {
    window.clearTimeout(this.timer);
    this.timer = undefined;
    const following = this.state.following;
    const link = this.link;
    const read = link?.client.machineCheck;
    const token = this.token;
    if (!following || !link || !read || this.state.check.retry) return;
    if (this.inflight === token) return; // its reply schedules the next
    this.timer = window.setTimeout(async () => {
      this.timer = undefined;
      this.inflight = token;
      let job: MachineCheckJob | undefined;
      let failure: { cause: unknown } | undefined;
      try {
        ({ check: job } = await read.call(
          link.client,
          this.projectId,
          this.machineId,
          following.id,
        ));
      } catch (cause) {
        failure = { cause };
      } finally {
        if (this.inflight === token) this.inflight = undefined;
      }
      // Only for the check it was sent for, while still followed.
      if (token !== this.token || this.state.following?.id !== following.id)
        return;
      if (failure) {
        this.notice("check", {
          error: `未能读取检查进度：${describeError(failure.cause)}`,
          message: "",
          retry: true,
        });
        return;
      }
      if (!job || job.id !== following.id) return;
      if (job.status === "running") {
        this.set({ following: { id: job.id, step: job.step } });
        this.poll();
      } else this.end(job);
    }, link.pollMs);
  }
  /** Tests: stop timers of a page that is going away. */
  dispose() {
    this.stopPolling();
    window.clearTimeout(this.notices.check);
    window.clearTimeout(this.notices.drain);
  }
  retryProgress = () => {
    if (!this.state.check.retry) return;
    this.notice("check", blank);
    this.poll();
  };

  private follow(job: { id: string; step: string }) {
    if (this.ended.has(job.id)) return;
    const current = this.state.following;
    if (current?.id === job.id) {
      if (current.step !== job.step)
        this.set({ following: { id: job.id, step: job.step } });
      return;
    }
    // Another check: the previous one's replies and progress error go.
    this.stopPolling();
    this.set({
      following: { id: job.id, step: job.step },
      ...(this.state.check.retry ? { check: blank } : {}),
    });
    this.poll();
  }

  /**
   * The one way a check ends, from its progress read, a detail read or the
   * start reply. Applies only to the followed check or one seen running
   * after an unknown request; an older check ending never touches a newer
   * followed one, its token or its feedback.
   */
  private end(
    job: {
      id: string;
      status: string;
      failed_steps: readonly string[];
    },
    fromReply = false,
  ) {
    const { following, unknownCheck } = this.state;
    const current = following?.id === job.id;
    const seen = unknownCheck?.seen.includes(job.id) ?? false;
    if (!current && !seen && !fromReply) return;
    this.ended.add(job.id);
    if (following && !current) {
      if (seen && unknownCheck)
        this.set({
          unknownCheck: {
            ...unknownCheck,
            seen: unknownCheck.seen.filter((id) => id !== job.id),
          },
        });
      return;
    }
    if (current) this.stopPolling();
    const passed = job.status === "passed";
    const steps =
      job.failed_steps.map(checkStepLabel).join("、") || "原因未记录";
    // Seen after an unknown request: the machine's result, by it or not.
    const text = seen
      ? passed
        ? "这台机器最近一次检查：通过"
        : `这台机器最近一次检查：未通过（${steps}）`
      : passed
        ? "检查通过"
        : `检查未通过：${steps}`;
    this.set({
      following: undefined,
      ...(seen ? { unknownCheck: undefined } : {}),
    });
    this.notice("check", {
      error: passed ? "" : text,
      message: passed ? text : "",
      retry: false,
    });
    this.reread();
  }

  /** An allowed detail read, started at page tick `at`. */
  observe(machine: MachineView, at: number) {
    const running = runningCheck(machine);
    if (running && !this.ended.has(running.id)) {
      this.follow(running);
      const unknown = this.state.unknownCheck;
      if (unknown && at > unknown.at && !unknown.seen.includes(running.id))
        this.set({
          unknownCheck: { ...unknown, seen: [...unknown.seen, running.id] },
        });
    }
    for (const record of machine.bindings.map((b) => b.last_requested_check))
      if (record && record.status !== "running")
        this.end({
          id: record.id,
          status: record.status === "failed" ? "failed" : "passed",
          failed_steps: record.failed_steps,
        });
    const drain = this.state.unknownDrain;
    const target = drain?.op === "drain" ? "draining" : "online";
    if (drain && at > drain.at && machine.status === target) {
      this.set({ unknownDrain: undefined });
      this.notice("drain", {
        error: "",
        message:
          drain.op === "drain"
            ? "当前已排空，不再接收新任务"
            : "当前已恢复接收新任务",
        retry: false,
      });
    }
  }

  /**
   * 立即检查. `again`: the confirmed new check after an unknown one (5b);
   * the drawer offers it only after an allowed read with nothing running.
   */
  async start(client: CardiganClient, again = false) {
    const post = client.checkMachine;
    const { sending, following, unknownCheck } = this.state;
    if (!post || sending || following) return;
    if (unknownCheck ? !again : again) return;
    window.clearTimeout(this.notices.check);
    this.set({ sending: "check", unknownCheck: undefined, check: blank });
    try {
      const { check: job } = await post.call(
        client,
        this.projectId,
        this.machineId,
        crypto.randomUUID(),
      );
      this.set({ sending: undefined });
      if (job.status === "running") this.follow(job);
      else this.end(job, true);
    } catch (cause) {
      if (uncertain(cause))
        this.set({
          sending: undefined,
          unknownCheck: { at: machineReadTick(), seen: [] },
        });
      else {
        this.set({ sending: undefined });
        this.notice("check", {
          error: `未能开始检查：${describeError(cause)}`,
          message: "",
          retry: false,
        });
      }
      this.reread();
    }
  }

  /**
   * 排空/恢复. While one is unknown only the same direction may be sent:
   * it cannot undo that request, and repeating it changes nothing if that
   * one took effect.
   */
  async drain(client: CardiganClient, on: boolean) {
    const post = client.setMachineDrain;
    const op = on ? "drain" : "resume";
    const { sending, unknownDrain } = this.state;
    if (!post || sending) return;
    if (unknownDrain && unknownDrain.op !== op) return;
    const what = on ? "排空" : "恢复";
    window.clearTimeout(this.notices.drain);
    this.set({ sending: op, drain: blank });
    try {
      await post.call(
        client,
        this.projectId,
        this.machineId,
        on,
        crypto.randomUUID(),
      );
      this.set({ sending: undefined, unknownDrain: undefined });
      this.notice("drain", {
        error: "",
        message: on ? "已排空，不再接收新任务" : "已恢复接收新任务",
        retry: false,
      });
    } catch (cause) {
      if (uncertain(cause))
        this.set({
          sending: undefined,
          unknownDrain: { at: machineReadTick(), op },
        });
      else {
        this.set({ sending: undefined });
        this.notice("drain", {
          error: `未能${what}：${describeError(cause)}`,
          message: "",
          retry: false,
        });
      }
    }
    this.reread();
  }
}

const stores = new Map<string, MachineActions>();
/** The page's one action state for this project's machine. */
export function machineActions(projectId: string, machineId: string) {
  const key = storageKey(projectId, machineId);
  let store = stores.get(key);
  if (!store) {
    store = new MachineActions(projectId, machineId);
    stores.set(key, store);
  }
  return store;
}
/** Tests: forget the page state, as a reload does (storage is kept). */
export function resetMachineActions() {
  for (const store of stores.values()) store.dispose();
  stores.clear();
  memory.clear();
  clock = 0;
}
