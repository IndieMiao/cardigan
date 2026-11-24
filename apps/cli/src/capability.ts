import { open } from "node:fs/promises";
import { resolve } from "node:path";
import type { CapabilityGuideTarget } from "@cardigan/domain";
import {
  CapabilityGuideError,
  deleteCapabilityGuide,
  listCapabilityGuides,
  openStore,
  readCapabilityGuides,
  setCapabilityGuide,
} from "@cardigan/store";
import { CliError, EXIT } from "./errors.js";
import {
  announceDataDir,
  resolveActor,
  resolveGlobalActor,
  resolveProject,
} from "./host.js";
import type { CliIo } from "./io.js";

const USAGE = [
  "用法：",
  "  cardigan capability guide set <能力键> [--machine <机器>] (--note <说明> | --note-file <路径>) [--project <p>]",
  "  cardigan capability guide set --topic <主题> (--note <说明> | --note-file <路径>) [--project <p>]",
  "  cardigan capability guide get [<能力键>...] [--machine <机器>] [--project <p>]",
  "  cardigan capability guide list [--project <p>]",
  "  cardigan capability guide delete (<能力键> [--machine <机器>] | --topic <主题>) [--project <p>]",
  "    能力键主说明、--machine 为该机器的补充、--topic 为项目级说明；只写用法和受管文件路径，不写凭据值。",
  "    get 按 能力×机器×项目 合并：每个能力的主说明与该机器补充，加上全部项目级说明。仅限人类。",
].join("\n");

/** Large enough for any note the domain accepts; refuse before reading more. */
const MAX_NOTE_FILE_BYTES = 64 * 1024;

interface Parsed {
  readonly positionals: string[];
  readonly flags: Record<string, string>;
}

function usage(message?: string): never {
  throw new CliError(message ?? USAGE, EXIT.usage, message ? [USAGE] : []);
}

function parse(args: readonly string[], allowed: readonly string[]): Parsed {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = arg.slice(2, eq < 0 ? undefined : eq);
    const value = eq < 0 ? args[++i] : arg.slice(eq + 1);
    if (!allowed.includes(name)) usage(`不接受 --${name}`);
    if (value === undefined || (eq < 0 && value.startsWith("--")))
      usage(`--${name} 需要一个值`);
    if (flags[name] !== undefined) usage(`--${name} 只能指定一次`);
    flags[name] = value;
  }
  return { positionals, flags };
}

function target(p: Parsed): CapabilityGuideTarget | Record<string, unknown> {
  const topic = p.flags.topic;
  if (topic !== undefined) {
    if (p.positionals.length || p.flags.machine !== undefined)
      usage("--topic 不能与能力键或 --machine 同用");
    return { scope: "project", key: topic };
  }
  if (p.positionals.length !== 1) usage("需要一个能力键，或用 --topic <主题>");
  const key = p.positionals[0] as string;
  return p.flags.machine === undefined
    ? { scope: "capability", key }
    : { scope: "machine", key, machine_id: p.flags.machine };
}

async function readNote(path: string, io: CliIo): Promise<string> {
  try {
    const file = await open(resolve(io.cwd, path), "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile())
        throw new CliError(`不是普通文件：${path}`, EXIT.usage);
      if (stat.size > MAX_NOTE_FILE_BYTES)
        throw new CliError(`说明文件过大：${path}`, EXIT.usage);
      return (await file.readFile()).toString("utf8");
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      `无法读取文件：${path}，请检查文件是否存在及读取权限`,
      EXIT.usage,
    );
  }
}

/**
 * C-725: `cardigan capability guide …`, human-only. Token mode is refused
 * before any store access (also by `authorizeCliInvocation`); the store
 * checks the actor again on every write.
 */
export async function runCapabilityCommand(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  resolveGlobalActor(io);
  if (io.env.MCP_TOKEN !== undefined)
    throw new CliError("此命令仅限人类操作，Token 模式不可用。", EXIT.usage);
  if (args.includes("--help") || args.includes("-h")) {
    io.stdout(USAGE);
    return EXIT.ok;
  }
  const [group, action, ...rest] = args;
  if (group !== "guide") usage();
  const common = ["project", "data-dir"];
  const p =
    action === "set"
      ? parse(rest, [...common, "machine", "topic", "note", "note-file"])
      : action === "get"
        ? parse(rest, [...common, "machine"])
        : action === "delete"
          ? parse(rest, [...common, "machine", "topic"])
          : action === "list"
            ? parse(rest, common)
            : usage();
  if (action === "list" && p.positionals.length) usage();
  const entry = action === "set" || action === "delete" ? target(p) : null;
  let note: string | undefined;
  if (action === "set") {
    if ((p.flags.note === undefined) === (p.flags["note-file"] === undefined))
      usage("必须二选一：--note 或 --note-file");
    note = p.flags.note ?? (await readNote(p.flags["note-file"] as string, io));
  }
  const store = openStore({
    dataDir: announceDataDir(io, p.flags["data-dir"]),
  });
  try {
    const project = resolveProject(store, io, p.flags.project);
    const actor = resolveActor(io, project, store);
    if (actor.kind !== "human")
      throw new CliError("此命令仅限人类操作，Token 模式不可用。", EXIT.usage);
    if (action === "list") {
      io.stdout(JSON.stringify(listCapabilityGuides(store, project)));
    } else if (action === "get") {
      io.stdout(
        JSON.stringify(
          readCapabilityGuides(store, project, {
            machine_id: p.flags.machine ?? null,
            ...(p.positionals.length ? { capabilities: p.positionals } : {}),
          }),
        ),
      );
    } else if (action === "set") {
      io.stdout(
        JSON.stringify(
          setCapabilityGuide(
            store,
            actor,
            project,
            entry,
            note,
            new Date().toISOString(),
          ),
        ),
      );
    } else {
      if (!deleteCapabilityGuide(store, actor, project, entry))
        throw new CliError("没有这条使用说明", EXIT.failure);
      io.stdout(JSON.stringify({ deleted: true }));
    }
    return EXIT.ok;
  } catch (error) {
    if (error instanceof CapabilityGuideError)
      throw new CliError(
        error.message,
        error.code === "validation_failed" ? EXIT.usage : EXIT.failure,
      );
    throw error;
  } finally {
    store.close();
  }
}
