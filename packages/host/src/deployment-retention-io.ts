import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  agentProcessCommand,
  readRegisteredRuntime,
  resolveExecutionConfig,
  runtimeDifferences,
} from "@cardigan/runtime-herdr";
import { runtimeTargetBinding } from "./runtime-target-fingerprint.js";
import {
  loadRuntimeWorkers,
  runtimeWorkersPath,
} from "./runtime-workers-config.js";

const helper = fileURLToPath(
  new URL("../src/deployment-retention-fs.py", import.meta.url),
);
export interface Item {
  kind: "release" | "snapshot" | "run";
  name: string;
  device: string;
  inode: string;
  stamp: string;
  size_bytes: number;
}
export interface Scan {
  candidates: Item[];
  skipped: string[];
}
export interface Command {
  file: string;
  args: string[];
}
const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const names = {
  release: new RegExp(`^release-[a-f0-9]{40}-${uuid}$`, "u"),
  snapshot: new RegExp(`^database-${uuid}\\.bak$`, "u"),
  run: /^A-[1-9][0-9]*$/u,
};
function response(
  text: string,
  kind: Item["kind"],
  allowed?: Set<string>,
): Scan {
  const { candidates, skipped } = JSON.parse(text) as Scan;
  const valid = (n: string) =>
    typeof n === "string" &&
    names[kind].test(n) &&
    (!allowed || allowed.has(n));
  if (
    !Array.isArray(candidates) ||
    !Array.isArray(skipped) ||
    !skipped.every(valid) ||
    !candidates.every(
      (i) =>
        i.kind === kind &&
        valid(i.name) &&
        [i.device, i.inode].every(
          (n) => typeof n === "string" && /^\d{1,24}$/u.test(n),
        ) &&
        typeof i.stamp === "string" &&
        /^[a-f0-9]{1,64}$/u.test(i.stamp) &&
        Number.isSafeInteger(i.size_bytes) &&
        i.size_bytes >= 0 &&
        Object.keys(i).sort().join() ===
          "device,inode,kind,name,size_bytes,stamp",
    ) ||
    new Set([...candidates.map((i) => i.name), ...skipped]).size !==
      candidates.length + skipped.length
  )
    throw new Error("Invalid maintenance observation");
  return { candidates, skipped };
}
export const localCommand = (op: string): Command => ({
  file: "/usr/bin/python3",
  args: ["-I", "-B", helper, op],
});
const opts = {
  encoding: "utf8",
  env: { PATH: "/usr/bin:/bin" },
  maxBuffer: 16 * 1024 * 1024,
} as const;
export async function scan(
  cmd: Command,
  input: object,
  kind: Item["kind"],
  allowed?: Set<string>,
  timeout = 5 * 60_000,
): Promise<Scan> {
  const text = await new Promise<string>((resolve, reject) => {
    const p = execFile(
      cmd.file,
      cmd.args,
      { ...opts, timeout },
      (error, stdout) =>
        error
          ? reject(new Error("Retention helper unavailable"))
          : resolve(stdout),
    );
    p.stdin?.on("error", () => {});
    p.stdin?.end(JSON.stringify(input));
  });
  return response(text, kind, allowed);
}
/** Only short run cleanup under a serialized eligibility recheck. No transport diagnostics escape. */
export function single(cmd: Command, input: object, item: Item) {
  const out = execFileSync(cmd.file, cmd.args, {
    ...opts,
    input: JSON.stringify(input),
    timeout: 8000,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const r = response(out, item.kind, new Set([item.name]));
  if (
    r.candidates.length !== 1 ||
    r.candidates[0]?.device !== item.device ||
    r.candidates[0]?.inode !== item.inode
  )
    throw new Error("Resource retained");
}

export async function localRunTarget(env: NodeJS.ProcessEnv, dataDir: string) {
  const workers = loadRuntimeWorkers(dataDir, runtimeWorkersPath(env));
  const w = workers.find(
    (w) => w.machine_id === "local" && w.project_id === "cardigan",
  );
  if (!w && workers.some((w) => w.machine_id === "local")) return;
  const execution =
    w?.execution ??
    resolveExecutionConfig({ ...env, CARDIGAN_DATA_DIR: dataDir });
  if (execution.mode !== "agent-ssh" || (w && w.os !== "linux")) return;
  const session = w?.session ?? env.CARDIGAN_HC_SESSION ?? "cardigan";
  if (!w) {
    const registered = await readRegisteredRuntime(dataDir);
    if (
      !registered ||
      runtimeDifferences(registered, execution, session).length
    )
      return;
  }
  const fingerprint = runtimeTargetBinding({
    machine_id: "local",
    project_id: "cardigan",
    execution,
    generation: w?.generation ?? "legacy",
    session: w?.session ?? env.CARDIGAN_HC_SESSION ?? "cardigan",
  }).fingerprint;
  const src = readFileSync(helper, "utf8");
  const cmd = (op: string) =>
    agentProcessCommand(execution, [
      "/usr/bin/python3",
      "-I",
      "-B",
      "-c",
      src,
      op,
    ]);
  return {
    fingerprint,
    root: execution.agentRoot,
    gid: execution.gid,
    inventory: await cmd("inventory"),
    clear: await cmd("clear"),
  };
}
