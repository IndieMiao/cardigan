import { randomUUID } from "node:crypto";
import {
  type CpuProfileDirectory,
  CpuProfileError,
  cpuProfileFailure,
  cpuProfileRoot,
} from "./cpu-profile-files.js";
import { CpuProfileRecorder } from "./cpu-profile-recorder.js";

/** Q-646, answered by human: no automatic deletion or production activation. */
export const CPU_PROFILE_POLICY = Object.freeze({
  defaultSeconds: 60,
  minSeconds: 1,
  maxSeconds: 120,
  defaultIntervalUs: 1000,
  minIntervalUs: 1000,
  maxIntervalUs: 10000,
  maxFilesPerRole: 10,
  maxBytesPerRole: 128 * 1024 * 1024,
});
export const CPU_PROFILE_LIMITS = Object.freeze({
  minDurationMs: CPU_PROFILE_POLICY.minSeconds * 1000,
  maxDurationMs: CPU_PROFILE_POLICY.maxSeconds * 1000,
  minSamplingIntervalUs: CPU_PROFILE_POLICY.minIntervalUs,
  maxSamplingIntervalUs: CPU_PROFILE_POLICY.maxIntervalUs,
});
export type CpuProfileRole = "web" | "background";
interface Identity {
  role: CpuProfileRole;
  sha: string;
  pid: number;
  generation: string;
}
interface State {
  version: 1;
  identity: Identity;
  sequence: number;
  phase: "idle" | "recording" | "completed" | "failed" | "closed";
  file?: string;
  reason?: "duration" | "stopped";
  code?: string;
}
interface Request {
  version: 1;
  sequence: number;
  request_id: string;
  targets: Identity[];
  action: "start" | "stop";
  seconds: number;
  interval_us: number;
}
const uuid = (s: unknown) =>
  typeof s === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(s);
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const integer = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const isRole = (v: unknown): v is CpuProfileRole =>
  v === "web" || v === "background";
function identity(v: unknown): v is Identity {
  return (
    object(v) &&
    Object.keys(v).length === 4 &&
    isRole(v.role) &&
    typeof v.sha === "string" &&
    /^[0-9a-f]{40}$/u.test(v.sha) &&
    integer(v.pid) &&
    v.pid > 0 &&
    uuid(v.generation)
  );
}
const identical = (a: Identity, b: Identity) =>
  a.role === b.role &&
  a.sha === b.sha &&
  a.pid === b.pid &&
  a.generation === b.generation;
function parseState(value: unknown): State {
  if (
    !object(value) ||
    Object.keys(value).some(
      (k) =>
        ![
          "version",
          "identity",
          "sequence",
          "phase",
          "file",
          "reason",
          "code",
        ].includes(k),
    ) ||
    value.version !== 1 ||
    !identity(value.identity) ||
    !integer(value.sequence) ||
    !["idle", "recording", "completed", "failed", "closed"].includes(
      String(value.phase),
    ) ||
    (value.file !== undefined &&
      (typeof value.file !== "string" ||
        !/^cpu-[a-zA-Z0-9.-]+\.cpuprofile$/u.test(value.file))) ||
    (value.reason !== undefined &&
      !["duration", "stopped"].includes(String(value.reason))) ||
    (value.code !== undefined &&
      ![
        "unsafe",
        "unavailable",
        "busy",
        "invalid_request",
        "capacity",
        "io",
        "stale",
      ].includes(String(value.code)))
  )
    throw new CpuProfileError("unsafe");
  return value as unknown as State;
}
function parseRequest(value: unknown): Request | undefined {
  if (value === undefined) return undefined;
  if (
    !object(value) ||
    Object.keys(value).length !== 7 ||
    value.version !== 1 ||
    !integer(value.sequence) ||
    value.sequence < 1 ||
    !uuid(value.request_id) ||
    !Array.isArray(value.targets) ||
    value.targets.length < 1 ||
    value.targets.length > 2 ||
    !value.targets.every(identity) ||
    new Set(value.targets.map((t) => t.role)).size !== value.targets.length ||
    !["start", "stop"].includes(String(value.action)) ||
    !validCpuProfileValues(value.seconds, value.interval_us)
  )
    throw new CpuProfileError("invalid_request");
  return value as unknown as Request;
}
export function validCpuProfileValues(
  seconds: unknown,
  interval: unknown,
): boolean {
  return (
    integer(seconds) &&
    seconds >= CPU_PROFILE_POLICY.minSeconds &&
    seconds <= CPU_PROFILE_POLICY.maxSeconds &&
    integer(interval) &&
    interval >= CPU_PROFILE_POLICY.minIntervalUs &&
    interval <= CPU_PROFILE_POLICY.maxIntervalUs
  );
}

