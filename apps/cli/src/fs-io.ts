import { type BigIntStats, constants, statSync } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { CliError, EXIT } from "./errors.js";

/** Read a UTF-8 text file, or `undefined` when it does not exist. */
export async function readTextIfExists(
  path: string,
): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

// Metadata only: bind a preflight to the opened inode (or its absence), not to secret bytes.
function secretVersion(s: BigIntStats | undefined): string | undefined {
  return s && `${s.dev}:${s.ino}:${s.mode}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
}

export function currentSecretsVersion(path: string): string | undefined {
  return secretVersion(statSync(path, { bigint: true, throwIfNoEntry: false }));
}

/**
 * Read `secrets.env`, refusing a file whose permission bits are not exactly
 * 0600. The refusal message contains the `chmod` command to run, never a value.
 */
export async function readSecretsFile(
  path: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  return (await readSecretsSnapshot(path, platform)).text;
}

export async function readSecretsSnapshot(
  path: string,
  platform: NodeJS.Platform = process.platform,
): Promise<{ text: string | undefined; version: string | undefined }> {
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(path, "r");
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return { text: undefined, version: undefined };
    }
    throw error;
  }

  // Windows has no POSIX permission bits; there is nothing to check there.
  try {
    const opened = await file.stat({ bigint: true });
    if (platform !== "win32") {
      const mode = Number(opened.mode & 0o777n);
      if (mode !== 0o600) {
        throw new CliError(`密钥文件权限不是 600：${path}`, EXIT.usage, [
          `当前权限是 ${mode.toString(8).padStart(4, "0")}`,
          `修复：chmod 600 ${path}`,
        ]);
      }
    }

    return {
      text: await file.readFile("utf8"),
      version: secretVersion(opened),
    };
  } finally {
    await file.close();
  }
}

/** Write a file, creating parent directories, and force the given mode. */
export async function writeFileWithMode(
  path: string,
  content: string,
  mode: number,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, content, { encoding: "utf8", mode });
  // `writeFile` honours the process umask, which may widen or narrow the mode.
  await chmod(path, mode);
}

export async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
}

export async function removeFileIfExists(path: string): Promise<void> {
  await rm(path, { force: true });
}

/**
 * Find an executable on `PATH` without running it. Returns the absolute path,
 * or `undefined` when the command is not installed.
 */
export async function findExecutable(
  command: string,
  pathValue: string | undefined,
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  if (
    command.includes("/") ||
    (platform === "win32" && command.includes("\\"))
  ) {
    return (await isExecutable(command, platform)) ? command : undefined;
  }

  const searchPath = pathValue ?? "/usr/local/bin:/usr/bin:/bin";
  const extensions =
    platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
      : [""];

  for (const dir of searchPath.split(delimiter)) {
    if (dir.length === 0) {
      continue;
    }
    for (const extension of extensions) {
      const candidate = join(dir, `${command}${extension}`);
      if (await isExecutable(candidate, platform)) {
        return isAbsolute(candidate) ? candidate : join(dir, candidate);
      }
    }
  }
  return undefined;
}

async function isExecutable(
  path: string,
  platform: NodeJS.Platform,
): Promise<boolean> {
  try {
    await access(path, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
