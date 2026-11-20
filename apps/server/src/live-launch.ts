import { launchFilesStamp as stamp } from "@cardigan/host";

/** Each process has a reader; only the owner of the background lock registers a publisher. */
export async function liveLaunch<T>(
  dir: string,
  load: () => Promise<T>,
  warn: () => void,
) {
  let seen = stamp(dir);
  let current = await load();
  if (seen !== stamp(dir)) throw new Error("启动时配置文件正在被修改，请重试");
  let publisher: ((value: T) => void) | undefined;
  let pending: Promise<T> | undefined;
  let publishWarning: string | undefined;
  const refresh = async () => {
    if (pending) return pending;
    const key = stamp(dir);
    if (key === seen) return current;
    pending = (async () => {
      let next: Awaited<T>;
      try {
        next = await load();
      } catch {
        // Do not include parser errors: YAML diagnostics can quote private values.
        warn();
        seen = key;
        return current;
      }
      if (stamp(dir) !== key) return current;
      try {
        publisher?.(next);
      } catch {
        // A busy store is not a rejected generation. Retry without another file edit.
        if (publishWarning !== key)
          console.warn(
            "启动配置暂未生效：无法登记浏览器目录，将在下次刷新重试。",
          );
        publishWarning = key;
        return current;
      }
      publishWarning = undefined;
      current = next;
      seen = key;
      return current;
    })().finally(() => {
      pending = undefined;
    });
    return pending;
  };
  return {
    current: () => current,
    refresh,
    publishWhileOwned(publish: (value: T) => void) {
      publish(current);
      publisher = publish;
      return () => {
        publisher = undefined;
      };
    },
  };
}
