import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { currentDeploymentPin, type Event } from "@cardigan/domain";
import type { Store } from "@cardigan/store";
import { deploymentDirectory } from "./deployment-config.js";
import type {
  MaintenancePhase,
  MaintenanceRecord,
} from "./deployment-maintenance.js";
import type {
  CommandResult,
  MaintenanceDriver,
  SoftwareState,
} from "./maintenance.js";
import { maintenanceActivity } from "./maintenance-activity.js";

const PROJECT = "cardigan";
const OUTPUT_LIMIT = 256 * 1024;
/** Captured steps (stop/start/helper) are bounded; the maintenance command itself is not. */
const CAPTURE_TIMEOUT_MS = 30 * 60 * 1000;
export const MAINTENANCE_AUDIT_EVENT = "host_maintenance_recorded";
export const MAINTENANCE_NOTICE_EVENT = "host_maintenance_notice";

export function runArgv(
  argv: readonly string[],
  options: { readonly input?: Uint8Array; readonly inherit?: boolean } = {},
): Promise<CommandResult> {
  const [command, ...args] = argv;
  if (!command) return Promise.resolve({ code: 127, stdout: "", stderr: "" });
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: options.inherit
        ? "inherit"
        : [options.input ? "pipe" : "ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    const timer = options.inherit
      ? undefined
      : setTimeout(() => child.kill("SIGTERM"), CAPTURE_TIMEOUT_MS);
    child.stdout?.on("data", (d: Buffer) => {
      if (stdout.length < OUTPUT_LIMIT) stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < OUTPUT_LIMIT) stderr += d.toString("utf8");
    });
    child.stdin?.on("error", () => {});
    if (options.input) child.stdin?.end(Buffer.from(options.input));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: stderr || error.message });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? (signal ? 128 : 1), stdout, stderr });
    });
  });
}

export function portOpen(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host });
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** The supervisor's own record of the running release; never a guess. */
export async function readSoftwareState(
  dataDir: string,
): Promise<SoftwareState> {
  try {
    const handle = await open(
      join(deploymentDirectory(dataDir), "state.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 65536)
        return { sha: null, process: null, ready: false };
      const state = JSON.parse(await handle.readFile("utf8")) as {
        current?: { sha?: unknown };
        running?: { sha?: unknown };
        process?: { pid?: unknown; start?: unknown };
        ready?: unknown;
      };
      const sha =
        typeof state.current?.sha === "string" &&
        /^[a-f0-9]{40}$/u.test(state.current.sha)
          ? state.current.sha
          : null;
      return {
        sha,
        process:
          state.process && typeof state.process.start === "string"
            ? `${String(state.process.pid)}:${state.process.start}`
            : null,
        ready:
          state.ready === true &&
          (state.running?.sha === undefined || state.running.sha === sha),
      };
    } finally {
      await handle.close();
    }
  } catch {
    return { sha: null, process: null, ready: false };
  }
}

export function deploymentPinOf(store: Store): string | null {
  const rows = store.database
    .prepare(
      "SELECT doc FROM events WHERE project_id = ? AND type = 'host_deployment_controlled' ORDER BY rowid",
    )
    .all(PROJECT) as { doc: string }[];
  const events = rows.map((r) => JSON.parse(r.doc) as Event);
  return currentDeploymentPin(events)?.sha ?? null;
}

/** Audit every step on the cardigan project; notices reach Needs You. */
export function appendMaintenanceAudit(
  store: Store,
  record: MaintenanceRecord,
  phase: MaintenancePhase,
  note: string,
  notice?: string,
  at = new Date().toISOString(),
) {
  if (!store.getProject(PROJECT)) return;
  store.uow.run((tx) => {
    tx.events.append(PROJECT, {
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence(PROJECT),
      type: MAINTENANCE_AUDIT_EVENT,
      actor: { kind: "human", project_id: PROJECT },
      created_at: at,
      payload: {
        maintenance_id: record.id,
        phase,
        note,
        operation: record.operation.kind,
        busy: record.busy.length,
      },
    });
    if (notice)
      tx.events.append(PROJECT, {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(PROJECT),
        type: MAINTENANCE_NOTICE_EVENT,
        actor: { kind: "system", project_id: PROJECT },
        created_at: at,
        payload: { maintenance_id: record.id, phase, notice },
      });
  });
}

export function nodeMaintenanceDriver(options: {
  readonly store: Store;
  readonly dataDir: string;
  readonly say: (line: string) => void;
}): MaintenanceDriver {
  return {
    now: () => new Date().toISOString(),
    sleep: (ms) => delay(ms),
    run: runArgv,
    activity: () => maintenanceActivity(options.store),
    software: () => readSoftwareState(options.dataDir),
    portOpen: (port) => portOpen(port),
    deployPin: () => deploymentPinOf(options.store),
    audit: (record, phase, note, notice) =>
      appendMaintenanceAudit(options.store, record, phase, note, notice),
    say: options.say,
  };
}
