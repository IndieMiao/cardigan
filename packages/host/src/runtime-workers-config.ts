import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, posix } from "node:path";
import type { Machine } from "@cardigan/domain";
import {
  type ExecutionConfig,
  validateSshConfig,
  workerPublishLimits,
} from "@cardigan/runtime-herdr";
import { parse } from "yaml";

export interface RuntimeWorker {
  readonly machine_id: string;
  readonly project_id: string;
  readonly os: Machine["os"];
  readonly arch: string;
  readonly session: string;
  readonly generation: string;
  readonly execution: Extract<ExecutionConfig, { mode: "agent-ssh" }>;
}
export const runtimeWorkersPath = (env: NodeJS.ProcessEnv = process.env) =>
  join(
    env.CARDIGAN_CONFIG_DIR ?? join(homedir(), ".config", "cardigan"),
    "runtime-workers.yaml",
  );
const invalid = (): never => {
  throw new Error("Runtime worker configuration invalid");
};
function object(value: unknown, keys: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.split(" ").includes(key))
  )
    return invalid();
  return value as Record<string, unknown>;
}
const list = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : invalid();
const str = (value: unknown): string =>
  typeof value === "string" && value.length > 0 ? value : invalid();
const id = (value: unknown): string => {
  const text = str(value);
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(text) ? text : invalid();
};
const path = (value: unknown): string => {
  const text = str(value);
  return /^\/[A-Za-z0-9._/-]+$/u.test(text) &&
    posix.normalize(text) === text &&
    text !== "/" &&
    !text.endsWith("/")
    ? text
    : invalid();
};
const overlaps = (a: string, b: string) =>
  a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

/** Private control-host input, unrelated to project files or merge-gate.yaml. */
export function parseRuntimeWorkers(
  value: unknown,
  dataDir: string,
): readonly RuntimeWorker[] {
  try {
    const raw = object(value, "version machines");
    if (raw.version !== 1) return invalid();
    const workers: RuntimeWorker[] = [];
    const machines = new Set<string>(),
      endpoints = new Set<string>(),
      aliases = new Set<string>();
    for (const entry of list(raw.machines)) {
      const m = object(
        entry,
        "id os arch host port identity_file known_hosts_file host_key_alias projects",
      );
      const machine_id = id(m.id),
        host = str(m.host);
      const endpoint = ["localhost", "127.0.0.1", "::1"].includes(
        host.toLowerCase(),
      )
        ? "loopback"
        : host.toLowerCase();
      if (machines.has(machine_id) || endpoints.has(endpoint)) return invalid();
      if (
        machine_id === "local" &&
        !["localhost", "127.0.0.1", "::1"].includes(host)
      )
        return invalid();
      machines.add(machine_id);
      endpoints.add(endpoint);
      if (!["linux", "darwin"].includes(str(m.os))) return invalid();
      const users = new Set<string>(),
        groups = new Set<number>(),
        projects = new Set<string>(),
        roots: string[] = [];
      for (const binding of list(m.projects)) {
        const p = object(
          binding,
          "project_id user gid alias session root path generation publication python file_helper",
        );
        const project_id = id(p.project_id),
          user = str(p.user),
          alias = str(p.alias);
        const session = str(p.session),
          root = path(p.root);
        if (
          projects.has(project_id) ||
          users.has(user) ||
          user === "root" ||
          groups.has(p.gid as number) ||
          aliases.has(alias) ||
          !/^[a-z][a-z0-9_-]{0,31}$/u.test(alias) ||
          alias === "local" ||
          !/^[A-Za-z0-9_-]{1,48}$/u.test(session) ||
          !Number.isSafeInteger(p.gid) ||
          (p.gid as number) <= 0 ||
          roots.some((other) => overlaps(root, other))
        )
          return invalid();
        projects.add(project_id);
        users.add(user);
        groups.add(p.gid as number);
        aliases.add(alias);
        roots.push(root);
        const execution: RuntimeWorker["execution"] = {
          mode: "agent-ssh",
          dataDir,
          agentRoot: root,
          gid: p.gid as number,
          machine: alias,
          host,
          user,
          port: m.port as number,
          identityFile: path(m.identity_file),
          knownHostsFile: path(m.known_hosts_file),
          hostKeyAlias: str(m.host_key_alias),
          path: str(p.path),
          ...(p.publication === undefined
            ? {}
            : { publication: workerPublishLimits(p.publication) }),
          ...(p.python === undefined && p.file_helper === undefined
            ? {}
            : {
                fileHelper: {
                  python: path(p.python),
                  path: path(p.file_helper),
                },
              }),
        };
        if (
          !Number.isInteger(m.port) ||
          overlaps(root, dataDir) ||
          overlaps(root, execution.identityFile) ||
          overlaps(root, execution.knownHostsFile)
        )
          return invalid();
        validateSshConfig(execution);
        workers.push({
          machine_id,
          project_id,
          os: m.os as Machine["os"],
          arch: id(m.arch),
          session,
          generation: id(p.generation),
          execution,
        });
      }
    }
    return workers;
  } catch {
    return invalid();
  }
}

/** Missing is compatible; malformed, linked or non-private input never falls back. */
export function loadRuntimeWorkers(
  dataDir: string,
  file = runtimeWorkersPath(),
): readonly RuntimeWorker[] {
  let fd: number;
  try {
    fd = openSync(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    return invalid();
  }
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o7777) !== 0o600 ||
      stat.uid !== process.getuid?.()
    )
      return invalid();
    return parseRuntimeWorkers(parse(readFileSync(fd, "utf8")), dataDir);
  } catch {
    return invalid();
  } finally {
    closeSync(fd);
  }
}
