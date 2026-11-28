import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Clock } from "@cardigan/domain";
import {
  HttpRejection,
  methodNotAllowed,
  readJsonBody,
  sendJson,
} from "./http.js";
import { LoginLimiter } from "./login-limiter.js";
import { encodeQr, qrTerminalRows } from "./qr.js";

/**
 * C-705: one-time pairing codes for a new device that has no account yet.
 *
 * The device posts what it knows about itself to `POST /api/device-pairings`
 * (no session; reached over the tailnet like the Workbench itself) and gets a
 * code that is valid for ten minutes, a QR code of the Workbench confirmation
 * link and a token to poll its own status. The owner submits the code from a
 * signed-in session; a valid code only becomes a draft of the existing
 * add-worker wizard (`WorkerWizards`), which then goes through its usual
 * preview, confirmation and checks.
 *
 * Codes and tokens live only in this process and only as SHA-256 digests;
 * they travel in request bodies and the URL fragment, never in a path, query,
 * log line, event or timeline entry. A restart forgets every pairing.
 *
 * C-706: once claimed, the device keeps its token for `PAIRING_INIT_WINDOW_MS`
 * to fetch the one-time initialisation script of its wizard draft (after the
 * owner confirmed it) and to report the result, which triggers the wizard's
 * recheck. The token is never part of the script.
 */

export const PAIRING_TTL_MS = 10 * 60_000;
/** How long a used or expired code is still recognised as such. */
export const PAIRING_RETENTION_MS = 30 * 60_000;
export const PAIRING_MAX_PENDING = 16;
/** How long after the claim the device may fetch its script and report. */
export const PAIRING_INIT_WINDOW_MS = 60 * 60_000;
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE = new RegExp(`^[${ALPHABET}]{8}$`, "u");

export interface PairingDevice {
  readonly hostname: string;
  readonly os: "linux" | "darwin";
  readonly arch: "x64" | "arm64";
  /** Tailnet DNS name or address the control host reaches it by. */
  readonly address: string;
  /** A numeric id free as both user and group id on the device. */
  readonly free_id: number;
  readonly system?: string;
  /** C-706: `/` is mounted read-only (SteamOS); the work root goes to /home. */
  readonly root_readonly?: boolean;
  /**
   * C-707: hardware the device reports about itself, for the onboarding
   * report only. Self-reported and unverified; nothing is decided on it.
   */
  readonly cpu?: string;
  readonly cpu_cores?: number;
  readonly memory_bytes?: number;
  /**
   * C-843: the volumes the work root can go on, each listed once; a path on
   * the same volume as `/` is left out. The report picks the work root's.
   */
  readonly disks?: readonly PairingDisk[];
  readonly gpu?: string;
}
const DISK_PATHS = ["/", "/home", "/srv", "/Users"] as const;
type DiskPath = (typeof DISK_PATHS)[number];
export interface PairingDisk {
  readonly path: DiskPath;
  readonly total_bytes: number;
  readonly free_bytes: number;
}
/** Printable text of at most `max` characters, trimmed. */
const factText = (value: unknown, max: number) =>
  typeof value === "string" &&
  !!value.trim() &&
  value.length <= max &&
  !/\p{C}/u.test(value);
const factCount = (value: unknown, min: number) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min;
/** C-706: what the wizard says about a claimed device's initialisation. */
export type DeviceInitState = "waiting" | "ready" | "succeeded" | "unavailable";
export interface DeviceInitHooks {
  state(wizard: string): DeviceInitState;
  /** The script; throws an `HttpRejection` when it cannot be generated. */
  script(wizard: string): string;
  /** Records the device's report; whether a wizard recheck started. */
  completed(wizard: string, ok: boolean): "started" | "skipped";
}
export interface Pairing {
  /** Random id for audit records; unrelated to the code. */
  readonly id: string;
  readonly device: PairingDevice;
  readonly created: number;
  readonly expires: number;
  state: "pending" | "claimed";
}
interface Entry extends Pairing {
  readonly code: string;
  readonly token: string;
  /** The wizard draft it became, and when. */
  wizard?: string;
  claimed?: number;
}

