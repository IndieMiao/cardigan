/**
 * C-531: what one person is doing for this card (or work item / execution
 * row), as read from the server's `run_presence`. Only a Run the host
 * confirmed as running is "running"; waiting for a precheck never is.
 */
export type RunPresenceState =
  | "running"
  | "starting"
  | "queued"
  | "unknown"
  | "waiting"
  | "idle";
export type RunPresenceWaiting = "precheck" | "decision" | "blocked";
export interface RunPresence {
  readonly state: RunPresenceState;
  readonly waiting?: RunPresenceWaiting;
}

const UNKNOWN: RunPresence = { state: "unknown" };
const states = new Set<string>([
  "running",
  "starting",
  "queued",
  "unknown",
  "waiting",
  "idle",
]);
const waits = new Set<string>(["precheck", "decision", "blocked"]);

/** Missing or unrecognised facts are unknown, never idle. */
export function runPresence(value: unknown): RunPresence {
  if (!value || typeof value !== "object") return UNKNOWN;
  const { state, waiting } = value as { state?: unknown; waiting?: unknown };
  if (typeof state !== "string" || !states.has(state)) return UNKNOWN;
  if (state !== "waiting") return { state: state as RunPresenceState };
  return typeof waiting === "string" && waits.has(waiting)
    ? { state, waiting: waiting as RunPresenceWaiting }
    : UNKNOWN;
}

/** The status half of "姓名，状态". */
export function runPresenceText(presence: RunPresence): string {
  switch (presence.state) {
    case "running":
      return "正在为这张卡运行";
    // Dispatched to a machine, session not confirmed running yet: no ring.
    case "starting":
      return "正在启动";
    case "queued":
      return "已排队，等待机器";
    case "waiting":
      return presence.waiting === "decision"
        ? "等待拍板"
        : presence.waiting === "blocked"
          ? "已阻塞"
          : "等待预检";
    case "idle":
      return "已指派，当前无运行";
    default:
      return "运行状态未知";
  }
}

/** Tooltip and accessible name use this one string. */
export function runPresenceLabel(name: string, presence: RunPresence): string {
  return `${name}，${runPresenceText(presence)}`;
}

/** Only running and queued people get a ring; every other state is plain. */
export function runRing(presence: RunPresence): "running" | "queued" | null {
  return presence.state === "running" || presence.state === "queued"
    ? presence.state
    : null;
}
