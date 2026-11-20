import { launchFilesStamp as stamp } from "@cardigan/host";

import type { LaunchConfig } from "@cardigan/roles";

export interface LaunchGeneration {
  revision?: number;
  config: LaunchConfig;
  secrets: Readonly<Record<string, string>>;
}

/** One reader per host process. Never expose a partially parsed or superseded pair. */
export async function liveLaunch<T>(
  dir: string,
  load: () => Promise<T>,
  warn: () => void,
  isCurrent: (generation: T) => boolean = () => true,
) {
  let seen = stamp(dir);
  let current: T = await load();
  if (seen !== stamp(dir)) throw new Error("启动时配置文件正在被修改，请重试");
  let pending: Promise<T> | undefined;
  const refresh = async () => {
    if (pending) return pending;
    const key = stamp(dir);
    if (key === seen && isCurrent(current)) return current;
    pending = (async () => {
      try {
        const next = await load();
        if (stamp(dir) === key && isCurrent(next)) {
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
