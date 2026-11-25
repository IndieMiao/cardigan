import type { ExecutionConfig } from "@cardigan/runtime-herdr";
import {
  type AdbProbe,
  adbTargetProbe,
  runOnTarget,
} from "./adb-slot-probe.js";
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
export type ResourceProbe = ((
  argv: ProbeCommand | undefined,
  context: ProbeContext,
  expectedTarget?: string,
) => Promise<string | undefined>) & { adb?: AdbProbe };
type ResolveTarget = (
  project: string,
  machine: string,
  expectedTarget?: string,
) => Promise<ExecutionConfig> | ExecutionConfig;

/** The pinned execution target for a project and machine, or undefined. */
async function resolveTarget(
  resolve: ResolveTarget,
  context: { project: string; machine: string },
  expectedTarget?: string,
) {
  const config = await resolve(
    context.project,
    context.machine,
    expectedTarget,
  );
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
  return { config, target };
}

export function targetProbe(resolve: ResolveTarget): ResourceProbe {
  const probe: ResourceProbe = async (argv, context, expectedTarget) => {
    try {
      const resolved = await resolveTarget(resolve, context, expectedTarget);
      if (!resolved) return undefined;
      const { config, target } = resolved;
      if (!argv) return target;
      const stdout = await runOnTarget(config, [
        "-I",
        "-B",
        "-c",
        wrapper,
        JSON.stringify(argv),
        JSON.stringify(context),
      ]);
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
  // C-679: the built-in adb slot cleanup runs on the same pinned target.
  probe.adb = adbTargetProbe(async (context, expectedTarget) => {
    try {
      return await resolveTarget(resolve, context, expectedTarget);
    } catch {
      return undefined;
    }
  });
  return probe;
}
