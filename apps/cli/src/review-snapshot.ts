import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  chownSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import {
  collectSensitiveValues,
  DEFAULT_DB_FILE,
  REVIEW_SNAPSHOT_RULES_VERSION,
  rowCounts,
  type ScanHit,
  scanReviewSnapshot,
  scrubReviewSnapshot,
} from "@cardigan/store";
import { CliError, EXIT } from "./errors.js";
import { announceDataDir, hasToken } from "./host.js";
import type { CliIo } from "./io.js";

/**
 * `cardigan review-snapshot create` (C-267, §14).
 *
 * A human-only command that publishes a de-identified copy of one project's
 * database for Agent-side UI review. The production database is opened
 * read-only and copied with SQLite's online backup into a private (0700)
 * temporary directory; the copy is scrubbed, rewritten with VACUUM INTO so no
 * freed page keeps a removed value, and scanned. Only a clean scan is
 * published: into a new versioned directory, then the `current` link is
 * swapped atomically and the old target becomes `previous`.
 */

export const DEFAULT_SNAPSHOT_GROUP = "cardigan-share";
export const SNAPSHOT_DB_FILE = "cardigan.db";
export const SNAPSHOT_MANIFEST_FILE = "manifest.json";
const FILE_MODE = 0o640;
const DIR_MODE = 0o750;

const USAGE = [
  "用法：cardigan review-snapshot create --project <项目> --out <发布目录> [--group <组>] [--data-dir <目录>]",
  "",
  "  create   从生产库生成一份去敏快照，扫描通过后发布为 <发布目录>/current",
  "",
  "  --project   要导出的项目（也可用 CARDIGAN_PROJECT）",
  "  --out       发布目录（也可用 CARDIGAN_REVIEW_SNAPSHOT_DIR），例如 Agent 共享目录下的 review-snapshots",
  `  --group     发布文件的属组，默认 ${DEFAULT_SNAPSHOT_GROUP}`,
  "",
  "仅限人类在本机运行，Token 模式不可用。生产库只读打开；扫描有任何命中就不发布，退出码非 0。",
  "发布后：current/cardigan.db 与 current/manifest.json，权限 0640；上一份保留为 previous。",
].join("\n");

export interface ReviewSnapshotDeps {
  readonly now?: () => Date;
  readonly hostname?: () => string;
  /** Resolve a group name to a gid; defaults to reading /etc/group. */
  readonly groupId?: (name: string) => number;
  /** Where the private working copy lives; defaults to the OS temp dir. */
  readonly tmpRoot?: string;
  /** Test seam: replace the scrubber to prove a dirty copy is never published. */
  readonly scrub?: typeof scrubReviewSnapshot;
}

export async function runReviewSnapshotCommand(
  argv: readonly string[],
  io: CliIo,
  deps: ReviewSnapshotDeps = {},
): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (subcommand === "--help" || subcommand === "-h") {
    io.stdout(USAGE);
    return EXIT.ok;
  }
  // authorizeCliInvocation already refuses Token mode; refuse again here so
  // a future dispatcher change cannot expose the production database.
  if (hasToken(io))
    throw new CliError("此命令仅限人类操作，Token 模式不可用。", EXIT.usage);
  if (subcommand !== "create") {
    io.stderr(USAGE);
    return EXIT.usage;
  }
  return createSnapshot(rest, io, deps);
}

interface Flags {
  readonly project: string;
  readonly out: string;
  readonly group: string;
  readonly dataDir: string | undefined;
}

function parseFlags(argv: readonly string[], io: CliIo): Flags {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const match = /^--(project|out|group|data-dir)(?:=(.*))?$/.exec(arg);
    if (match === null)
      throw new CliError(`不认识的参数：${arg}\n\n${USAGE}`, EXIT.usage);
    const value = match[2] ?? argv[++i];
    if (value === undefined || value.length === 0 || value.startsWith("--"))
      throw new CliError(`--${match[1]} 需要一个值`, EXIT.usage);
    values[match[1] as string] = value;
  }
  const project = values.project ?? io.env.CARDIGAN_PROJECT;
  const out = values.out ?? io.env.CARDIGAN_REVIEW_SNAPSHOT_DIR;
  if (!project) throw new CliError(`需要 --project\n\n${USAGE}`, EXIT.usage);
  if (!out) throw new CliError(`需要 --out\n\n${USAGE}`, EXIT.usage);
  return {
    project,
    out,
    group: values.group ?? DEFAULT_SNAPSHOT_GROUP,
    dataDir: values["data-dir"],
  };
}

