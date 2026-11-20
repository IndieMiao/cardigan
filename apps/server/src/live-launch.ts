import { launchFilesStamp as stamp } from "@cardigan/host";

/** One reader per host process. Never expose a partially parsed or superseded pair. */
export async function liveLaunch<T>(
  dir: string,
  load: () => Promise<T>,
  warn: () => void,
  onAccept?: (value: T) => void,
) {
  let seen = stamp(dir);
  let current = await load();
  if (seen !== stamp(dir)) throw new Error("启动时配置文件正在被修改，请重试");
  onAccept?.(current);
  let pending: Promise<T> | undefined;
  const refresh = async () => {
    if (pending) return pending;
    const key = stamp(dir);
    if (key === seen) return current;
    pending = (async () => {
      try {
        const next = await load();
        if (stamp(dir) === key) {
          onAccept?.(next);
          current = next;
          seen = key;
        }
      } catch {
        // Do not include parser errors: YAML diagnostics can quote private values.
        warn();
        seen = key;
      }
      return current;
    })().finally(() => {
      pending = undefined;
    });
    return pending;
  };
  return { current: () => current, refresh };
}
