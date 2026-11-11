import { lstat } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
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
  // -o values have their own parser and expand tokens/environment variables.
  // Require one literal absolute path, not a list or an expanded filename.
  if (
    typeof config.knownHostsFile !== "string" ||
    !isAbsolute(config.knownHostsFile) ||
    resolve(config.knownHostsFile) === "/" ||
    /[\s\p{Cc}\p{Cf}"'\\%$]/u.test(config.knownHostsFile)
  )
    fail("invalid_launch", "Invalid SSH known_hosts path");
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
