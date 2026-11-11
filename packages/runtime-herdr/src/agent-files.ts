import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  type FileHandle,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  type ExecutionConfig,
  executionPaths,
  executionPermissions,
} from "./execution.js";

export type AgentExecution = Extract<ExecutionConfig, { mode: "agent-ssh" }>;
/** The dispatch sentinel: written after `dispatchRun` commits (M2 §4 step 5–8). */
export const START_FILE_NAME = "start";
export interface LaunchFile {
  readonly path: string;
  readonly content: string;
  readonly mode: number;
}
const directoryFlags =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const at = (handle: FileHandle, name: string) =>
  `/proc/self/fd/${handle.fd}/${name}`;
const code = (error: unknown) => (error as NodeJS.ErrnoException).code;

/** The database and attachments are always private to the host account. */
export async function secureDataDirectory(
  config: ExecutionConfig,
): Promise<void> {
  if (config.mode === "agent-ssh") {
    const handle = await absoluteDirectory(config.dataDir);
    try {
      const entry = await handle.stat();
      if (entry.uid !== process.getuid?.() || (entry.mode & 0o777) !== 0o700)
        throw new Error(
          "Agent mode requires a host-owned private 0700 data directory",
        );
    } finally {
      await handle.close();
    }
    return;
  }
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const entry = await lstat(config.dataDir);
  if (!entry.isDirectory() || entry.uid !== process.getuid?.())
    throw new Error(
      "Data directory must be host-owned and must not be a symlink",
    );
  await chmod(config.dataDir, 0o700);
}
async function absoluteDirectory(path: string): Promise<FileHandle> {
  // Walk from / using pinned directory descriptors; never follow an intermediate symlink.
  let parent = await open("/", directoryFlags);
  try {
    for (const part of resolve(path).split("/").filter(Boolean)) {
      const next = await open(at(parent, part), directoryFlags);
      const entry = await next.stat();
      if (
        ![0, process.getuid?.()].includes(entry.uid) ||
        (entry.mode & 0o022 && !(entry.mode & 0o1000))
      ) {
        await next.close();
        throw new Error("Execution root has an untrusted writable ancestor");
      }
      await parent.close();
      parent = next;
    }
    return parent;
  } catch (error) {
    await parent.close();
    throw error;
  }
}
async function verify(
  handle: FileHandle,
  config: AgentExecution,
  mode: number,
) {
  const entry = await handle.stat();
  if (
    entry.uid !== process.getuid?.() ||
    entry.gid !== config.gid ||
    (entry.mode & 0o7777) !== mode
  )
    throw new Error(
      "Agent directory ownership or permissions do not match the installation",
    );
}
async function child(
  parent: FileHandle,
  name: string,
  config: AgentExecution,
  mode: number,
  create = true,
) {
  let created = false;
  if (create) {
    try {
      await mkdir(at(parent, name), { mode: 0o700 });
      created = true;
    } catch (error) {
      if (code(error) !== "EEXIST") throw error;
    }
  }
  const handle = await open(at(parent, name), directoryFlags);
  try {
    if (created) {
      await handle.chown(process.getuid?.() ?? -1, config.gid);
      await handle.chmod(mode);
    }
    await verify(handle, config, mode);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}
async function agentRoot(config: AgentExecution) {
  if (
    process.platform !== "linux" ||
    !process.getgroups?.().includes(config.gid)
  )
    throw new Error(
      "Agent mode requires Linux and membership of the installed shared group",
    );
  const root = await absoluteDirectory(config.agentRoot);
  try {
    await verify(root, config, 0o2750);
    return root;
  } catch (error) {
    await root.close();
    throw error;
  }
}
async function projectDirectory(
  root: FileHandle,
  area: string,
  project: string,
  config: AgentExecution,
  create = true,
) {
  const parent = await child(root, area, config, 0o2750, create);
  try {
    return await child(parent, project, config, 0o2750, create);
  } finally {
    await parent.close();
  }
}
/** Protect namespace parents before any Agent or Git process gets a writable leaf. */
export async function prepareAgentProject(
  config: AgentExecution,
  project: string,
  assignment: string,
) {
  const paths = executionPaths(config, project, assignment);
  await secureDataDirectory(config);
  const root = await agentRoot(config);
  try {
    for (const area of ["runs", "worktrees", "inputs"]) {
      const parent = await projectDirectory(root, area, project, config);
      try {
        if (area === "runs")
          await (await child(parent, assignment, config, 0o2770)).close();
      } finally {
        await parent.close();
      }
    }
    await (await child(root, "repos", config, 0o2750)).close();
  } finally {
    await root.close();
  }
  return { ...paths, inputsDir: join(config.agentRoot, "inputs", project) };
}
async function runDirectory(
  config: AgentExecution,
  project: string,
  assignment: string,
) {
  executionPaths(config, project, assignment);
  const root = await agentRoot(config);
  try {
    const parent = await projectDirectory(root, "runs", project, config, false);
    try {
      return await child(parent, assignment, config, 0o2770, false);
    } finally {
      await parent.close();
    }
  } finally {
    await root.close();
  }
}

/** Exclusive, protected leaf for a host-selected temporary checkout (P2a-1/P2a-3). */
export async function prepareAgentCheckout(
  config: AgentExecution,
  project: string,
  attempt: string,
): Promise<string> {
  executionPaths(config, project, "A-1");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/u.test(attempt))
    throw new Error("Invalid checkout attempt");
  await secureDataDirectory(config);
  const root = await agentRoot(config);
  try {
    const parent = await projectDirectory(root, "checks", project, config);
    try {
      // Unlike run directories, a check must never reuse a previous attempt.
      await mkdir(at(parent, attempt), { mode: 0o700 });
      const leaf = await open(at(parent, attempt), directoryFlags);
      try {
        await leaf.chown(process.getuid?.() ?? -1, config.gid);
        await leaf.chmod(0o2770);
      } finally {
        await leaf.close();
      }
      return join(config.agentRoot, "checks", project, attempt);
    } finally {
      await parent.close();
    }
  } finally {
    await root.close();
  }
}