function quota(directory: CpuProfileDirectory, role: CpuProfileRole) {
  let count = 0,
    bytes = 0;
  for (const name of directory.entries()) {
    if (name === "owner.lock" || name === "state.json") {
      directory.size(name);
      continue;
    }
    // Unknown/crashed temporaries are preserved; inspection is a human action.
    if (name.startsWith("partial-")) throw new CpuProfileError("capacity");
    if (
      !new RegExp(
        `^cpu-${role}-[a-f0-9]{40}-[0-9]+-[0-9TZ.-]+-[a-f0-9-]{36}\\.cpuprofile$`,
        "u",
      ).test(name)
    )
      throw new CpuProfileError("unsafe");
    count++;
    bytes += directory.size(name);
  }
  if (
    count >= CPU_PROFILE_POLICY.maxFilesPerRole ||
    bytes >= CPU_PROFILE_POLICY.maxBytesPerRole
  )
    throw new CpuProfileError("capacity");
  return CPU_PROFILE_POLICY.maxBytesPerRole - bytes;
}

/** Host process only. No network listener and no configuration from a project. */
export class CpuProfileController {
  readonly #root: CpuProfileDirectory;
  readonly #directory: CpuProfileDirectory;
  readonly #lock: ReturnType<CpuProfileDirectory["lock"]>;
  readonly #identity: Identity;
  readonly #recorder: CpuProfileRecorder;
  readonly #notice: (code: string) => void;
  #sequence = 0;
  #active: Promise<void> | undefined;
  #closing: Promise<void> | undefined;
  #closed = false;
  #failure: string | undefined;

  constructor(options: {
    dataDir: string;
    role: CpuProfileRole;
    sha: string;
    recorder?: CpuProfileRecorder;
    notice?: (code: string) => void;
  }) {
    this.#identity = {
      role: options.role,
      sha: options.sha,
      pid: process.pid,
      generation: randomUUID(),
    };
    if (!identity(this.#identity)) throw new CpuProfileError("unavailable");
    this.#notice = options.notice ?? (() => {});
    this.#recorder =
      options.recorder ?? new CpuProfileRecorder(CPU_PROFILE_LIMITS);
    const root = cpuProfileRoot(options.dataDir, true);
    let directory: CpuProfileDirectory | undefined;
    let lock: ReturnType<CpuProfileDirectory["lock"]> | undefined;
    try {
      directory = root.child(options.role, true);
      lock = directory.lock(true);
      if (!lock.acquire()) throw new CpuProfileError("busy");
      directory.write("state.json", {
        version: 1,
        identity: this.#identity,
        sequence: 0,
        phase: "idle",
      });
      this.#root = root;
      this.#directory = directory;
      this.#lock = lock;
    } catch (error) {
      lock?.close();
      directory?.close();
      root.close();
      throw cpuProfileFailure(error);
    }
  }
  #state(phase: State["phase"], extra: Partial<State> = {}) {
    this.#lock.verify();
    this.#directory.write("state.json", {
      version: 1,
      identity: this.#identity,
      sequence: this.#sequence,
      phase,
      ...extra,
    });
  }
  #report(error: unknown) {
    const code = cpuProfileFailure(error).code;
    if (code !== this.#failure) {
      try {
        this.#notice(code);
      } catch {
        /* Logging cannot enable recording. */
      }
    }
    this.#failure = code;
  }
  /** Called only by an existing tick/request boundary; never installs a timer. */
  sync(): void {
    if (this.#closed) return;
    try {
      this.#lock.verify();
      const request = parseRequest(this.#root.read("request.json"));
      if (
        !request ||
        request.sequence <= this.#sequence ||
        !request.targets.some((t) => identical(t, this.#identity))
      )
        return;
      this.#sequence = request.sequence; // Consume before any async work, including failures.
      if (request.action === "stop") {
        if (this.#active) {
          this.#state("recording");
          void this.#recorder.stop();
        } else this.#state("idle");
        return;
      }
      if (this.#active) throw new CpuProfileError("busy");
      quota(this.#directory, this.#identity.role);
      this.#state("recording");
      this.#active = this.#capture(request).finally(() => {
        this.#active = undefined;
      });
      this.#failure = undefined;
    } catch (error) {
      this.#report(error);
      if (!this.#active) {
        try {
          this.#state("failed", { code: cpuProfileFailure(error).code });
        } catch {
          /* Fail closed. */
        }
      }
    }
  }
  async #capture(request: Request) {
    try {
      const result = await this.#recorder.record({
        durationMs: request.seconds * 1000,
        samplingIntervalUs: request.interval_us,
      });
      if (result.status !== "completed") throw new CpuProfileError("io");
      this.#lock.verify();
      const available = quota(this.#directory, this.#identity.role);
      const bytes = Buffer.from(JSON.stringify(result.profile));
      if (bytes.length > available) throw new CpuProfileError("capacity");
      const name = `cpu-${this.#identity.role}-${this.#identity.sha}-${this.#identity.pid}-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}.cpuprofile`;
      this.#directory.publish(name, bytes);
      this.#state("completed", { file: name, reason: result.reason });
    } catch (error) {
      this.#report(error);
      try {
        this.#state("failed", { code: cpuProfileFailure(error).code });
      } catch {
        /* No false success. */
      }
    }
  }
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#closing = (async () => {
      await this.#recorder.close();
      await this.#active; // Includes complete publication on graceful shutdown.
      try {
        if (!this.#active) this.#state("closed");
      } catch (error) {
        this.#report(error);
      } finally {
        this.#lock.close();
        this.#directory.close();
        this.#root.close();
      }
    })();
    return this.#closing;
  }
}

