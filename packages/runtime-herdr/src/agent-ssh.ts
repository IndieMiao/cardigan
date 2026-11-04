import { lstat } from "node:fs/promises";
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
