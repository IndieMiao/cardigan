import { statSync } from "node:fs";
import { join } from "node:path";

/**
 * One launch file's stamp. Include inode and ctime: atomic replacements and
 * chmod are changes too. Throws when the file cannot be stat'ed.
 */
export function launchFileStamp(path: string) {
  const s = statSync(path, { bigint: true });
  return `${s.dev}:${s.ino}:${s.size}:${s.ctimeNs}:${s.mtimeNs}`;
}

export function launchFilesStamp(dir: string) {
  return ["launch.yaml", "secrets.env"]
    .map((name) => {
      try {
        return launchFileStamp(join(dir, name));
      } catch (error) {
        return (error as NodeJS.ErrnoException).code;
      }
    })
    .join("/");
}

/**
 * `files` (a `launchFilesStamp`) with the secrets.env part replaced by an
 * already verified `launchFileStamp`; the launch.yaml part is kept as it was.
 */
export function withSecretsStamp(files: string, secrets: string) {
  const [yaml] = files.split("/");
  return `${yaml}/${secrets}`;
}