/** Short, exclusive host-controlled namespace; the execution account creates its private child. */
export async function prepareCheckoutAlias(
  config: ExecutionConfig,
  name: string,
) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/u.test(name))
    throw new Error("Invalid checkout alias");
  if (config.mode === "local") {
    await secureDataDirectory(config);
    const parent = join(config.dataDir, "s");
    await mkdir(parent, { mode: 0o700 }).catch((error) => {
      if (code(error) !== "EEXIST") throw error;
    });
    const info = await lstat(parent);
    if (
      !info.isDirectory() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o777) !== 0o700 ||
      (await realpath(parent)) !== parent
    )
      throw new Error("Unsafe checkout alias namespace");
    const path = join(parent, name);
    await mkdir(path, { mode: 0o700 });
    return path;
  }
  const root = await agentRoot(config);
  try {
    const parent = await child(root, "s", config, 0o2750);
    try {
      await mkdir(at(parent, name), { mode: 0o700 });
      const leaf = await open(at(parent, name), directoryFlags);
      try {
        await leaf.chown(process.getuid?.() ?? -1, config.gid);
        await leaf.chmod(0o2770);
      } finally {
        await leaf.close();
      }
      return join(config.agentRoot, "s", name);
    } finally {
      await parent.close();
    }
  } finally {
    await root.close();
  }
}

/** Lock file of a merge-check slot; slot 0 keeps the historical name. */
export function checkLockName(slot = 0): string {
  if (!Number.isSafeInteger(slot) || slot < 0 || slot > 63)
    throw new Error("Invalid merge check slot");
  return slot === 0 ? "merge-check.lock" : `merge-check-${slot}.lock`;
}

/**
 * Persistent empty lock inode shared by every project in this machine's execution root.
 * P2a-12 D: an execution target with `max_concurrent` > 1 has one lock per slot.
 */
