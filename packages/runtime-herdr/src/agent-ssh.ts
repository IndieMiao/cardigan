import { lstat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fail, type HcClient } from "./client.js";
import { type ExecutionConfig, shellQuote } from "./execution.js";

type AgentConfig = Extract<ExecutionConfig, { mode: "agent-ssh" }>;
export function agentSshCommand(config: AgentConfig): string {
  return [
    "ssh",
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
      "HostKeyAlias=cardigan-agent-local",
      "HostKeyAlgorithms=ssh-ed25519",
      "ConnectTimeout=10",
    ].flatMap((option) => ["-o", option]),
    "--",
    "agent@localhost",
    "env",
    "PATH=/var/lib/cardigan-agent/.local/bin:/usr/local/bin:/usr/bin:/bin",
  ]
    .map(shellQuote)
    .join(" ");
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
