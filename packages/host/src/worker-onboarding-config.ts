import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import { basename, dirname, posix } from "node:path";
import { HC_RELEASE } from "@cardigan/runtime-herdr";
import { parse } from "yaml";
import { CpuProfileDirectory } from "./cpu-profile-files.js";
import {
  parseRuntimeWorkers,
  type RuntimeWorker,
} from "./runtime-workers-config.js";

export class WorkerOnboardingError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export const onboardingFail = (code: string): never => {
  throw new WorkerOnboardingError(code);
};
export function onboardingObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return onboardingFail("worker_config_invalid");
  return value as Record<string, unknown>;
}
export function onboardingDigest(value: unknown): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, canonical(x)]),
          )
        : v;
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

/** Reuse the host's pinned-directory and private-file boundary; never echo input. */
export function readOnboardingYaml(file: string): unknown | undefined {
  const dir = new CpuProfileDirectory(dirname(file));
  let fd: number | undefined;
  try {
    try {
      fd = openSync(
        dir.at(basename(file)),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const s = fstatSync(fd);
    if (
      !s.isFile() ||
      s.uid !== process.getuid?.() ||
      s.nlink !== 1 ||
      (s.mode & 0o7777) !== 0o600 ||
      s.size > 65536
    )
      return onboardingFail("worker_private_file_invalid");
    const buffer = Buffer.alloc(65537);
    const count = readSync(fd, buffer);
    const after = fstatSync(fd),
      named = lstatSync(dir.at(basename(file)));
    if (
      count !== s.size ||
      after.size !== s.size ||
      after.mtimeMs !== s.mtimeMs ||
      after.ctimeMs !== s.ctimeMs ||
      named.ino !== s.ino ||
      named.dev !== s.dev
    )
      return onboardingFail("worker_private_file_invalid");
    dir.verify();
    return parse(buffer.subarray(0, count).toString("utf8"));
  } finally {
    if (fd !== undefined) closeSync(fd);
    dir.close();
  }
}

export interface WorkerOnboardingConfig {
  readonly runtime: { version: 1; machines: Record<string, unknown>[] };
  readonly worker: RuntimeWorker;
  readonly uid: number;
  readonly home: string;
  readonly mcp_url: string;
  readonly hc_version: string;
  readonly timeout_ms: number;
  readonly digest: string;
}

export function parseWorkerOnboarding(
  value: unknown,
  dataDir: string,
): WorkerOnboardingConfig {
  try {
    const raw = onboardingObject(value);
    if (
      raw.version !== 1 ||
      Object.keys(raw).some(
        (k) =>
          ![
            "version",
            "runtime",
            "uid",
            "home",
            "mcp_url",
            "hc_version",
            "timeout_ms",
          ].includes(k),
      )
    )
      return onboardingFail("worker_config_invalid");
    const runtime = onboardingObject(raw.runtime);
    const workers = parseRuntimeWorkers(runtime, dataDir);
    const worker = workers[0];
    if (
      !worker ||
      workers.length !== 1 ||
      !Array.isArray(runtime.machines) ||
      runtime.machines.length !== 1 ||
      worker.machine_id === "local" ||
      worker.os !== "linux" ||
      !["x64", "arm64"].includes(worker.arch)
    )
      return onboardingFail("worker_config_invalid");
    if (
      !Number.isSafeInteger(raw.uid) ||
      (raw.uid as number) <= 0 ||
      typeof raw.home !== "string" ||
      !/^\/[A-Za-z0-9._/-]+$/u.test(raw.home) ||
      posix.normalize(raw.home) !== raw.home ||
      raw.home === "/" ||
      raw.home.endsWith("/")
    )
      return onboardingFail("worker_config_invalid");
    const e = worker.execution;
    if (
      !e.user ||
      !e.gid ||
      !e.fileHelper ||
      !e.gitHelper ||
      posix.dirname(e.fileHelper.path) !== `${e.agentRoot}/libexec` ||
      posix.dirname(e.gitHelper.path) !== `${e.agentRoot}/libexec` ||
      e.fileHelper.python !== e.gitHelper.python
    )
      return onboardingFail("worker_helpers_required");
    const home = raw.home;
    if (
      [e.agentRoot, dataDir].some(
        (p) =>
          p === home || p.startsWith(`${home}/`) || home.startsWith(`${p}/`),
      )
    )
      return onboardingFail("worker_config_invalid");
    const url = new URL(String(raw.mcp_url));
    if (
      url.protocol !== "https:" ||
      !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+\.ts\.net$/u.test(url.hostname) ||
      url.username ||
      url.password ||
      url.port ||
      url.pathname !== "/mcp" ||
      url.search ||
      url.hash
    )
      return onboardingFail("worker_mcp_url_invalid");
    const hc_version = raw.hc_version ?? HC_RELEASE.version;
    const timeout_ms = raw.timeout_ms ?? 15000;
    if (
      typeof hc_version !== "string" ||
      !/^\d+\.\d+\.\d+$/u.test(hc_version) ||
      !Number.isSafeInteger(timeout_ms) ||
      (timeout_ms as number) < 1000 ||
      (timeout_ms as number) > 60000
    )
      return onboardingFail("worker_config_invalid");
    const config = {
      runtime: runtime as WorkerOnboardingConfig["runtime"],
      worker,
      uid: raw.uid as number,
      home,
      mcp_url: url.href,
      hc_version,
      timeout_ms: timeout_ms as number,
    };
    return { ...config, digest: onboardingDigest(config) };
  } catch (error) {
    if (error instanceof WorkerOnboardingError) throw error;
    return onboardingFail("worker_config_invalid");
  }
}

/** Validate a hypothetical merge, but never write the live configuration. */
export function checkWorkerDraft(
  config: WorkerOnboardingConfig,
  current: unknown,
  dataDir: string,
): void {
  if (current === undefined) return;
  try {
    parseRuntimeWorkers(current, dataDir);
    const raw = onboardingObject(current);
    const machines = (raw.machines as Record<string, unknown>[]).map((m) => ({
      ...m,
    }));
    const incoming = config.runtime.machines[0] as Record<string, unknown>;
    const existing = machines.find((m) => m.id === incoming.id);
    if (!existing) machines.push(incoming);
    else {
      const { projects: oldProjects, ...oldIdentity } = existing;
      const { projects: newProjects, ...newIdentity } = incoming;
      if (onboardingDigest(oldIdentity) !== onboardingDigest(newIdentity))
        onboardingFail("worker_config_conflict");
      const projects = [...(oldProjects as Record<string, unknown>[])];
      const binding = (newProjects as Record<string, unknown>[])[0] as Record<
        string,
        unknown
      >;
      const old = projects.find(
        (p) => p.project_id === config.worker.project_id,
      );
      if (old && onboardingDigest(old) !== onboardingDigest(binding))
        onboardingFail("worker_config_conflict");
      if (!old) projects.push(binding);
      existing.projects = projects;
    }
    parseRuntimeWorkers({ ...raw, machines }, dataDir);
  } catch {
    onboardingFail("worker_config_conflict");
  }
}
