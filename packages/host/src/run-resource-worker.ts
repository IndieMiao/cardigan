import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  agentProcessCommand,
  type ExecutionConfig,
} from "@cardigan/runtime-herdr";

const source = () =>
  readFileSync(
    new URL("../../../deploy/run-resources.py", import.meta.url),
    "utf8",
  );
export function resourceTarget(
  project: string,
  machine: string,
  execution: ExecutionConfig,
) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        project,
        machine,
        execution.target?.fingerprint ?? execution.dataDir,
      ]),
    )
    .digest("hex");
}
export function resourceEntry(
  project: string,
  machine: string,
  execution: ExecutionConfig,
) {
  return {
    target: resourceTarget(project, machine, execution),
    source: source(),
  };
}
export interface ResourceRegistration {
  key: string;
  inode: [string, string];
  expired: boolean;
  closed: boolean;
  owned: boolean;
}
/** The reconciler is always host-supplied code, never a script in agent-writable storage. */
export async function resourceWorker(
  execution: ExecutionConfig,
  tag: string,
  age: number,
  items?: ResourceRegistration[],
): Promise<ResourceRegistration[]> {
  const args = ["-I", "-B", "-c", source(), "reconcile"];
  const command =
    execution.mode === "agent-ssh"
      ? await agentProcessCommand(execution, [
          execution.fileHelper?.python ?? "/usr/bin/python3",
          ...args,
        ])
      : { file: "/usr/bin/python3", args };
  const data = await new Promise<string>((resolve, reject) => {
    const child = execFile(
      command.file,
      command.args,
      {
        cwd: "/",
        env: { PATH: "/usr/bin:/bin" },
        timeout: 15000,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
      },
      (err, text) => {
        if (err) reject(new Error("Run resource worker unavailable"));
        else resolve(text);
      },
    );
    child.stdin?.on("error", () =>
      reject(new Error("Run resource worker unavailable")),
    );
    child.stdin?.end(JSON.stringify({ tag, age, items }));
  });
  const rows: ResourceRegistration[] = JSON.parse(data);
  if (
    !Array.isArray(rows) ||
    !rows.every(
      (r) =>
        /^A-[1-9]\d{0,15}\.R-[1-9]\d{0,15}\.R-[1-9]\d{0,15}$/u.test(r.key) &&
        Array.isArray(r.inode) &&
        r.inode.length === 2 &&
        r.inode.every((v) => typeof v === "string" && /^\d+$/u.test(v)) &&
        typeof r.expired === "boolean" &&
        typeof r.closed === "boolean" &&
        typeof r.owned === "boolean",
    )
  )
    throw new Error("Run resource response invalid");
  return rows;
}
