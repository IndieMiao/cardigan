import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, realpathSync } from "node:fs";
import { release } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { type WorkerNativeConfig, workerNative } from "./worker-primitives.js";

export type CapabilityState = true | false | null;
export interface WorkerCapability {
  installed: CapabilityState;
  configured: CapabilityState;
  version: string | null;
  arch: string | null;
  path: string | null;
  resolved_path: string | null;
  last_verified: null | {
    at: string;
    uid: number;
    combination: string;
    evidence: string;
  };
}
export interface WorkerManifest {
  os: "linux" | "darwin";
  product_version: string;
  build: string;
  kernel: string;
  arch: string;
  uid: number;
  sampled_at: string;
  source: string;
  capabilities: Record<string, WorkerCapability>;
}
export interface WorkerRequirements {
  uid: number;
  os: WorkerManifest["os"];
  arch: "arm64" | "x64";
  /** Digest of the trusted target configuration, including PATH and HOME. */
  combination: string;
  harness: string;
  tools: Record<string, { version: string; arch: string }>;
  desktop: boolean;
}
const reference = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const date = (value: string) =>
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value));
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** Bind verification to every observed version/path/architecture, as well as target configuration. */
export function workerCombination(
  manifest: WorkerManifest,
  targetDigest: string,
): string {
  return digest(
    JSON.stringify([
      targetDigest,
      manifest.os,
      manifest.product_version,
      manifest.build,
      manifest.kernel,
      manifest.arch,
      manifest.uid,
      Object.entries(manifest.capabilities)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, c]) => [
          id,
          c.installed,
          c.configured,
          c.version,
          c.arch,
          c.path,
          c.resolved_path,
        ]),
    ]),
  );
}

/** Only trusted host observations enter this contract; never accept Agent claims. */
export function checkWorkerCapabilities(
  manifest: WorkerManifest,
  required: WorkerRequirements,
): string[] {
  const failures: string[] = [];
  const combination = workerCombination(manifest, required.combination);
  if (
    manifest.uid !== required.uid ||
    !Number.isSafeInteger(required.uid) ||
    required.uid <= 0 ||
    (required.os === "darwin" && required.arch !== "arm64") ||
    manifest.os !== required.os ||
    manifest.arch !== required.arch ||
    !date(manifest.sampled_at) ||
    !reference.test(manifest.source) ||
    !manifest.product_version ||
    !manifest.build ||
    !manifest.kernel ||
    !/^[a-f0-9]{64}$/.test(required.combination) ||
    !reference.test(required.harness)
  )
    failures.push("worker_identity");
  if (!required.tools[required.harness]) failures.push("harness_version");
  const nativeTools = ["node", "pnpm", "git", "python", "hc", required.harness];
  const tools = new Map<string, { version?: string; arch?: string }>(
    nativeTools.map((id) => [id, { arch: required.arch }]),
  );
  for (const [id, tool] of Object.entries(required.tools)) {
    if (
      !tool.version ||
      !["arm64", "x64", "universal"].includes(tool.arch) ||
      (nativeTools.includes(id) &&
        ![required.arch, "universal"].includes(tool.arch))
    )
      failures.push("tool_requirement");
    tools.set(id, tool);
  }
  if (required.os === "darwin") {
    for (const id of ["hc-signature", "noninteractive", "native-dependencies"])
      tools.set(id, {});
    if (
      required.arch === "x64" ||
      Object.values(required.tools).some((t) => t.arch === "x64")
    )
      tools.set("rosetta", {});
    if (required.desktop)
      for (const id of [
        "login",
        "unlocked",
        "window-server",
        "graphics-session",
        "metal",
        "screen-capture",
        "accessibility",
        "keychain",
      ])
        tools.set(id, {});
  }
  for (const [id, tool] of tools) {
    const value = manifest.capabilities[id];
    const verified = value?.last_verified;
    if (
      !reference.test(id) ||
      !value ||
      value.installed !== true ||
      value.configured !== true ||
      !verified ||
      verified.uid !== required.uid ||
      verified.combination !== combination ||
      !date(verified.at) ||
      Date.parse(verified.at) > Date.parse(manifest.sampled_at) ||
      !reference.test(verified.evidence) ||
      (tool.version && value.version !== tool.version) ||
      (tool.arch &&
        value.arch !== tool.arch &&
        !(value.arch === "universal" && tool.arch === required.arch))
    ) {
      failures.push(
        reference.test(id) ? `capability:${id}` : "invalid_capability",
      );
      continue;
    }
    if (
      (nativeTools.includes(id) || id in required.tools) &&
      (!value.path ||
        !value.resolved_path ||
        !isAbsolute(value.path) ||
        !isAbsolute(value.resolved_path) ||
        !value.version)
    )
      failures.push(`tool_path:${id}`);
    if (
      (id === "node" &&
        (!/^24\.\d+\.\d+$/.test(value.version ?? "") ||
          value.arch !== manifest.arch)) ||
      (id === "python" && !/^3\.\d+\.\d+$/.test(value.version ?? "")) ||
      (id === "git" && !/^\d+\.\d+\.\d+/.test(value.version ?? "")) ||
      (id === "pnpm" && value.version !== "11.7.0") ||
      (id === "hc" && value.version !== "0.1.18")
    )
      failures.push(`version:${id}`);
  }
  return failures;
}

