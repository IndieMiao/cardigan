import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/** Filesystem answers that mean "no such worktree directory here". */
const ABSENT = new Set(["ENOENT", "ENOTDIR"]);

/**
 * C-235: the canonical path pi 1.4 will look up for a worktree it starts in.
 *
 * pi's trust-manager keys `trust.json` by `canonicalizePath(resolvePath(cwd))`,
 * i.e. `realpath`. A worktree under a symlinked ancestor (for example a data
 * directory mounted through a link) therefore needs its real path as the key.
 *
 * Only the ancestors may be links. If the worktree leaf itself is a symlink,
 * its target is not the directory Cardigan created and could be a parent
 * folder or another repository, so this returns `undefined` and the caller
 * writes no pre-trust at all (pi then shows its prompt: fail closed). A
 * missing path or a non-directory is treated the same way.
 *
 * Any other filesystem error (EACCES, EIO, ELOOP, ...) is unexpected for a
 * worktree the host just prepared: it is rethrown with the path so the launch
 * fails visibly and the normal start compensation runs, instead of silently
 * dispatching a pi session that will stop at the trust prompt.
 */
export async function piTrustedWorktreePath(
  worktree: string,
): Promise<string | undefined> {
  if (!isAbsolute(worktree)) return undefined;
  const path = resolve(worktree);
  if (dirname(path) === path) return undefined;
  try {
    const leaf = await lstat(path);
    if (!leaf.isDirectory()) return undefined;
    const real = await realpath(path);
    if (real !== join(await realpath(dirname(path)), basename(path)))
      return undefined;
    return real;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== undefined && ABSENT.has(code)) return undefined;
    throw new Error(
      `Cannot resolve the pi trust path of worktree ${path}: ${code ?? (error as Error).message}`,
      { cause: error },
    );
  }
}
