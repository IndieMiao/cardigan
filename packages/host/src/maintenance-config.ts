import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { parseDocument } from "yaml";
import { requireHostDirectory } from "./deployment-config.js";

/** C-390: default wait for running Runs and checks before the human decides. */
export const DEFAULT_MAINTENANCE_WAIT_MINUTES = 30;
export const DEFAULT_MAINTENANCE_POLL_SECONDS = 10;
export const DEFAULT_MAINTENANCE_READY_SECONDS = 300;

export interface MaintenanceHcTarget {
  readonly id: string;
  /** Path of the `hc` entry the runtime starts; an upgrade switches it. */
  readonly link?: string;
  /** Versioned installs live in `<install_root>/<version>/`. */
  readonly install_root?: string;
  /** Key of `deploy/hc-version.json` targets, e.g. `linux-x86_64`. */
  readonly platform?: string;
  /** Prefix that reaches the target's account or machine (sudo -u, ssh). */
  readonly via: readonly string[];
  /** The prefix hands one shell command line to the far side (ssh). */
  readonly via_shell: boolean;
  /** Registered worker machine this target belongs to. */
  readonly machine?: string;
  readonly stop?: readonly string[];
  readonly start?: readonly string[];
  /** Prints the version of the running core (socket hello). */
  readonly core_version?: readonly string[];
}

export interface MaintenanceConfig {
  readonly wait_timeout_ms: number;
  readonly poll_interval_ms: number;
  readonly server: {
    readonly stop: readonly string[];
    readonly start: readonly string[];
    readonly ports: readonly number[];
    readonly ready_timeout_ms: number;
  };
  readonly hc_targets: readonly MaintenanceHcTarget[];
}

const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/u;

function argv(value: unknown, name: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 64 ||
    !value.every(
      (a) => typeof a === "string" && a.length > 0 && !a.includes("\0"),
    ) ||
    !isAbsolute(value[0]) ||
    value[0] !== resolve(value[0])
  )
    throw new Error(`${name} 必须是以绝对路径程序开头的参数数组`);
  return value as string[];
}

function minutes(value: unknown, fallback: number, max: number, name: string) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > max)
    throw new Error(`${name} 超出范围`);
  return Number(value);
}

function absolute(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    value === "/" ||
    value !== resolve(value)
  )
    throw new Error(`${name} 必须是规范的绝对路径`);
  return value;
}

