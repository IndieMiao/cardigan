import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

/** Data paths must satisfy the same no-symlink/private-ancestor checks as production. */
export function createPrivateTestRoot(): string {
  // TMPDIR may be a short alias into a host-owned/shared Agent attempt. This is
  // a real, exclusively created directory, never a global short-path symlink.
  const parent = realpathSync(process.platform === "win32" ? tmpdir() : "/tmp");
  return mkdtempSync(join(parent, "cg-test-"));
}

// Capture before individual fixtures override their environments. Nested hc
// processes must stay inside the check supervisor's controlled runtime root.
const inheritedRuntime = process.env.XDG_RUNTIME_DIR;
const runtimes = new Set<string>();

export function createTestRuntime(fallback: string): string {
  const parent = inheritedRuntime ?? fallback;
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(parent, "r"));
  runtimes.add(root);
  return root;
}

/** Call only after the recorded core/holder PIDs have stopped. */
export function removeTestRuntime(socket: string): void {
  for (const root of runtimes) {
    if (!socket.startsWith(root + sep)) continue;
    if (existsSync(socket))
      throw new Error("Refusing to remove a live hc socket");
    rmSync(root, { recursive: true });
    runtimes.delete(root);
    return;
  }
}

/** Never recursively remove data or sockets left by an unfinished fixture. */
export function removeEmptyTestRoot(root: string): void {
  try {
    rmdirSync(root);
  } catch (error) {
    if (
      !["ENOENT", "ENOTEMPTY", "EEXIST"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      throw error;
  }
}