const digest = (value: string) =>
  createHash("sha256").update(`device-pairing:${value}`).digest("hex");
const invalidDevice = () =>
  new HttpRejection(400, "validation_failed", "设备信息无效");

function parseDisk(
  path: unknown,
  total: unknown,
  free: unknown,
): PairingDisk | undefined {
  return DISK_PATHS.includes(path as DiskPath) &&
    factCount(total, 1) &&
    factCount(free, 0) &&
    (free as number) <= (total as number)
    ? {
        path: path as DiskPath,
        total_bytes: total as number,
        free_bytes: free as number,
      }
    : undefined;
}
/** Well-formed volumes, one per path; the rest are dropped. */
function parseDisks(v: Record<string, unknown>): PairingDisk[] {
  const { disks, disk_path, disk_total_bytes, disk_free_bytes } = v;
  const entry = (d: unknown) => {
    const e = d as Record<string, unknown> | null;
    return typeof e === "object" &&
      e !== null &&
      !Array.isArray(e) &&
      Object.keys(e).length === 3
      ? parseDisk(e.path, e.total_bytes, e.free_bytes)
      : undefined;
  };
  const listed = Array.isArray(disks)
    ? disks.slice(0, 16).map(entry)
    : [parseDisk(disk_path, disk_total_bytes, disk_free_bytes)];
  const out: PairingDisk[] = [];
  for (const d of listed)
    if (d && !out.some((o) => o.path === d.path)) out.push(d);
  return out;
}

export function parseDevice(value: unknown): PairingDevice {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw invalidDevice();
  const v = value as Record<string, unknown>;
  const keys = [
    "hostname",
    "os",
    "arch",
    "address",
    "free_id",
    "system",
    "root_readonly",
    "cpu",
    "cpu_cores",
    "memory_bytes",
    "disks",
    // C-707 scripts reported one volume; still accepted.
    "disk_path",
    "disk_total_bytes",
    "disk_free_bytes",
    "gpu",
  ];
  if (Object.keys(v).some((k) => !keys.includes(k))) throw invalidDevice();
  const { hostname, os, arch, address, free_id, system, root_readonly } = v;
  // C-707: a malformed hardware fact is dropped, never a reason to refuse
  // the pairing: the report only shows it as not reported.
  const { cpu, cpu_cores, memory_bytes, gpu } = v;
  const disks = parseDisks(v);
  if (
    typeof hostname !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/u.test(hostname) ||
    (os !== "linux" && os !== "darwin") ||
    (arch !== "x64" && arch !== "arm64") ||
    typeof address !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/u.test(address) ||
    typeof free_id !== "number" ||
    !Number.isSafeInteger(free_id) ||
    free_id < 501 ||
    free_id > 2147483647 ||
    (system !== undefined &&
      (typeof system !== "string" ||
        !system.trim() ||
        system.length > 80 ||
        /\p{C}/u.test(system))) ||
    (root_readonly !== undefined && typeof root_readonly !== "boolean")
  )
    throw invalidDevice();
  return {
    hostname,
    os,
    arch,
    address,
    free_id,
    ...(system === undefined ? {} : { system: system.trim() }),
    ...(root_readonly === true ? { root_readonly } : {}),
    ...(factText(cpu, 120) ? { cpu: (cpu as string).trim() } : {}),
    ...(factCount(cpu_cores, 1) && (cpu_cores as number) <= 4096
      ? { cpu_cores: cpu_cores as number }
      : {}),
    ...(factCount(memory_bytes, 1)
      ? { memory_bytes: memory_bytes as number }
      : {}),
    ...(disks.length ? { disks } : {}),
    ...(factText(gpu, 160) ? { gpu: (gpu as string).trim() } : {}),
  };
}
/** `ABCD-EFGH` style input to the stored form, or undefined when malformed. */
export function normalizeCode(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 32) return undefined;
  const code = value.replace(/[\s-]/gu, "").toUpperCase();
  return CODE.test(code) ? code : undefined;
}
const display = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

