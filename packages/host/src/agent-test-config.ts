import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseDocument } from "yaml";

/** Host policy, never discovered from the project or its worktree. */
export async function loadAgentTestWorkers(
  configDir?: string,
): Promise<number> {
  const file = join(
    resolve(
      configDir ??
        process.env.CARDIGAN_CONFIG_DIR ??
        join(homedir(), ".config", "cardigan"),
    ),
    "agent-tests.yaml",
  );
  let source: string;
  try {
    const handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        ![0, process.getuid?.()].includes(info.uid) ||
        info.mode & 0o022 ||
        info.size > 1024 * 1024
      )
        throw new Error("Unsafe config");
      for (let parent = dirname(file); ; parent = dirname(parent)) {
        const entry = await lstat(parent);
        if (
          !entry.isDirectory() ||
          ![0, process.getuid?.()].includes(entry.uid) ||
          (entry.mode & 0o022 && !(entry.mode & 0o1000))
        )
          throw new Error("Unsafe config directory");
        if (parent === dirname(parent)) break;
      }
      source = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 4;
    throw new Error("无法安全读取主机 agent-tests.yaml，拒绝启动员工会话");
  }
  try {
    const doc = parseDocument(source, { uniqueKeys: true, strict: true });
    if (doc.errors.length || doc.warnings.length)
      throw new Error("Invalid YAML");
    const raw = doc.toJS({ maxAliasCount: 0 });
    if (
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      Object.keys(raw).some((key) => key !== "max_workers")
    )
      throw new Error("Invalid fields");
    const workers = raw.max_workers === undefined ? 4 : raw.max_workers;
    if (!Number.isSafeInteger(workers) || workers < 1)
      throw new Error("Invalid workers");
    return workers;
  } catch {
    throw new Error(
      "主机 agent-tests.yaml 只接受正整数 max_workers；配置无效，拒绝启动员工会话",
    );
  }
}
