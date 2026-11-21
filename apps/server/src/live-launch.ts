import { launchFilesStamp as stamp } from "@cardigan/host";
import type { LaunchConfig } from "@cardigan/roles";

export interface LaunchGeneration {
  revision?: number;
  config: LaunchConfig;
  secrets: Readonly<Record<string, string>>;
}

/** Each process has a reader; only the owner of the background lock registers a publisher. */
export async function liveLaunch<T>(
  dir: string,
  load: () => Promise<T>,
  warn: () => void,
  isCurrent: (generation: T) => boolean = () => true,
) {
  let seen = stamp(dir);
  let current: T = await load();
  if (seen !== stamp(dir)) throw new Error("启动时配置文件正在被修改，请重试");
  let publisher: ((value: T) => void) | undefined;
  let pending: Promise<T> | undefined;
  let publishWarning: string | undefined;
  const retryPublication = (key: string) => {
    if (publishWarning !== key)
      console.warn("启动配置暂未生效：无法登记配置，将在下次刷新重试。");
    publishWarning = key;
  };
  const adopt = (next: T, key = stamp(dir)) => {
    try {
      publisher?.(next);
    } catch {
      retryPublication(key);
      return false;
    }
    publishWarning = undefined;
    current = next;
    return true;
  };
  const refresh = async () => {
    if (pending) return pending;
    const key = stamp(dir);
    if (key === seen && !publishWarning && isCurrent(current)) return current;
    pending = (async () => {
      let next: Awaited<T>;
      try {
        next = await load();
      } catch (error) {
        if (stamp(dir) !== key) return current;
        // Loading now takes the catalog publication lock as well. Contention
        // is not a parse failure and cannot be audited under the same lock.
        if (
          error &&
          typeof error === "object" &&
          "errcode" in error &&
          typeof error.errcode === "number" &&
          (error.errcode & 0xff) === 5
        ) {
          retryPublication(key);
        } else {
          // Do not include parser errors: YAML diagnostics can quote private values.
          warn();
          publishWarning = undefined;
          seen = key;
        }
        return current;
      }
      if (stamp(dir) === key && isCurrent(next) && adopt(next, key)) seen = key;
      return current;
    })().finally(() => {
      pending = undefined;
    });
    return pending;
  };
  return {
    current: () => current,
    refresh,
    // Do not mark the disk stamp seen on a web adoption: an external edit may follow it.
    adopt,
    publishWhileOwned(publish: (value: T) => void) {
      publish(current);
      publisher = publish;
      return () => {
        publisher = undefined;
      };
    },
  };
}