export class DevicePairings {
  private readonly byCode = new Map<string, Entry>();
  private readonly byToken = new Map<string, Entry>();
  /** Wrong codes per member, with the login lockout rules. */
  private readonly guesses = new LoginLimiter();
  private hooks: DeviceInitHooks | undefined;
  constructor(
    private readonly clock: Clock,
    private readonly enabled: boolean,
  ) {}
  private now() {
    return Date.parse(this.clock.now());
  }
  /** C-706: the wizard answers for claimed devices. */
  attach(hooks: DeviceInitHooks) {
    this.hooks = hooks;
  }
  private prune(now: number) {
    for (const [key, e] of this.byCode)
      if (
        e.created + PAIRING_RETENTION_MS <= now &&
        (e.claimed === undefined || e.claimed + PAIRING_INIT_WINDOW_MS <= now)
      ) {
        this.byCode.delete(key);
        this.byToken.delete(e.token);
      }
  }
  /** Number of pending, unexpired pairings (tests). */
  pending(): number {
    const now = this.now();
    return [...this.byCode.values()].filter(
      (e) => e.state === "pending" && e.expires > now,
    ).length;
  }

  create(device: PairingDevice, origin: string) {
    const now = this.now();
    this.prune(now);
    if (
      [...this.byCode.values()].filter(
        (e) => e.state === "pending" && e.expires > now,
      ).length >= PAIRING_MAX_PENDING
    )
      throw new HttpRejection(
        429,
        "pairing_capacity",
        "待确认的配对过多，请稍后再试",
      );
    let code: string;
    do
      code = Array.from(
        { length: 8 },
        () => ALPHABET[randomInt(ALPHABET.length)],
      ).join("");
    while (this.byCode.has(digest(code)));
    const token = randomBytes(32).toString("base64url");
    const entry: Entry = {
      id: randomUUID(),
      device,
      created: now,
      expires: now + PAIRING_TTL_MS,
      state: "pending",
      code: digest(code),
      token: digest(token),
    };
    this.byCode.set(entry.code, entry);
    this.byToken.set(entry.token, entry);
    // The code sits in the fragment, which browsers never send to a server.
    const confirm_url = `${origin}/#/pair/${display(code)}`;
    const qr = encodeQr(confirm_url);
    return {
      code: display(code),
      device_token: token,
      expires_at: new Date(entry.expires).toISOString(),
      confirm_url,
      qr: qr ? qrTerminalRows(qr) : null,
    };
  }

  status(token: unknown) {
    const now = this.now();
    this.prune(now);
    const entry =
      typeof token === "string" && token.length <= 128
        ? this.byToken.get(digest(token))
        : undefined;
    if (!entry) throw new HttpRejection(404, "pairing_not_found", "没有此配对");
    return {
      status:
        entry.state === "claimed"
          ? "claimed"
          : entry.expires <= now
            ? "expired"
            : "pending",
      expires_at: new Date(entry.expires).toISOString(),
      ...(entry.state === "claimed" && entry.wizard && this.hooks
        ? { init: this.hooks.state(entry.wizard) }
        : {}),
    };
  }
  /** The claimed entry for a device token, with its wizard. */
  private claimedBy(token: unknown) {
    this.prune(this.now());
    const entry =
      typeof token === "string" && token.length <= 128
        ? this.byToken.get(digest(token))
        : undefined;
    if (!entry) throw new HttpRejection(404, "pairing_not_found", "没有此配对");
    if (entry.state !== "claimed" || !entry.wizard || !this.hooks)
      throw new HttpRejection(409, "device_init_not_ready", "尚未确认配对");
    return { wizard: entry.wizard, hooks: this.hooks };
  }