/** Human CLI helper: metadata only. Host account filesystem isolation is required. */
export function cpuProfileCommand(options: {
  dataDir: string;
  action: "status" | "start" | "stop";
  target: CpuProfileRole | "both";
  seconds?: number;
  intervalUs?: number;
}) {
  let root: CpuProfileDirectory | undefined;
  const opened: CpuProfileDirectory[] = [];
  let submit: ReturnType<CpuProfileDirectory["lock"]> | undefined;
  try {
    const seconds = options.seconds ?? CPU_PROFILE_POLICY.defaultSeconds;
    const interval_us =
      options.intervalUs ?? CPU_PROFILE_POLICY.defaultIntervalUs;
    if (!validCpuProfileValues(seconds, interval_us))
      throw new CpuProfileError("invalid_request");
    root = cpuProfileRoot(options.dataDir, false);
    const pinnedRoot = root;
    submit = root.lock(true);
    if (!submit.acquire()) throw new CpuProfileError("busy");
    const previous = parseRequest(root.read("request.json"));
    const targets =
      options.target === "both"
        ? (["web", "background"] as const)
        : [options.target];
    const states = targets.map((role) => {
      const directory = pinnedRoot.child(role, false);
      opened.push(directory);
      const lock = directory.lock(false);
      try {
        if (lock.acquire()) throw new CpuProfileError("stale");
      } finally {
        lock.close();
      }
      const state = parseState(directory.read("state.json"));
      if (state.identity.role !== role || state.phase === "closed")
        throw new CpuProfileError("stale");
      return state;
    });
    if (options.action === "status")
      return {
        states,
        pending:
          previous?.targets
            .filter((t) =>
              states.some(
                (s) =>
                  identical(t, s.identity) && s.sequence < previous.sequence,
              ),
            )
            .map((t) => t.role) ?? [],
      };
    // A shared atomic request must not erase a pending request for another role.
    if (previous) {
      for (const target of previous.targets) {
        if (targets.includes(target.role)) continue;
        const directory = pinnedRoot.child(target.role, false);
        opened.push(directory);
        const state = parseState(directory.read("state.json"));
        if (
          identical(target, state.identity) &&
          state.sequence < previous.sequence
        )
          throw new CpuProfileError("busy");
      }
    }
    if (
      options.action === "start" &&
      states.some(
        (s) =>
          s.phase === "recording" ||
          (previous?.targets.some((t) => identical(t, s.identity)) &&
            s.sequence < previous.sequence),
      )
    )
      throw new CpuProfileError("busy");
    const sequence =
      Math.max(previous?.sequence ?? 0, ...states.map((s) => s.sequence)) + 1;
    if (!integer(sequence)) throw new CpuProfileError("invalid_request");
    const request: Request = {
      version: 1,
      sequence,
      request_id: randomUUID(),
      targets: states.map((s) => s.identity),
      action: options.action,
      seconds,
      interval_us,
    };
    root.write("request.json", request);
    return {
      request_id: request.request_id,
      sequence,
      targets: request.targets.map((t) => t.role),
      action: request.action,
    };
  } catch (error) {
    throw cpuProfileFailure(error);
  } finally {
    submit?.close();
    for (const directory of opened) directory.close();
    root?.close();
  }
}
