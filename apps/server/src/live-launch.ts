import { launchFilesStamp as stamp } from "@cardigan/host";

import type { LaunchConfig } from "@cardigan/roles";

export interface LaunchGeneration {
  config: LaunchConfig;
  secrets: Readonly<Record<string, string>>;
}

/** Choices must describe a generation the host actually accepted, not the files it last attempted. */
export function selectableLaunchConfig({
  config,
  secrets,
}: LaunchGeneration): LaunchConfig {
  const privateValues = Object.values(secrets).filter(Boolean);
  return {
    ...config,
    profiles: Object.fromEntries(
      Object.entries(config.profiles).filter(
        ([name, profile]) =>
          !!profile.model?.trim() &&
          !privateValues.some((value) => name.includes(value)),
      ),
    ),
  };
}

/** One reader per host process. Never expose a partially parsed or superseded pair. */
export async function liveLaunch<T>(
  dir: string,
  load: () => Promise<T>,
  warn: () => void,
) {
  let seen = stamp(dir);
  let current: T = await load();
  if (seen !== stamp(dir)) throw new Error("启动时配置文件正在被修改，请重试");
  let pending: Promise<T> | undefined;
  const refresh = async () => {
    if (pending) return pending;
    const key = stamp(dir);
    if (key === seen) return current;
    pending = (async () => {
      try {
        const next = await load();
        if (stamp(dir) === key) {
          current = next;
          seen = key;
        }
      } catch {
        // Do not include parser errors: YAML diagnostics can quote private values.
        if (stamp(dir) === key) {
          warn();
          seen = key;
        }
      }
      return current;
    })().finally(() => {
      pending = undefined;
    });
    return pending;
  };
  // A web install already resolved and validated the complete pair. Adopt synchronously
  // inside the publication lock so subsequent reference writes cannot see a deleted profile.
  // Do not mark the disk stamp seen: a concurrent external edit must still be checked.
  const adopt = (next: T) => {
    current = next;
  };
  return { current: () => current, refresh, adopt };
}
