import { dirname, join } from "node:path";
import { getHarnessAdapter, HARNESSES } from "@cardigan/roles";
import { runtimeWorkersPath } from "./runtime-workers-config.js";
import { readOnboardingYaml } from "./worker-onboarding-config.js";

export interface CapabilityDefinition {
  readonly key: string;
  readonly os: readonly ("linux" | "darwin")[];
  readonly check: readonly string[];
  readonly version?: readonly string[];
  readonly parseVersion: (output: string) => string | null;
  readonly acceptsOutput?: (output: string) => boolean;
}
/** Never persist a banner, account name, credential, or arbitrary command output. */
export function parseCapabilityVersion(output: string): string | null {
  return (
    /(?:^|[^\w.])v?(\d{1,6}(?:\.\d{1,6}){1,3})(?!\d)/u.exec(output)?.[1] ?? null
  );
}
function tool(
  key: string,
  command: readonly string[],
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
  tool("browser.chromium", [
    "/bin/sh",
    "-c",
    'for bin in chromium chromium-browser google-chrome "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux*/chrome "$HOME"/Library/Caches/ms-playwright/chromium-*/chrome-mac*/Chromium.app/Contents/MacOS/Chromium; do if command -v "$bin" >/dev/null 2>&1; then exec "$bin" --version; fi; done; exit 1',
  ]),
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
): readonly CapabilityDefinition[] {
  if (value === undefined) return BUILTIN_MACHINE_CAPABILITIES;
  const raw = object(value);
  if (
    raw.version !== 1 ||
    Object.keys(raw).some((k) => !["version", "capabilities"].includes(k))
  )
    return invalid();
  const custom = Object.entries(object(raw.capabilities));
  if (custom.length > 64) return invalid();
  return [
    ...BUILTIN_MACHINE_CAPABILITIES,
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
) {
  try {
    return parseMachineCapabilityCatalog(
      readOnboardingYaml(
        join(dirname(runtimeWorkersPath(env)), "machine-capabilities.yaml"),
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return BUILTIN_MACHINE_CAPABILITIES;
    throw new Error("Machine capability configuration invalid");
  }
}