export async function prepareCheckLock(
  config: ExecutionConfig,
  slot = 0,
): Promise<string> {
  const name = checkLockName(slot);
  if (process.platform !== "linux")
    throw new Error("Serialized checks require Linux flock");
  await secureDataDirectory(config);
  const path = config.mode === "agent-ssh" ? config.agentRoot : config.dataDir;
  const root =
    config.mode === "agent-ssh"
      ? await agentRoot(config)
      : await absoluteDirectory(path);
  try {
    const file = await open(
      at(root, name),
      constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const entry = await file.stat();
      if (
        !entry.isFile() ||
        entry.uid !== process.getuid?.() ||
        entry.nlink !== 1 ||
        entry.size !== 0 ||
        ![0o600, 0o660].includes(entry.mode & 0o7777)
      )
        throw new Error("Unsafe merge check lock");
      if (config.mode === "agent-ssh")
        await file.chown(process.getuid?.() ?? -1, config.gid);
      await file.chmod(config.mode === "agent-ssh" ? 0o660 : 0o600);
    } finally {
      await file.close();
    }
    return join(path, name);
  } finally {
    await root.close();
  }
}
async function writeAt(
  parent: FileHandle,
  name: string,
  content: string,
  mode: number,
  gid: number | undefined,
) {
  const temporary = `.cardigan-${randomUUID()}`;
  const file = await open(
    at(parent, temporary),
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(content);
    if (gid !== undefined) await file.chown(process.getuid?.() ?? -1, gid);
    await file.chmod(mode);
    // Replaces a destination link itself, never its target. The parent FD is pinned.
    await rename(at(parent, temporary), at(parent, name));
  } finally {
    await file.close();
    await unlink(at(parent, temporary)).catch((error) => {
      if (code(error) !== "ENOENT") throw error;
    });
  }
}
export async function writeAgentLaunch(
  config: AgentExecution,
  project: string,
  assignment: string,
  files: readonly LaunchFile[],
  token: string,
) {
  const { runDir } = await prepareAgentProject(config, project, assignment);
  const entries = [
    ...files,
    { path: join(runDir, "token"), content: `${token}\n`, mode: 0o600 },
  ].map((file) => {
    const path = relative(runDir, file.path);
    if (!path || path === ".." || path.startsWith("../") || isAbsolute(path))
      throw new Error("Launch file is outside its run directory");
    return { ...file, parts: path.split("/") };
  });
  const root = await runDirectory(config, project, assignment);
  const permissions = executionPermissions(config);
  try {
    for (const file of entries) {
      let parent = root;
      try {
        for (const part of file.parts.slice(0, -1)) {
          const next = await child(parent, part, config, permissions.directory);
          if (parent !== root) await parent.close();
          parent = next;
        }
        const name = file.parts.at(-1);
        if (!name) throw new Error("Empty launch filename");
        await writeAt(
          parent,
          name,
          file.content,
          file.mode & 0o111 ? permissions.executable : permissions.file,
          config.gid,
        );
      } finally {
        if (parent !== root) await parent.close();
      }
    }
  } finally {
    await root.close();
  }
}
export async function scrubAgentLaunch(
  config: AgentExecution,
  project: string,
  assignment: string,
) {
  let root: FileHandle;
  try {
    root = await runDirectory(config, project, assignment);
  } catch (error) {
    if (code(error) === "ENOENT") return;
    throw error;
  }
  try {
    for (const name of ["token", "secrets.env", START_FILE_NAME])
      await unlink(at(root, name)).catch((error) => {
        if (code(error) !== "ENOENT") throw error;
      });
  } finally {
    await root.close();
  }
}

/**
 * Open the run directory without following a symlink, then write or remove the
 * dispatch sentinel through that pinned descriptor. Both modes need this: in
 * agent-ssh the directory is writable by the shared Agent account, and in local
 * mode the Agent runs as the same user, so either could plant `start` as a link
 * to a host file and have the host follow it.
 */
async function openRunDirectory(
  config: ExecutionConfig,
  project: string,
  assignment: string,
): Promise<FileHandle> {
  const { runDir } = executionPaths(config, project, assignment);
  if (config.mode === "agent-ssh")
    return runDirectory(config, project, assignment);
  return open(runDir, directoryFlags);
}

/** Write the sentinel without ever following a link at that name. */
export async function writeAgentSentinel(
  config: ExecutionConfig,
  project: string,
  assignment: string,
): Promise<void> {
  const permissions = executionPermissions(config);
  const dir = await openRunDirectory(config, project, assignment);
  try {
    await writeAt(
      dir,
      START_FILE_NAME,
      "",
      permissions.file,
      config.mode === "agent-ssh" ? config.gid : undefined,
    );
  } finally {
    await dir.close();
  }
}

/** Remove a stale sentinel (and the link itself, never its target). */
export async function clearAgentSentinel(
  config: ExecutionConfig,
  project: string,
  assignment: string,
): Promise<void> {
  let dir: FileHandle;
  try {
    dir = await openRunDirectory(config, project, assignment);
  } catch (error) {
    if (code(error) === "ENOENT") return;
    throw error;
  }
  try {
    await unlink(at(dir, START_FILE_NAME)).catch((error) => {
      if (code(error) !== "ENOENT") throw error;
    });
  } finally {
    await dir.close();
  }
}
