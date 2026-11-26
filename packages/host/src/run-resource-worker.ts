import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CompiledAssignmentLaunch } from "@cardigan/roles";
import {
  agentProcessCommand,
  type ExecutionConfig,
} from "@cardigan/runtime-herdr";

const source = () =>
  readFileSync(
    new URL("../../../deploy/run-resources.py", import.meta.url),
    "utf8",
  );
const viteOwner = new URL(
  "../../../deploy/run-vite-owner.mjs",
  import.meta.url,
);
// A release is immutable for the lifetime of the controller process.
let filesRevision: { value: string | undefined } | undefined;
/**
 * C-608: a session keeps the run-command entry it was started with. Folding
 * this release's entry into the session fingerprint replaces an older session
 * on its next wake instead of failing it with exit 125. Undefined when the
 * release files are unreadable (no replacement, never a blocked launch).
 */
export function sessionFilesRevision(): string | undefined {
  if (!filesRevision) {
    try {
      const digest = createHash("sha256")
        .update(source())
        .update("\0")
        .update(readFileSync(viteOwner))
        .digest("hex");
      filesRevision = { value: `run-command-${digest.slice(0, 16)}` };
    } catch {
      filesRevision = { value: undefined };
    }
  }
  return filesRevision.value;
}
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
  tokenId: string,
  publicKey: string,
) {
  return {
    target: resourceTarget(project, machine, execution),
    source: source()
      .replace(
        "VITE_OWNER = None",
        () => `VITE_OWNER = ${JSON.stringify(readFileSync(viteOwner, "utf8"))}`,
      )
      .replace(
        "AUTHORITY = None",
        () =>
          `AUTHORITY = ${JSON.stringify([endpoint, project, machine, tokenId, publicKey])}`,
      ),
  };
}

/** The runtime authenticates this argv, not a second pass over launch.sh. */
export function verifiedLocalLaunch(
  compiled: Pick<
    CompiledAssignmentLaunch,
    "files" | "launch_script" | "secret_env"
  >,
) {
  const script = compiled.files.find((f) => f.path === compiled.launch_script);
  if (!script) throw new Error("Missing launch script");
  return {
    command: "/usr/bin/python3",
    args: [
      "-IB",
      "-c",
      LOCAL_BOOTSTRAP,
      script.path,
      createHash("sha256").update(script.content).digest("hex"),
      String(Buffer.byteLength(script.content)),
      join(dirname(script.path), "secrets.env"),
      JSON.stringify(Object.keys(compiled.secret_env)),
    ],
  };
}
const LOCAL_BOOTSTRAP = `import hashlib,json,os,sys
p,h,n,credentials,names=sys.argv[1:]
fd=os.open(p,os.O_RDONLY|os.O_NONBLOCK|os.O_NOFOLLOW)
with os.fdopen(fd,'rb') as f: script=f.read(int(n)+1)
if hashlib.sha256(script).hexdigest()!=h: sys.exit(125)
keys=json.loads(names)
env=dict(os.environ)
if keys:
    fd=os.open(credentials,os.O_RDONLY|os.O_NONBLOCK|os.O_NOFOLLOW)
    with os.fdopen(fd,'rb') as f: values=json.load(f)
    os.unlink(credentials)
    if set(values)!=set(keys) or not all(isinstance(v,str) for v in values.values()): sys.exit(125)
    env.update(values)
os.execve('/bin/sh',['sh','-c',script,p],env)`;

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
        // Read-only patrol: retain everything on timeout and retry next cycle.
        timeout: 3000,
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
