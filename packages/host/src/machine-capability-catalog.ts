import { dirname, join } from "node:path";
import { getHarnessAdapter, HARNESSES } from "@cardigan/roles";
import {
  type CapabilityCommand,
  chromiumSearch,
  VERSION_PATTERN,
} from "./chromium-search.js";
import { runtimeWorkersPath } from "./runtime-workers-config.js";
import { readOnboardingYaml } from "./worker-onboarding-config.js";

export interface CapabilityDefinition {
  readonly key: string;
  readonly os: readonly ("linux" | "darwin")[];
  readonly check: CapabilityCommand;
  readonly version?: CapabilityCommand;
  readonly parseVersion: (output: string) => string | null;
  readonly acceptsOutput?: (output: string) => boolean;
  /** Readable reason kept with the observation; output is undefined when the command failed. */
  readonly failureReason?: (output: string | undefined) => string | undefined;
}
const versionRegex = new RegExp(VERSION_PATTERN, "u");
/** Never persist a banner, account name, credential, or arbitrary command output. */
export function parseCapabilityVersion(output: string): string | null {
  return versionRegex.exec(output)?.[1] ?? null;
}
function tool(
  key: string,
  command: CapabilityCommand,
  os: CapabilityDefinition["os"] = ["linux", "darwin"],
): CapabilityDefinition {
  return {
    key,
    os,
    check: command,
    version: command,
    parseVersion: parseCapabilityVersion,
  };
}
function chromiumCapability(os: string, browsersPath?: string) {
  return tool("browser.chromium", chromiumSearch(os, browsersPath));
}
export const BUILTIN_MACHINE_CAPABILITIES: readonly CapabilityDefinition[] = [
  ...HARNESSES.map((harness) => {
    const { binary, versionArgs } = getHarnessAdapter(harness);
    return tool(`harness.${harness}`, [binary, ...versionArgs]);
  }),
  tool("blender", ["blender", "--version"]),
  tool("godot", ["godot", "--version"]),
  tool(
    "gpu.nvidia",
    ["nvidia-smi", "--query-gpu=driver_version", "--format=csv,noheader"],
    ["linux"],
  ),
  {
    ...tool("gpu.apple", ["/usr/bin/sw_vers", "-productVersion"], ["darwin"]),
    check: [
      "/bin/sh",
      "-c",
      "/usr/sbin/system_profiler SPDisplaysDataType | /usr/bin/grep -q 'Chipset Model: Apple'",
    ],
  },
  tool("android.sdk", ["adb", "version"]),
  tool("android.emulator", ["emulator", "-version"]),
  tool("xcode", ["xcodebuild", "-version"], ["darwin"]),
  {
    ...tool("ios.simulator", ["xcodebuild", "-version"], ["darwin"]),
    check: ["xcrun", "simctl", "list", "runtimes", "--json"],
    acceptsOutput: (output) => {
      try {
        const result = JSON.parse(output);
        return (
          Array.isArray(result.runtimes) &&
          result.runtimes.some(
            (runtime: { isAvailable?: unknown; identifier?: unknown }) =>
              runtime.isAvailable === true &&
              typeof runtime.identifier === "string" &&
              runtime.identifier.startsWith(
                "com.apple.CoreSimulator.SimRuntime.iOS-",
              ),
          )
        );
      } catch {
        return false;
      }
    },
  },
  tool("docker", ["docker", "version", "--format", "{{.Server.Version}}"]),
  tool("node", ["node", "--version"]),
  tool("python", ["python3", "--version"]),
  chromiumCapability(process.platform),
];
const invalid = (): never => {
  throw new Error("Machine capability configuration invalid");
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid();
  return value as Record<string, unknown>;
}
function command(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 32 ||
    value.some(
      (v) => typeof v !== "string" || v.length > 1024 || /\p{Cc}/u.test(v),
    ) ||
    !value[0]
  )
    return invalid();
  return value;
}
export function parseMachineCapabilityCatalog(
  value: unknown,
  browsersPath?: string,
  os: string = process.platform,
): readonly CapabilityDefinition[] {
  const builtins =
    browsersPath || os !== process.platform
      ? BUILTIN_MACHINE_CAPABILITIES.map((entry) =>
          entry.key === "browser.chromium"
            ? chromiumCapability(os, browsersPath)
            : entry,
        )
      : BUILTIN_MACHINE_CAPABILITIES;
  if (value === undefined) return builtins;
  const raw = object(value);
  if (
    raw.version !== 1 ||
    Object.keys(raw).some((k) => !["version", "capabilities"].includes(k))
  )
    return invalid();
  const custom = Object.entries(object(raw.capabilities));
  if (custom.length > 64) return invalid();
  return [
    ...builtins,
    ...custom.map(([key, value]) => {
      if (
        !/^[a-z][a-z0-9.-]{0,63}$/u.test(key) ||
        BUILTIN_MACHINE_CAPABILITIES.some((c) => c.key === key)
      )
        return invalid();
      const entry = object(value);
      if (
        Object.keys(entry).some((k) => !["os", "check", "version"].includes(k))
      )
        return invalid();
      const os = entry.os ?? ["linux", "darwin"];
      if (
        !Array.isArray(os) ||
        !os.length ||
        os.some((v) => !["linux", "darwin"].includes(v))
      )
        return invalid();
      return {
        key,
        os: os as CapabilityDefinition["os"],
        check: command(entry.check),
        ...(entry.version === undefined
          ? {}
          : { version: command(entry.version) }),
        parseVersion: parseCapabilityVersion,
      };
    }),
  ];
}
/** Host-owned 0600 file under the private configuration directory, never project YAML. */
export function loadMachineCapabilityCatalog(
  env: NodeJS.ProcessEnv = process.env,
  browsersPath?: string,
  os: string = process.platform,
) {
  try {
    return parseMachineCapabilityCatalog(
      readOnboardingYaml(
        join(dirname(runtimeWorkersPath(env)), "machine-capabilities.yaml"),
      ),
      browsersPath,
      os,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return parseMachineCapabilityCatalog(undefined, browsersPath, os);
    throw new Error("Machine capability configuration invalid");
  }
}