/** Public evidence deliberately has no arbitrary diagnostic, HOME or real path. */
export function redactWorkerManifest(manifest: WorkerManifest) {
  const version = (value: string) =>
    /^[\w.+-]{1,100}$/.test(value) ? value : "unknown";
  return {
    os: manifest.os,
    product_version: version(manifest.product_version),
    build: version(manifest.build),
    kernel: version(manifest.kernel),
    arch: version(manifest.arch),
    uid: manifest.uid,
    sampled_at: date(manifest.sampled_at) ? manifest.sampled_at : null,
    source: reference.test(manifest.source) ? manifest.source : "unknown",
    capabilities: Object.fromEntries(
      Object.entries(manifest.capabilities).map(([id, value], index) => [
        reference.test(id) ? id : `unknown-${index}`,
        {
          installed: value.installed,
          configured: value.configured,
          reason:
            value.installed !== true
              ? "unavailable"
              : value.configured !== true
                ? "configuration_mismatch"
                : value.last_verified
                  ? null
                  : "unverified",
          version: /^[\w.+-]{1,100}(?: \(Apple Git-\d+\))?$/.test(
            value.version ?? "",
          )
            ? value.version
            : null,
          arch: ["arm64", "x64", "universal"].includes(value.arch ?? "")
            ? value.arch
            : null,
          path: value.path ? `<tool-path:${digest(value.path)}>` : null,
          resolved_path: value.resolved_path
            ? `<tool-path:${digest(value.resolved_path)}>`
            : null,
          last_verified:
            value.last_verified &&
            Number.isSafeInteger(value.last_verified.uid) &&
            value.last_verified.uid > 0 &&
            reference.test(value.last_verified.evidence) &&
            /^[a-f0-9]{64}$/.test(value.last_verified.combination) &&
            date(value.last_verified.at)
              ? {
                  at: value.last_verified.at,
                  uid: value.last_verified.uid,
                  combination: value.last_verified.combination,
                  evidence: value.last_verified.evidence,
                }
              : null,
        },
      ]),
    ),
  };
}

