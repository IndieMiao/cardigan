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
  endpoint: string,
) {
  return {
    target: resourceTarget(project, machine, execution),
    source: source().replace(
      "AUTHORITY = None",
      () => `AUTHORITY = ${JSON.stringify([endpoint, project, machine])}`,
    ),
  };
}

/** Metadata only. No mutation mode or commands, PIDs or paths in the request. */
export async function previewRunResources(
  execution: ExecutionConfig,
  tag: string,
  age: number,
): Promise<{ expired: number; unknown: number; partial: boolean }> {
  const args = ["-I", "-B", "-c", source(), "preview"];
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
    child.stdin?.end(JSON.stringify({ tag, age }));
  });
  const rows = JSON.parse(data);
  if (
    ![rows.expired, rows.unknown].every(
      (v) => Number.isSafeInteger(v) && v >= 0 && v <= 1024,
    ) ||
    typeof rows.partial !== "boolean"
  )
    throw new Error("Invalid resource preview");
  return rows;
}
