import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_RUN_LIMIT } from "@cardigan/domain";
import { parseDocument } from "yaml";

export interface RunCapacityConfiguration {
  readonly errors: readonly string[];
  forMachine(machine: string): number;
}

/** Same trust boundary as merge-gate.yaml. Read once; changing the file needs a restart. */
export async function loadRunCapacityConfig(
  input: {
    readonly configDir?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
  } = {},
): Promise<RunCapacityConfiguration> {
  const env = input.env ?? process.env;
  const file = join(
    resolve(
      input.configDir ??
        env.CARDIGAN_CONFIG_DIR ??
        join(homedir(), ".config", "cardigan"),
    ),
    "run-capacity.yaml",
  );
  const limits = new Map<string, number>();
  const errors: string[] = [];
  const result = (): RunCapacityConfiguration => ({
    errors,
    // Invalid configuration fails closed for work items; standing PMs remain exempt.
    forMachine: (machine) =>
      errors.length ? 0 : (limits.get(machine) ?? DEFAULT_RUN_LIMIT),
  });
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
        throw new Error("Unsafe config file");
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
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      errors.push("无法安全读取 run-capacity.yaml，暂停普通 Run 派发");
    return result();
  }
  try {
    const doc = parseDocument(source, { uniqueKeys: true, strict: true });
    if (doc.errors.length || doc.warnings.length)
      throw new Error("Invalid YAML");
    const raw: unknown = doc.toJS({ maxAliasCount: 0 });
    const object = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value);
    if (
      !object(raw) ||
      Object.keys(raw).some((key) => key !== "machines") ||
      !object(raw.machines)
    )
      throw new Error("Invalid machines");
    for (const [machine, limit] of Object.entries(raw.machines)) {
      if (
        !machine.trim() ||
        typeof limit !== "number" ||
        !Number.isSafeInteger(limit) ||
        limit < 1
      )
        throw new Error("Invalid limit");
      limits.set(machine, limit);
    }
  } catch {
    // Never include YAML contents (which could contain credentials) in diagnostics.
    errors.push(
      "run-capacity.yaml 必须只包含 machines 映射，各机器上限为正整数；暂停普通 Run 派发",
    );
  }
  return result();
}