/** Run inside the target account. Does not promote sampling to verified evidence. */
export function sampleWorkerCapabilities(
  input: WorkerNativeConfig & {
    path: string;
    tools: Record<string, { path: string; resolved_path: string }>;
    hc_signature?: { app: string; team: string; identifier: string };
  },
): WorkerManifest {
  if (
    !isAbsolute(input.python) ||
    !Number.isSafeInteger(input.timeout_ms) ||
    input.timeout_ms <= 0 ||
    (process.platform === "darwin" &&
      ["/opt/homebrew/bin", "/usr/bin", "/bin"].some(
        (p) => !input.path.split(":").includes(p),
      )) ||
    !input.path.split(":").every((p) => isAbsolute(p))
  )
    throw new Error("Invalid worker sampling configuration");
  const env = { PATH: input.path, LC_ALL: "C", HOME: "" };
  const run = (command: string, args: string[]) =>
    execFileSync(command, args, {
      env,
      encoding: "utf8",
      timeout: input.timeout_ms,
      maxBuffer: 65536,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  try {
    env.HOME = run(input.python, [
      "-B",
      "-c",
      "import os,pwd; print(pwd.getpwuid(os.getuid()).pw_dir)",
    ]);
    if (
      !isAbsolute(env.HOME) ||
      !["linux", "darwin"].includes(process.platform)
    )
      throw new Error();
    const capabilities: WorkerManifest["capabilities"] = {};
    for (const [id, tool] of Object.entries(input.tools).sort(([a], [b]) =>
      a === "node" ? -1 : b === "node" ? 1 : a.localeCompare(b),
    )) {
      if (
        !reference.test(id) ||
        !isAbsolute(tool.path) ||
        !isAbsolute(tool.resolved_path)
      )
        throw new Error();
      const value: WorkerCapability = {
        installed: null,
        configured: null,
        version: null,
        arch: null,
        path: tool.path,
        resolved_path: null,
        last_verified: null,
      };
      try {
        value.resolved_path = realpathSync(tool.path);
        const native = workerNative<{
          arch: string | null;
          signed: boolean | null;
        }>(input, "tool", {
          path: value.resolved_path,
          node_arch: capabilities.node?.arch ?? null,
          timeout_ms: input.timeout_ms,
          signature: id === "hc" ? input.hc_signature : undefined,
        });
        value.arch = native.arch;
        if (id === "hc" && process.platform === "darwin") {
          capabilities["hc-signature"] = {
            ...value,
            path: null,
            resolved_path: null,
            installed: native.signed,
            configured: native.signed,
          };
          if (native.signed !== true) throw new Error();
        }
        value.version =
          /\bv?(\d+\.\d+\.\d+(?:[.+-][\w.+-]+)?(?: \(Apple Git-\d+\))?)(?:\s|$)/.exec(
            run(tool.path, ["--version"]),
          )?.[1] ?? null;
        value.installed = value.version !== null;
        value.configured =
          value.resolved_path === tool.resolved_path &&
          input.path
            .split(":")
            .map((p) => join(p, basename(tool.path)))
            .find((p) => {
              try {
                accessSync(p, constants.X_OK);
                return true;
              } catch {
                return false;
              }
            }) === tool.path;
        if (id === "node") value.arch = run(tool.path, ["-p", "process.arch"]);
      } catch {
        /* Missing tools remain unknown; no raw stderr is returned. */
      }
      capabilities[id] = value;
    }
    const statuses = workerNative<Record<string, CapabilityState>>(
      input,
      "desktop",
      {},
    );
    for (const [id, state] of Object.entries(statuses))
      capabilities[id] = {
        installed: state,
        configured: state,
        version: null,
        arch: null,
        path: null,
        resolved_path: null,
        last_verified: null,
      };
    return {
      os: process.platform as WorkerManifest["os"],
      product_version:
        process.platform === "darwin"
          ? run("/usr/bin/sw_vers", ["-productVersion"])
          : release(),
      build:
        process.platform === "darwin"
          ? run("/usr/bin/sw_vers", ["-buildVersion"])
          : release(),
      kernel: release(),
      arch: process.arch,
      uid: process.getuid?.() ?? -1,
      sampled_at: new Date().toISOString(),
      source: "worker-native",
      capabilities,
    };
  } catch {
    throw new Error("Worker capability sampling unavailable");
  }
}
