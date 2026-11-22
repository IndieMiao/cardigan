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
export async function signedHelperBundle(
  worker: Worker,
  project: string,
  identity: string,
  signal?: AbortSignal,
) {
  const sha = deployed(worker.dataDir);
  const repo = join(worker.dataDir, "central", "cardigan.git");
  await requireHostDirectory(repo);
  const files: Record<string, string> = {};
  // Read committed blobs by the supervisor's active immutable SHA, never by cwd, ref name or worktree.
  for (const name of helpers) {
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
        maxBuffer: 200000,
        signal,
      },
    );
    if (
      createHash("sha256").update(stdout).digest("hex") !==
      workerHelperDigests()[name]
    )
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
    kind: "cardigan-helper-v1",
    project,
    issued: Date.now(),
    digests: workerHelperDigests(),
  });
  const signature = sign("RSA-SHA256", Buffer.from(manifest), key).toString(
    "base64",
  );
  return { manifest, signature, files };
}
export async function installRelease(
  worker: Worker,
  project: string,
  identity: string,
  signal?: AbortSignal,
) {
  const { user, entry } = upgradePrincipal(project, identity);
  const command = await agentProcessCommand(
    {
      ...worker,
      user,
      identityFile: identity,
      path: "/usr/bin:/bin",
    },
    ["/usr/bin/sudo", "-n", "--", entry],
  );
  const bundle = await signedHelperBundle(worker, project, identity, signal);
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
  if (
    !old ||
    Object.keys(old).length !== helpers.length ||
    helpers.some(
      (n) => typeof old[n] !== "string" || !/^[a-f0-9]{64}$/u.test(old[n]),
    )
  )
    return invalid();
  return Object.fromEntries(helpers.map((n) => [n, String(old[n])]));
}