function only(value: Record<string, unknown>, keys: string[], name: string) {
  const extra = Object.keys(value).find((k) => !keys.includes(k));
  if (extra) throw new Error(`${name} 含未知配置项 ${extra}`);
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${name} 必须是对象`);
  return value as Record<string, unknown>;
}

export function parseMaintenanceConfig(raw: unknown): MaintenanceConfig {
  const value = object(raw, "maintenance.yaml");
  only(
    value,
    ["wait_timeout_minutes", "poll_interval_seconds", "server", "hc"],
    "maintenance.yaml",
  );
  const server = object(value.server, "server");
  only(server, ["stop", "start", "ports", "ready_timeout_seconds"], "server");
  const ports = server.ports ?? [];
  if (
    !Array.isArray(ports) ||
    ports.length > 8 ||
    !ports.every((p) => Number.isSafeInteger(p) && p >= 1 && p <= 65535)
  )
    throw new Error("server.ports 必须是端口数组");
  const hc = value.hc === undefined ? {} : object(value.hc, "hc");
  only(hc, ["targets"], "hc");
  const rawTargets = hc.targets ?? [];
  if (!Array.isArray(rawTargets) || rawTargets.length > 32)
    throw new Error("hc.targets 必须是数组");
  const ids = new Set<string>();
  const hc_targets = rawTargets.map((entry, i): MaintenanceHcTarget => {
    const t = object(entry, `hc.targets[${i}]`);
    only(
      t,
      [
        "id",
        "link",
        "install_root",
        "platform",
        "via",
        "via_shell",
        "machine",
        "stop",
        "start",
        "core_version",
      ],
      `hc.targets[${i}]`,
    );
    if (typeof t.id !== "string" || !ID.test(t.id) || ids.has(t.id))
      throw new Error(`hc.targets[${i}].id 无效或重复`);
    ids.add(t.id);
    const link = absolute(t.link, `${t.id}.link`);
    const install_root = absolute(t.install_root, `${t.id}.install_root`);
    if (!!link !== !!install_root)
      throw new Error(`${t.id} 的 link 和 install_root 必须同时配置`);
    if (
      t.platform !== undefined &&
      (typeof t.platform !== "string" ||
        !/^[a-z0-9_-]{1,40}$/u.test(t.platform))
    )
      throw new Error(`${t.id}.platform 无效`);
    if (link && t.platform === undefined)
      throw new Error(`${t.id} 配置了 link，需要同时写 platform`);
    if (t.via_shell !== undefined && typeof t.via_shell !== "boolean")
      throw new Error(`${t.id}.via_shell 必须是布尔值`);
    if (
      t.machine !== undefined &&
      (typeof t.machine !== "string" || !ID.test(t.machine))
    )
      throw new Error(`${t.id}.machine 无效`);
    if ((t.stop === undefined) !== (t.start === undefined))
      throw new Error(`${t.id} 的 stop 和 start 必须同时配置`);
    return {
      id: t.id,
      ...(link ? { link } : {}),
      ...(install_root ? { install_root } : {}),
      ...(typeof t.platform === "string" ? { platform: t.platform } : {}),
      via: t.via === undefined ? [] : argv(t.via, `${t.id}.via`),
      via_shell: t.via_shell === true,
      ...(typeof t.machine === "string" ? { machine: t.machine } : {}),
      ...(t.stop !== undefined ? { stop: argv(t.stop, `${t.id}.stop`) } : {}),
      ...(t.start !== undefined
        ? { start: argv(t.start, `${t.id}.start`) }
        : {}),
      ...(t.core_version !== undefined
        ? { core_version: argv(t.core_version, `${t.id}.core_version`) }
        : {}),
    };
  });
  return {
    wait_timeout_ms:
      minutes(
        value.wait_timeout_minutes,
        DEFAULT_MAINTENANCE_WAIT_MINUTES,
        24 * 60,
        "wait_timeout_minutes",
      ) * 60_000,
    poll_interval_ms:
      minutes(
        value.poll_interval_seconds,
        DEFAULT_MAINTENANCE_POLL_SECONDS,
        600,
        "poll_interval_seconds",
      ) * 1000,
    server: {
      stop: argv(server.stop, "server.stop"),
      start: argv(server.start, "server.start"),
      ports: ports as number[],
      ready_timeout_ms:
        minutes(
          server.ready_timeout_seconds,
          DEFAULT_MAINTENANCE_READY_SECONDS,
          3600,
          "server.ready_timeout_seconds",
        ) * 1000,
    },
    hc_targets,
  };
}

/** Host policy only, like self-deploy.yaml: owner-only file in a safe directory. */
export async function loadMaintenanceConfig(
  configDir: string,
): Promise<MaintenanceConfig> {
  const file = resolve(configDir, "maintenance.yaml");
  let source: string;
  try {
    await requireHostDirectory(dirname(file));
    const handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        ![0, process.getuid?.()].includes(stat.uid) ||
        stat.mode & 0o077 ||
        stat.size > 65536
      )
        throw new Error();
      source = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    throw new Error(
      `无法安全读取 ${file}：需由本账号所有、权限 0600，且所在目录不可被他人写入`,
    );
  }
  const doc = parseDocument(source, { uniqueKeys: true, strict: true });
  if (doc.errors.length || doc.warnings.length)
    throw new Error("maintenance.yaml 不是有效的 YAML");
  return parseMaintenanceConfig(doc.toJS({ maxAliasCount: 0 }));
}
