import { statSync } from "node:fs";
import { join } from "node:path";

/** Include inode and ctime: atomic replacements and chmod are changes too. */
export function launchFilesStamp(dir: string) {
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
