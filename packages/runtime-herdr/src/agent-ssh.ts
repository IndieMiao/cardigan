import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, isAbsolute, join, posix, resolve } from "node:path";
import { fail, type HcClient } from "./client.js";
import { type ExecutionConfig, shellQuote } from "./execution.js";

type AgentConfig = Extract<ExecutionConfig, { mode: "agent-ssh" }>;
export const AGENT_PATH =
  "/var/lib/cardigan-agent/.local/bin:/usr/local/bin:/usr/bin:/bin";
function validateSshConfig(config: AgentConfig) {
  for (const [name, value] of [
    ["host", config.host],
    ["user", config.user],
    ["hostKeyAlias", config.hostKeyAlias],
  ] as const) {
    if (
      value !== undefined &&
      (typeof value !== "string" ||
        (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/u.test(value) &&
          !(
            name !== "user" &&
            /^[a-fA-F0-9:.]+$/u.test(value) &&
            isIP(value) === 6
          )))
    )
      fail("invalid_launch", `Invalid SSH ${name}`);
  }
  if (
    config.port !== undefined &&
    (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)
  )
    fail("invalid_launch", "SSH port must be an integer from 1 to 65535");
  // -i and -o values expand %-tokens and ${VAR}; -o values have their own
  // parser. Require one literal absolute path, not a list or expanded name.
  if (!literalPath(config.knownHostsFile))
    fail("invalid_launch", "Invalid SSH known_hosts path");
  if (!literalPath(config.identityFile))
    fail("invalid_launch", "Invalid SSH identity path");
  // agentRoot is joined into remote commands (pack services, check listing):
  // the literal-path rule plus merge-gate.yaml's agent_root charset, and
  // normalized so the joined path is the checked one.
  if (
    !literalPath(config.agentRoot) ||
    !/^\/[A-Za-z0-9._/-]+$/u.test(config.agentRoot) ||
    posix.normalize(config.agentRoot) !== config.agentRoot ||
    config.agentRoot.endsWith("/")
  )
    fail("invalid_launch", "Invalid SSH agent root path");
}
/**
 * One literal absolute non-root path: no whitespace, control/format
 * characters, quotes, backslashes or the `%` / `$` expansions of ssh.
 */
function literalPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    isAbsolute(value) &&
    resolve(value) !== "/" &&
    !/[\s\p{Cc}\p{Cf}"'\\%$]/u.test(value)
  );
}
function sshArguments(config: AgentConfig): string[] {
  validateSshConfig(config);
  return [
    "-F",
    "/dev/null",
    "-T",
    "-i",
    config.identityFile,
    ...[
      "BatchMode=yes",
      "IdentitiesOnly=yes",
      "IdentityAgent=none",
      "ForwardAgent=no",
      "ClearAllForwardings=yes",
      "PasswordAuthentication=no",
      "KbdInteractiveAuthentication=no",
      "StrictHostKeyChecking=yes",
      `UserKnownHostsFile=${config.knownHostsFile}`,
      "GlobalKnownHostsFile=/dev/null",
      `HostKeyAlias=${config.hostKeyAlias ?? "cardigan-agent-local"}`,
      "HostKeyAlgorithms=ssh-ed25519",
      "ConnectTimeout=10",
    ].flatMap((option) => ["-o", option]),
    ...(config.port === undefined ? [] : ["-p", String(config.port)]),
    "--",
    `${config.user ?? "agent"}@${config.host ?? "localhost"}`,
  ];
}
export function agentSshCommand(config: AgentConfig): string {
  return ["ssh", ...sshArguments(config), "env", `PATH=${AGENT_PATH}`]
    .map(shellQuote)
    .join(" ");
}
/** A streaming, credential-checked entry; the caller supplies an explicit environment. */
export async function agentProcessCommand(
  config: AgentConfig,
  args: readonly string[],
) {
  await checkAgentFiles(config);
  return {
    file: "ssh",
    args: [
      "-o",
      "ServerAliveInterval=5",
      "-o",
      "ServerAliveCountMax=3",
      ...sshArguments(config),
      ["env", "-i", `PATH=${AGENT_PATH}`, ...args].map(shellQuote).join(" "),
    ],
  };
}
export async function registerAgentMachine(
  client: HcClient,
  config: AgentConfig,
  session: string,
  version: string,
) {
  await checkAgentFiles(config);
  const target = agentSshCommand(config);
  const listing = JSON.parse(await client.exec(["machine", "ls", "--json"]));
  if (!Array.isArray(listing.machines))
    fail("runtime_unavailable", "Invalid hc machine list");
  const existing = listing.machines.find(
    (m: { name: string }) => m.name === config.machine,
  );
  if (
    existing &&
    (existing.target !== target ||
      existing.via !== true ||
      existing.session !== session)
  )
    fail(
      "invalid_launch",
      "Configured hc machine already points to another SSH endpoint",
    );
  const machine =
    existing ??
    JSON.parse(
      await client.exec([
        "machine",
        "add",
        "--name",
        config.machine,
        "--session",
        session,
        "--via",
        target,
        "--json",
      ]),
    );
  if (machine.version !== version)
    fail("version_mismatch", "Agent account hc version does not match");
}

