import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, chown, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitEnvironment, gitSafetyArguments } from "@cardigan/git-transport";
import type { ExecutionConfig } from "@cardigan/runtime-herdr";
import type { CapabilityDefinition } from "./machine-capability-catalog.js";

/** Prebuilt by `pnpm --filter @cardigan/mcp-server build:agent-tools`. */
export const AGENT_TOOLS = [
  "download-attachment.mjs",
  "upload-evidence.mjs",
] as const;
export type AgentTool = (typeof AGENT_TOOLS)[number];
export const AGENT_TOOLS_CAPABILITY = "agent.attachment_tools";
/** Remote: root-owned, group read-only beside the worker helpers (signed v2 / manual upgrade). */
export const remoteAgentToolsDirectory = (agentRoot: string) =>
  join(agentRoot, "libexec", "agent-tools");
export const RELEASE_UNAVAILABLE = "控制端当前发布的附件助手无法核验";
const releaseRoot = new URL("../../../", import.meta.url);
const releaseTools = new URL("deploy/agent-tools/", releaseRoot);

export interface AgentToolsRelease {
  readonly files: Readonly<Record<AgentTool, Buffer>>;
  readonly digests: Readonly<Record<AgentTool, string>>;
  /** Commit of this controller's release checkout the bytes were verified against. */
  readonly source: string;
}
const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const git = (root: URL, ...args: string[]) =>
  execFileSync(
    "/usr/bin/git",
    [...gitSafetyArguments, "--git-dir=.git", ...args],
    {
      cwd: fileURLToPath(root),
      env: gitEnvironment(),
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
/**
 * Expected bytes come from the committed release, never from the checked file
 * alone: a working file that differs from its blob (or a missing one) makes the
 * release unverifiable instead of redefining "current".
 */
export function readAgentToolsRelease(
  root: URL = releaseRoot,
): AgentToolsRelease | undefined {
  try {
    const source = git(root, "rev-parse", "--verify", "HEAD^{commit}")
      .toString()
      .trim();
    if (!/^[0-9a-f]{40}$/u.test(source)) return undefined;
    const files = {} as Record<AgentTool, Buffer>;
    for (const name of AGENT_TOOLS) {
      const blob = git(
        root,
        "cat-file",
        "blob",
        `${source}:deploy/agent-tools/${name}`,
      );
      if (
        !blob.equals(readFileSync(new URL(`deploy/agent-tools/${name}`, root)))
      )
        return undefined;
      files[name] = blob;
    }
    return Object.freeze({
      files,
      digests: Object.freeze(
        Object.fromEntries(
          AGENT_TOOLS.map((name) => [name, sha256(files[name])]),
        ) as Record<AgentTool, string>,
      ),
      source,
    });
  } catch {
    return undefined;
  }
}
// A release is immutable for the lifetime of the controller process.
let release: { value: AgentToolsRelease | undefined } | undefined;
export function agentToolsRelease(): AgentToolsRelease | undefined {
  release ??= { value: readAgentToolsRelease() };
  return release.value;
}

/** The controller's own release, for the unisolated local development mode. */
export const releaseAgentToolsDirectory = () => fileURLToPath(releaseTools);
export const localAgentToolsDirectory = (agentRoot: string) =>
  join(agentRoot, "agent-tools");

async function replaceFile(
  directory: string,
  name: string,
  content: Buffer,
  gid: number,
  mode: number,
) {
  const path = join(directory, name);
  const current = await lstat(path).catch(() => undefined);
  if (
    current?.isFile() &&
    current.uid === process.getuid?.() &&
    current.gid === gid &&
    current.nlink === 1 &&
    (current.mode & 0o7777) === mode &&
    current.size === content.length &&
    sha256(readFileSync(path)) === sha256(content)
  )
    return;
  const temporary = join(directory, `.${name}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content);
    await handle.chown(-1, gid);
    await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * The control host's Agent account reads the tools from a host-owned directory
 * it cannot write. Replaced atomically from this release before local launches.
 */
export async function installLocalAgentTools(
  agentRoot: string,
  gid: number,
  current: AgentToolsRelease | null = agentToolsRelease() ?? null,
) {
  if (!current) throw new Error("agent_tools_release_unavailable");
  const directory = localAgentToolsDirectory(agentRoot);
  await mkdir(directory, { mode: 0o750 }).catch((error: { code?: string }) => {
    if (error.code !== "EEXIST") throw error;
  });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== process.getuid?.())
    throw new Error("agent_tools_directory_unsafe");
  await chown(directory, -1, gid);
  // An explicit mode also narrows an inherited default ACL mask to read-only.
  await chmod(directory, 0o750);
  for (const name of AGENT_TOOLS)
    await replaceFile(directory, name, current.files[name], gid, 0o750);
  await replaceFile(
    directory,
    "release.json",
    Buffer.from(
      `${JSON.stringify({ source_commit: current.source, sha256: current.digests })}\n`,
    ),
    gid,
    0o640,
  );
  return directory;
}

/**
 * Directory exposed to an Agent as CARDIGAN_AGENT_TOOLS. Remote workers use the
 * copy installed with their helpers; local isolated launches refresh the host copy.
 * Undefined when the local copy cannot be refreshed (never blocks a launch).
 */
export async function agentToolsDirectoryFor(
  execution: ExecutionConfig,
  remote: boolean,
  install = installLocalAgentTools,
): Promise<string | undefined> {
  if (execution.mode === "local") return releaseAgentToolsDirectory();
  if (remote) return remoteAgentToolsDirectory(execution.agentRoot);
  try {
    return await install(execution.agentRoot, execution.gid);
  } catch {
    return undefined;
  }
}

export function agentToolsCheckDirectory(
  execution: ExecutionConfig,
  machine: string,
) {
  if (execution.mode === "local") return releaseAgentToolsDirectory();
  return machine === "local"
    ? localAgentToolsDirectory(execution.agentRoot)
    : remoteAgentToolsDirectory(execution.agentRoot);
}

// Runs as the Run account with its own node: hash and dry-run each tool without
// arguments (prints usage, never connects). Only fixed status words leave it.
export const AGENT_TOOLS_CHECK_SCRIPT = `
const fs = require("node:fs"), crypto = require("node:crypto"), path = require("node:path"), cp = require("node:child_process");
const [directory, expected] = process.argv.slice(1);
const problems = [];
for (const [name, digest] of Object.entries(JSON.parse(expected))) {
  const file = path.join(directory, name);
  let info;
  try { info = fs.statSync(file); } catch { problems.push("missing:" + name); continue; }
  if (!info.isFile()) { problems.push("missing:" + name); continue; }
  try { fs.accessSync(file, fs.constants.R_OK | fs.constants.X_OK); } catch { problems.push("not_executable:" + name); continue; }
  if (crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") !== digest) { problems.push("mismatch:" + name); continue; }
  const run = cp.spawnSync(process.execPath, [file], { env: { PATH: process.env.PATH }, stdio: ["ignore", "ignore", "pipe"], timeout: 5000 });
  if (run.status !== 1 || !String(run.stderr).includes("[arguments]")) problems.push("not_executable:" + name);
}
console.log("agent-tools " + (problems.length ? problems.join(",") : "ok"));
`;
const RESULT =
  /^agent-tools (ok|(?:missing|mismatch|not_executable):[a-z-]+\.mjs(?:,(?:missing|mismatch|not_executable):[a-z-]+\.mjs)*)\s*$/u;
const PROBLEM_TEXT = {
  missing: "缺失",
  mismatch: "与当前发布的 SHA-256 不一致",
  not_executable: "无法执行",
} as const;

/**
 * Readable reason for a failed check; undefined means installed and current.
 * With the release digests each problem names the expected SHA-256, so an
 * operator can verify a manual install (deploy/README.md) against it.
 */
export function agentToolsProblem(
  output: string,
  expected?: Readonly<Record<AgentTool, string>>,
): string | undefined {
  const status = RESULT.exec(output)?.[1];
  if (status === undefined) return "附件助手检查未完成";
  if (status === "ok") return undefined;
  const problems = status.split(",").map((entry) => {
    const [kind, name] = entry.split(":") as [
      keyof typeof PROBLEM_TEXT,
      string,
    ];
    return AGENT_TOOLS.includes(name as AgentTool)
      ? `附件助手 ${name} ${PROBLEM_TEXT[kind]}`
      : undefined;
  });
  if (problems.some((p) => p === undefined)) return "附件助手检查未完成";
  // A manual install replaces both files, so always name both expected digests.
  const digests = expected
    ? `（当前发布期望 SHA-256：${AGENT_TOOLS.map((name) => `${name} ${expected[name]}`).join("，")}）`
    : "";
  return `${problems.join("；")}${digests}`;
}

/** Version records the release commit the matching tools were verified against. */
export function agentToolsCapability(
  execution: ExecutionConfig,
  machine: string,
  current: AgentToolsRelease | null = agentToolsRelease() ?? null,
): CapabilityDefinition {
  const command = [
    "node",
    "-e",
    AGENT_TOOLS_CHECK_SCRIPT,
    agentToolsCheckDirectory(execution, machine),
    JSON.stringify(current?.digests ?? {}),
  ];
  return {
    key: AGENT_TOOLS_CAPABILITY,
    os: ["linux", "darwin"],
    check: command,
    version: command,
    acceptsOutput: (output) =>
      current !== null && agentToolsProblem(output) === undefined,
    failureReason: (output) =>
      current === null
        ? RELEASE_UNAVAILABLE
        : output === undefined
          ? "附件助手检查未完成"
          : agentToolsProblem(output, current.digests),
    parseVersion: () => current?.source.slice(0, 12) ?? null,
  };
}