  /**
   * The pending pairing for `code`, without using it. Callers that act on it
   * must call `claim` in the same synchronous turn, so two concurrent
   * submissions of one code cannot both succeed.
   */
  lookup(code: unknown, member: string): Pairing {
    const now = this.now();
    this.prune(now);
    const key = `pair:${member}`;
    const wait = this.guesses.retryAfterSeconds(key, now);
    if (wait !== undefined)
      throw new HttpRejection(
        429,
        "pairing_rate_limited",
        "配对码错误次数过多，请稍后再试",
        undefined,
        { "Retry-After": String(wait) },
      );
    const normalized = normalizeCode(code);
    const entry = normalized ? this.byCode.get(digest(normalized)) : undefined;
    if (!entry) {
      this.guesses.recordFailure(key, now);
      throw new HttpRejection(404, "pairing_code_invalid", "配对码不存在");
    }
    if (entry.state === "claimed")
      throw new HttpRejection(409, "pairing_code_used", "配对码已使用");
    if (entry.expires <= now)
      throw new HttpRejection(410, "pairing_code_expired", "配对码已过期");
    this.guesses.recordSuccess(key);
    return entry;
  }
  claim(pairing: Pairing, wizard: string) {
    const now = this.now();
    if (pairing.state !== "pending" || pairing.expires <= now)
      throw new HttpRejection(409, "pairing_code_used", "配对码已使用");
    pairing.state = "claimed";
    Object.assign(pairing as Entry, { wizard, claimed: now });
  }

  /** `POST /api/device-pairings[/status|/init-script|/initialized]`, called by the device itself. */
  async serveDevice(req: IncomingMessage, res: ServerResponse, rest: string) {
    if (!["", "/status", "/init-script", "/initialized"].includes(rest))
      throw new HttpRejection(404, "not_found", "not found");
    if (req.method !== "POST") methodNotAllowed(["POST"]);
    if (!this.enabled)
      throw new HttpRejection(503, "unavailable", "配对服务不可用");
    const body = await readJsonBody(req, 4096);
    if (rest === "/status") {
      if (Object.keys(body).some((k) => k !== "device_token"))
        throw invalidDevice();
      return sendJson(res, 200, this.status(body.device_token));
    }
    if (rest === "/init-script") {
      if (Object.keys(body).some((k) => k !== "device_token"))
        throw invalidDevice();
      const { wizard, hooks } = this.claimedBy(body.device_token);
      return sendJson(
        res,
        200,
        { script: hooks.script(wizard) },
        { "Cache-Control": "no-store" },
      );
    }
    if (rest === "/initialized") {
      if (
        Object.keys(body).some((k) => k !== "device_token" && k !== "ok") ||
        typeof body.ok !== "boolean"
      )
        throw invalidDevice();
      const { wizard, hooks } = this.claimedBy(body.device_token);
      return sendJson(res, 200, { recheck: hooks.completed(wizard, body.ok) });
    }
    if (Object.keys(body).some((k) => k !== "device")) throw invalidDevice();
    // `requireOrigin` already accepted it: the address the device used.
    const origin = req.headers.origin as string;
    return sendJson(res, 201, this.create(parseDevice(body.device), origin), {
      "Cache-Control": "no-store",
    });
  }
}

/**
 * Wizard form fields from a paired device. The owner still reviews them in the
 * wizard's preview; nothing here bypasses its validation.
 */
export function pairingForm(
  device: PairingDevice,
  project: string,
  mcpUrl: string | undefined,
) {
  // `parseDevice` admits only `[A-Za-z0-9][A-Za-z0-9-]*`; `local` is reserved.
  const home =
    device.os === "linux" &&
    (device.root_readonly === true || /steamos/iu.test(device.system ?? ""));
  const host = device.hostname.toLowerCase();
  const machine = host === "local" ? "device-local" : host;
  const account =
    `cg_${project.toLowerCase().replace(/[^a-z0-9_]/gu, "_")}`.slice(0, 29);
  return {
    machine_id: machine,
    label: device.hostname,
    os: device.os,
    arch: device.arch,
    host: device.address,
    port: 22,
    account,
    uid: device.free_id,
    gid: device.free_id,
    ...(mcpUrl === undefined ? {} : { mcp_url: mcpUrl }),
    ...(home ? { layout: "home" } : {}),
  };
}
