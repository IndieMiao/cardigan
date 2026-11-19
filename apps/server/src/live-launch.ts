import { statSync } from "node:fs";
import { join } from "node:path";

/** Include inode and ctime: atomic replacements and chmod are changes too. */
function stamp(dir: string) {
  return ["launch.yaml", "secrets.env"]
    .map((name) => {
      try {
        const s = statSync(join(dir, name), { bigint: true });
        return `${s.dev}:${s.ino}:${s.size}:${s.ctimeNs}:${s.mtimeNs}`;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code;
      }
    })
    .join("/");
}

/** One reader per host process. Never expose a partially parsed or superseded pair. */
export async function liveLaunch<T>(
  dir: string,
  load: () => Promise<T>,
  warn: () => void,
) {
  let seen = stamp(dir);
  let current = await load();
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