async function checkAgentFiles(config: AgentConfig) {
  validateSshConfig(config);
  if (process.platform !== "linux")
    fail("invalid_launch", "agent-ssh currently requires Linux");
  for (const path of [config.identityFile, config.knownHostsFile]) {
    const entry = await lstat(path);
    if (
      !entry.isFile() ||
      entry.uid !== process.getuid?.() ||
      (entry.mode & 0o777) !== 0o600
    )
      fail(
        "invalid_launch",
        "SSH credential files must be host-owned regular files with mode 0600",
      );
  }
}
/** captureAgent returns text; reuse the pinned SSH entry for Git's bidirectional binary stream. */
export async function agentUploadPack(
  config: AgentConfig,
  repository: string,
): Promise<string> {
  return agentPack(config, repository, "upload-pack");
}
export async function agentReceivePack(
  config: AgentConfig,
  repository: string,
): Promise<string> {
  return agentPack(config, repository, "receive-pack");
}
async function agentPack(
  config: AgentConfig,
  repository: string,
  service: "upload-pack" | "receive-pack",
): Promise<string> {
  // Validate agentRoot before it is used to bound the repository path.
  if (config.mode === "agent-ssh") validateSshConfig(config);
  if (
    config.mode !== "agent-ssh" ||
    !isAbsolute(repository) ||
    dirname(resolve(repository)) !== join(config.agentRoot, "repos")
  )
    fail(
      "invalid_launch",
      "Git pack service requires a configured Agent base repository",
    );
  await checkAgentFiles(config);
  const remote = `GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git -c ${shellQuote(`safe.directory=${repository}`)} -c core.hooksPath=/dev/null -c transfer.fsckObjects=true ${service} -- ${shellQuote(repository)}`;
  // Ignore Git's appended path; the command is bound to the host-selected repository.
  return `sh -c ${shellQuote(`exec ${agentSshCommand(config)} ${shellQuote(remote)}`)} --`;
}

/** Read-only listing of one project's merge-check directories on an executor. */
export interface AgentCheckListing {
  /** Existing `<agentRoot>/checks/<project>/<attempt>/worktree` directories. */
  readonly directories: readonly string[];
  /** Worktrees registered in the executor's base clone below the checks root. */
  readonly registered: readonly string[];
}
export type AgentListRunner = (
  file: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<{ readonly code: number | null; readonly stdout: Buffer }>;
const LIST_SCRIPT = [
  "set -u",
  // A missing checks root is an empty listing; anything else unreadable fails.
  'if [ -d "$1" ]; then find "$1" -mindepth 2 -maxdepth 2 -name worktree -type d -print0 || exit 3; elif [ -e "$1" ]; then exit 3; fi',
  "printf '%s\\0' --",
  'if [ -d "$2" ]; then git -c "safe.directory=$2" -c core.hooksPath=/dev/null -C "$2" worktree list --porcelain -z || exit 4; fi',
  "printf '%s\\0' --end",
].join("\n");
const runListing: AgentListRunner = (file, args, timeoutMs) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, {
      env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) child.kill("SIGKILL");
      else chunks.push(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) =>
      resolvePromise({ code, stdout: Buffer.concat(chunks) }),
    );
  });
/**
 * P2a-12 C: list a project's check directories over the executor's pinned SSH
 * entry. Any failure (connection, permission, truncated output) throws: the
 * caller must report "unreachable", never treat it as an empty directory.
 */
export async function agentListChecks(
  config: AgentConfig,
  project: string,
  options: { readonly run?: AgentListRunner; readonly timeoutMs?: number } = {},
): Promise<AgentCheckListing> {
  if (
    config.mode !== "agent-ssh" ||
    !/^[a-zA-Z0-9_][a-zA-Z0-9._-]*$/u.test(project)
  )
    fail("invalid_launch", "Check listing requires an agent-ssh project");
  const checks = posix.join(config.agentRoot, "checks", project),
    clone = posix.join(config.agentRoot, "repos", project);
  const command = await agentProcessCommand(config, [
    "GIT_CONFIG_NOSYSTEM=1",
    "GIT_CONFIG_GLOBAL=/dev/null",
    "sh",
    "-c",
    LIST_SCRIPT,
    "sh",
    checks,
    clone,
  ]);
  const { code, stdout } = await (options.run ?? runListing)(
    command.file,
    command.args,
    options.timeoutMs ?? 60_000,
  );
  const fields = stdout.toString("utf8").split("\0");
  // Complete output ends with the trailer and one empty field after its NUL.
  if (code !== 0 || fields.pop() !== "" || fields.pop() !== "--end")
    fail("runtime_unavailable", "Executor check listing failed");
  const separator = fields.indexOf("--");
  if (separator < 0)
    fail("runtime_unavailable", "Executor check listing failed");
  const below = (path: string) =>
    path.startsWith(`${checks}/`) && posix.normalize(path) === path;
  return {
    directories: fields.slice(0, separator).filter(below).sort(),
    registered: fields
      .slice(separator + 1)
      .filter((field) => field.startsWith("worktree "))
      .map((field) => field.slice("worktree ".length))
      .filter(below)
      .sort(),
  };
}
