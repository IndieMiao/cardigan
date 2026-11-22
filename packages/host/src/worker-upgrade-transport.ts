import { execFile } from "node:child_process";
import { createHash, sign } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gitSafetyArguments } from "@cardigan/git-transport";
import {
  agentProcessCommand,
  type ExecutionConfig,
} from "@cardigan/runtime-herdr";
import { AGENT_TOOLS, agentToolsRelease } from "./agent-tools.js";
import {
  deploymentDirectory,
  requireHostDirectory,
} from "./deployment-config.js";
import { helpers, workerHelperDigests } from "./worker-helper-release.js";
import { readWorkerPrivateFile } from "./worker-onboarding-config.js";

type Worker = Extract<ExecutionConfig, { mode: "agent-ssh" }>;
const release = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const invalid = (): never => {
  throw new Error("worker_upgrade_unavailable");
};

function deployment(dataDir: string) {
  return JSON.parse(
    readWorkerPrivateFile(
      join(deploymentDirectory(dataDir), "state.json"),
    )?.toString() ?? "null",
  );
}
export function promotionPending(dataDir: string) {
  const state = deployment(dataDir);
  return (
    state?.running?.release === release && state.current?.release !== release
  );
}
function deployed(dataDir: string) {
  const state = deployment(dataDir);
  if (
    !state ||
    !/^[a-f0-9]{40}$/u.test(state.current?.sha) ||
    state.current.release !== release ||
    state.running?.release !== release ||
    state.running.sha !== state.current.sha
  )
    return invalid();
  return String(state.current.sha);
}
export function upgradePrincipal(project: string, identity: string) {
  const tag = createHash("sha256").update(project).digest("hex").slice(0, 20);
  return identity.endsWith(".key.bound")
    ? {
        user: `cgu_${tag}`,
        entry: `/opt/cardigan-helper-upgrade-${tag}/upgrade`,
      }
    : {
        user: "cardigan_updater",
        entry: "/opt/cardigan-helper-upgrade/upgrade",
      };
}
/** Nothing reached the worker: the local release or signing material was refused. */
export const WORKER_UPGRADE_NOT_SENT = "worker_upgrade_not_sent";
/** v2 entries (enrolled since C-595) also install the agent tools; v1 entries refuse them. */
export type HelperProtocol = "v1" | "v2";
const toolEntries = AGENT_TOOLS.map((name) => `agent-tools/${name}` as const);
export async function signedHelperBundle(
  worker: Worker,
  project: string,
  identity: string,
  signal?: AbortSignal,
  protocol: HelperProtocol = "v2",
) {
  const sha = deployed(worker.dataDir);
  const repo = join(worker.dataDir, "central", "cardigan.git");
  await requireHostDirectory(repo);
  const files: Record<string, string> = {};
  const tools = protocol === "v2" ? agentToolsRelease() : undefined;
  if (protocol === "v2" && !tools) return invalid();
  const expected: Record<string, string> = {
    ...workerHelperDigests(),
    ...(tools
      ? Object.fromEntries(
          AGENT_TOOLS.map((name) => [
            `agent-tools/${name}`,
            tools.digests[name],
          ]),
        )
      : {}),
  };
  // Read committed blobs by the supervisor's active immutable SHA, never by cwd, ref name or worktree.
  for (const name of [...helpers, ...(tools ? toolEntries : [])]) {
    const { stdout } = await promisify(execFile)(
      "/usr/bin/git",
      [
        ...gitSafetyArguments,
        "--no-replace-objects",
        "--git-dir",
        repo,
        "cat-file",
        "blob",
        `${sha}:deploy/${name}`,
      ],
      {
        encoding: "buffer",
        env: {
          PATH: "/usr/bin:/bin",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
        cwd: "/",
        timeout: 5000,
        maxBuffer: 1024 * 1024,
        signal,
      },
    );
    if (createHash("sha256").update(stdout).digest("hex") !== expected[name])
      return invalid();
    files[name] = stdout.toString("base64");
  }
  const key = readWorkerPrivateFile(`${identity}.signer.pem`);
  if (
    !key ||
    !readWorkerPrivateFile(identity) ||
    worker.user === "cardigan_updater" ||
    worker.user === upgradePrincipal(project, identity).user ||
    identity === worker.identityFile
  )
    return invalid();
  if (deployed(worker.dataDir) !== sha) return invalid();
  const manifest = JSON.stringify({
    kind: `cardigan-helper-${protocol}`,
    project,
    issued: Date.now(),
    digests: expected,
  });
  const signature = sign("RSA-SHA256", Buffer.from(manifest), key).toString(
    "base64",
  );
  return { manifest, signature, files };
}
async function sendRelease(
  worker: Worker,
  project: string,
  identity: string,
  protocol: HelperProtocol,
  signal?: AbortSignal,
) {
  const { user, entry } = upgradePrincipal(project, identity);
  let command: Awaited<ReturnType<typeof agentProcessCommand>>;
  let bundle: Awaited<ReturnType<typeof signedHelperBundle>>;
  try {
    command = await agentProcessCommand(
      {
        ...worker,
        user,
        identityFile: identity,
        path: "/usr/bin:/bin",
      },
      ["/usr/bin/sudo", "-n", "--", entry],
    );
    bundle = await signedHelperBundle(
      worker,
      project,
      identity,
      signal,
      protocol,
    );
  } catch {
    // C-599: prepared locally and refused before any connection to the worker.
    throw new Error(WORKER_UPGRADE_NOT_SENT);
  }
  const result = await new Promise<string>((resolve, reject) => {
    const ssh = execFile(
      "/usr/bin/ssh",
      command.args,
      {
        cwd: "/",
        env: { PATH: "/usr/bin:/bin" },
        timeout: 90000,
        killSignal: "SIGKILL",
        maxBuffer: 4096,
        signal,
      },
      (error, out) =>
        error
          ? reject(new Error("worker_upgrade_install_failed"))
          : resolve(out),
    );
    ssh.stdin?.on("error", reject);
    ssh.stdin?.end(JSON.stringify(bundle));
  });
  const old = JSON.parse(result);
  const tools = protocol === "v2" ? toolEntries : [];
  if (
    !old ||
    Object.keys(old).length !== helpers.length + tools.length ||
    helpers.some(
      (n) => typeof old[n] !== "string" || !/^[a-f0-9]{64}$/u.test(old[n]),
    ) ||
    tools.some(
      (n) =>
        old[n] !== null &&
        (typeof old[n] !== "string" || !/^[a-f0-9]{64}$/u.test(old[n])),
    )
  )
    return invalid();
  // Tool entries are present only when a v2 entry installed them ("none": first install).
  return Object.fromEntries([
    ...helpers.map((n) => [n, String(old[n])]),
    ...tools.map((n) => [n, old[n] === null ? "none" : String(old[n])]),
  ]) as Record<string, string>;
}
/** C-599: true only when the release went through a v2 entry, which installs the tools. */
export const installedAgentTools = (before: Record<string, string>) =>
  toolEntries.every((n) => typeof before[n] === "string");
/**
 * Entries enrolled before C-595 refuse a v2 bundle while verifying it, before
 * any write or replay record, so only then retry the unchanged v1 bundle.
 * Their helpers stay current; the result then lacks the tool entries and the
 * machine is reported as needing an administrator migration (C-599).
 */
export async function installRelease(
  worker: Worker,
  project: string,
  identity: string,
  signal?: AbortSignal,
  send = sendRelease,
) {
  try {
    return await send(worker, project, identity, "v2", signal);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      error.message !== "worker_upgrade_install_failed"
    )
      throw error;
    signal?.throwIfAborted();
    return await send(worker, project, identity, "v1", signal);
  }
}
