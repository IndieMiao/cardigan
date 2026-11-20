import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  agentProcessCommand,
  type ExecutionConfig,
} from "@cardigan/runtime-herdr";
import type { ProbeCommand } from "./resource-policy.js";

// The checked binary and its ancestors must not be replaceable by an employee.
// argv is administrator configuration, never shell text or work-item data.
const wrapper = `import os,sys,json,pathlib,stat,subprocess
argv=json.loads(sys.argv[1]); context=json.loads(sys.argv[2]); path=pathlib.Path(argv[0]);
for p in (*path.parents,path):
 s=p.lstat()
 if stat.S_ISLNK(s.st_mode) or s.st_uid!=0 or s.st_mode&0o022: sys.exit(1)
if not path.is_file() or not os.access(path,os.X_OK): sys.exit(1)
if context['action']=='available': sys.exit(0)
env={'PATH':'/usr/bin:/bin','CARDIGAN_RESOURCE_CONTEXT':json.dumps(context)}
subprocess.run(argv,env=env,cwd='/',stdin=subprocess.DEVNULL,stdout=None if context['action']=='release' else subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=5,check=True)`;
export type ProbeContext = {
  action: "release" | "check" | "available";
  project: string;
  machine: string;
  key: string;
  generation?: string;
  purpose?: "activation";
  run_id?: string;
  port?: number;
  device?: string;
};
export type ResourceProbe = (
  argv: ProbeCommand | undefined,
  context: ProbeContext,
  expectedTarget?: string,
) => Promise<string | undefined>;
export function targetProbe(
  resolve: (
    project: string,
    machine: string,
  ) => Promise<ExecutionConfig> | ExecutionConfig,
): ResourceProbe {
  return async (argv, context, expectedTarget) => {
    try {
      const config = await resolve(context.project, context.machine);
      if (
        config.target &&
        (config.target.machine_id !== context.machine ||
          config.target.project_id !== context.project)
      )
        return undefined;
      if (
        context.machine !== "local" &&
        (config.mode !== "agent-ssh" ||
          config.target?.machine_id !== context.machine ||
          config.target.project_id !== context.project)
      )
        return undefined;
      const target =
        config.target?.fingerprint ??
        (config.mode === "local" && context.machine === "local"
          ? "local"
          : undefined);
      if (!target || (expectedTarget && expectedTarget !== target))
        return undefined;
      if (!argv) return target;
      const args = [
        "/usr/bin/python3",
        "-I",
        "-B",
        "-c",
        wrapper,
        JSON.stringify(argv),
        JSON.stringify(context),
      ];
      const cmd =
        config.mode === "agent-ssh"
          ? await agentProcessCommand(config, args)
          : { file: "/usr/bin/python3", args: args.slice(1) };
      const { stdout } = await promisify(execFile)(cmd.file, cmd.args, {
        cwd: "/",
        env: { PATH: "/usr/bin:/bin" },
        timeout: 10_000,
        killSignal: "SIGKILL",
        maxBuffer: 4096,
      });
      if (
        context.action === "release" &&
        (!context.generation || stdout.trim() !== context.generation)
      )
        return undefined;
      return target;
    } catch {
      return undefined;
    }
  };
}
