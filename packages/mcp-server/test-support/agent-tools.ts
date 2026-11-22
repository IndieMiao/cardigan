import { execFile } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const agentToolsDirectory = fileURLToPath(
  new URL("../../../deploy/agent-tools/", import.meta.url),
);
let isolated: string | undefined;
/** A copy outside the workspace: only Node built-ins can resolve from there. */
function isolatedTools() {
  if (isolated) return isolated;
  const directory = mkdtempSync(join(tmpdir(), "cardigan-agent-tools-"));
  for (const name of ["download-attachment.mjs", "upload-evidence.mjs"])
    copyFileSync(join(agentToolsDirectory, name), join(directory, name));
  process.once("exit", () => rmSync(directory, { recursive: true }));
  isolated = directory;
  return directory;
}

export function runAgentTool(
  tool: "download-attachment" | "upload-evidence",
  args: readonly string[],
  token?: string,
) {
  const directory = isolatedTools();
  return new Promise<{ status: number; stdout: string; stderr: string }>(
    (resolve) => {
      execFile(
        process.execPath,
        [join(directory, `${tool}.mjs`), ...args],
        {
          cwd: directory,
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            ...(token === undefined ? {} : { MCP_TOKEN: token }),
          },
          timeout: 10_000,
        },
        (error, stdout, stderr) =>
          resolve({
            status: error ? Number(error.code ?? 1) : 0,
            stdout,
            stderr,
          }),
      );
    },
  );
}