async function createSnapshot(
  argv: readonly string[],
  io: CliIo,
  deps: ReviewSnapshotDeps,
): Promise<number> {
  const flags = parseFlags(argv, io);
  const dataDir = announceDataDir(io, flags.dataDir);
  const source = join(dataDir, DEFAULT_DB_FILE);
  if (!existsSync(source))
    throw new CliError(`找不到生产库：${source}`, EXIT.usage);
  const gid = (deps.groupId ?? groupIdFromEtc)(flags.group);
  const now = (deps.now ?? (() => new Date()))();

  // Private working directory: mkdtemp creates it 0700; removed in all cases.
  const work = mkdtempSync(
    join(deps.tmpRoot ?? tmpdir(), "cardigan-review-snapshot-"),
  );
  try {
    const copy = join(work, "backup.db");
    const candidate = join(work, SNAPSHOT_DB_FILE);
    const src = new DatabaseSync(source, { readOnly: true });
    try {
      await backup(src, copy);
    } finally {
      src.close();
    }

    const db = new DatabaseSync(copy);
    let sourceSchemaVersion: number;
    let values: ReturnType<typeof collectSensitiveValues>;
    let sensitiveRows: number;
    try {
      sourceSchemaVersion = Number(
        db.prepare("SELECT max(version) AS v FROM schema_version").get()?.v ??
          0,
      );
      if (
        db.prepare("SELECT 1 FROM projects WHERE id = ?").get(flags.project) ===
        undefined
      )
        throw new CliError(`项目 ${flags.project} 不存在`, EXIT.usage);
      values = collectSensitiveValues(db, flags.project, {
        hostnames: [(deps.hostname ?? hostname)()],
      });
      sensitiveRows = (deps.scrub ?? scrubReviewSnapshot)(
        db,
        values,
      ).sensitive_rows;
      db.exec(`VACUUM INTO '${candidate.replaceAll("'", "''")}'`);
    } finally {
      db.close();
    }
    rmSync(copy, { force: true });
    for (const suffix of ["-wal", "-shm", "-journal"])
      rmSync(`${copy}${suffix}`, { force: true });

    const out = new DatabaseSync(candidate);
    let scan: ReturnType<typeof scanReviewSnapshot>;
    let counts: Record<string, number>;
    try {
      out.exec("PRAGMA journal_mode = DELETE");
      const integrity = out.prepare("PRAGMA integrity_check").get();
      if (integrity?.integrity_check !== "ok")
        throw new CliError("去敏副本完整性检查失败，未发布。", EXIT.failure);
      counts = rowCounts(out);
      scan = scanReviewSnapshot(out, values, readFileSync(candidate));
    } finally {
      out.close();
    }

    if (!scan.passed) {
      io.stderr(
        [
          `扫描命中 ${scan.hit_count} 处，未发布（发布目录保持不变）：`,
          ...scan.hits.map(formatHit),
          ...(scan.hit_count > scan.hits.length
            ? [`……另有 ${scan.hit_count - scan.hits.length} 处未列出`]
            : []),
        ].join("\n"),
      );
      return EXIT.failure;
    }

    const bytes = readFileSync(candidate);
    const manifest = {
      format: "cardigan-review-snapshot",
      generated_at: now.toISOString(),
      project: flags.project,
      source_schema_version: sourceSchemaVersion,
      rules_version: REVIEW_SNAPSHOT_RULES_VERSION,
      database: {
        file: SNAPSHOT_DB_FILE,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
      },
      row_counts: counts,
      sensitive_rows: sensitiveRows,
      scan: {
        passed: true,
        hit_count: 0,
        rules: scan.rules,
      },
    };
    const published = publish(flags.out, gid, now, candidate, manifest);
    io.stdout(
      [
        `已发布去敏快照：${published.current}`,
        `项目 ${flags.project}，源 schema_version ${sourceSchemaVersion}，去敏规则版本 ${REVIEW_SNAPSHOT_RULES_VERSION}，扫描通过。`,
        published.previous === undefined
          ? "这是第一份快照。"
          : `上一份保留为 previous（${published.previous}）。`,
        "使用方式：复制 current/cardigan.db 到自己的临时目录再打开，迁移在打开副本时自动执行。",
      ].join("\n"),
    );
    return EXIT.ok;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function formatHit(hit: ScanHit): string {
  const where =
    hit.where === "file"
      ? "数据库文件字节"
      : [
          hit.table,
          hit.rowid === undefined ? undefined : `rowid ${hit.rowid}`,
          hit.column,
        ]
          .filter((part) => part !== undefined)
          .join(" ");
  return `  - [${hit.category}] ${hit.rule}：${where}`;
}

/**
 * Lay out `<out>/snapshots/<stamp>/` and point `current` at it with an atomic
 * rename of a fresh symlink; the old target becomes `previous`. Anything older
 * is removed. A failure before the swap leaves `current` untouched and
 * removes the half-written directory.
 */
function publish(
  root: string,
  gid: number,
  now: Date,
  candidate: string,
  manifest: unknown,
): { current: string; previous: string | undefined } {
  ensureDir(root, gid);
  const snapshots = join(root, "snapshots");
  ensureDir(snapshots, gid);
  const currentLink = join(root, "current");
  const previousLink = join(root, "previous");
  const old = linkTarget(currentLink);

  const stamp = `${now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z")}-${randomBytes(3).toString("hex")}`;
  const relative = join("snapshots", stamp);
  const finalDir = join(snapshots, stamp);
  const staging = mkdtempSync(join(snapshots, ".staging-"));
  let swapped = false;
  try {
    const dbFile = join(staging, SNAPSHOT_DB_FILE);
    copyFileSync(candidate, dbFile);
    writeFileSync(
      join(staging, SNAPSHOT_MANIFEST_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: FILE_MODE },
    );
    for (const name of [SNAPSHOT_DB_FILE, SNAPSHOT_MANIFEST_FILE]) {
      const path = join(staging, name);
      chmodSync(path, FILE_MODE);
      chownSync(path, -1, gid);
      syncPath(path);
    }
    chownSync(staging, -1, gid);
    renameSync(staging, finalDir);
    chmodSync(finalDir, DIR_MODE);
    syncPath(snapshots);

    replaceLink(currentLink, relative);
    swapped = true;
    if (old !== undefined && old !== relative) replaceLink(previousLink, old);
    syncPath(root);
  } catch (error) {
    if (!swapped) {
      rmSync(staging, { recursive: true, force: true });
      rmSync(finalDir, { recursive: true, force: true });
    }
    throw error;
  }

  const keep = new Set([stamp, old?.split("/").pop()]);
  for (const entry of readdirSync(snapshots))
    if (!keep.has(entry) && !entry.startsWith(".staging-"))
      rmSync(join(snapshots, entry), { recursive: true, force: true });
  return { current: join(root, "current"), previous: old };
}

function ensureDir(path: string, gid: number): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: DIR_MODE });
  const stat = lstatSync(path);
  if (!stat.isDirectory())
    throw new CliError(`发布目录不是目录：${path}`, EXIT.usage);
  // A directory someone else created (e.g. an Agent account with write access
  // to the parent) is never reused: they could swap its contents.
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid)
    throw new CliError(
      `发布目录不属于当前用户，未发布：${path}；请人工确认后移走它。`,
      EXIT.usage,
    );
  chownSync(path, -1, gid);
  chmodSync(path, DIR_MODE);
}

function linkTarget(path: string): string | undefined {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    return undefined;
  }
  if (!stat.isSymbolicLink())
    throw new CliError(
      `${path} 已存在且不是符号链接，未发布；请人工确认后移走它。`,
      EXIT.usage,
    );
  return readlinkSync(path);
}

/** rename(2) over an existing symlink is atomic: readers see old or new. */
function replaceLink(path: string, target: string): void {
  const tmp = `${path}.tmp-${randomBytes(4).toString("hex")}`;
  symlinkSync(target, tmp);
  try {
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

function syncPath(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Look a group up in /etc/group; Node has no getgrnam. */
export function groupIdFromEtc(name: string, file = "/etc/group"): number {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new CliError(`无法读取 ${file}，不能确定属组 ${name}`, EXIT.usage);
  }
  for (const line of text.split("\n")) {
    const [group, , gid] = line.split(":");
    if (group === name && gid !== undefined && /^\d+$/.test(gid))
      return Number(gid);
  }
  throw new CliError(
    `找不到用户组 ${name}；请先按 deploy/README.md 安装 Agent 账号，或用 --group 指定。`,
    EXIT.usage,
  );
}
