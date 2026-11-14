import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { MIN_REDACTED_ENV_BYTES } from "./check-environment.js";
import { checkTimedOutOnly, TRUNCATED_OUTPUT } from "./merge-check-timeout.js";
import type { CheckoutResult } from "./temporary-checkout.js";

export const CHECK_OUTPUT_LIMIT = 2 * 1024 * 1024;
const MASK = "[REDACTED]",
  OMITTED = `\n${TRUNCATED_OUTPUT}\n`;
const escapeRegex = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
function redactor(env: Readonly<Record<string, string>>, redactPaths = false) {
  const values = [
    ...new Set(
      Object.values(env)
        .filter(
          (value) => Buffer.byteLength(value, "utf8") >= MIN_REDACTED_ENV_BYTES,
        )
        .flatMap((value) => {
          let uri = value;
          try {
            uri = encodeURIComponent(value);
          } catch {}
          return [
            value,
            uri,
            JSON.stringify(value).slice(1, -1),
            Buffer.from(value).toString("base64"),
          ];
        }),
    ),
  ].sort((a, b) => b.length - a.length);
  const pattern = values.length
    ? new RegExp(values.map(escapeRegex).join("|"), "gu")
    : undefined;
  return {
    // Padding lets a secret crossing either retained edge be redacted before clipping.
    padding: values.reduce(
      (size, value) => Math.max(size, Buffer.byteLength(value)),
      8192,
    ),
    redact(value: string) {
      let text = stripVTControlCharacters(value);
      if (pattern) text = text.replace(pattern, () => MASK);
      text = text
        .replace(
          /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu,
          MASK,
        )
        .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/giu, `$1${MASK}`)
        .replace(
          /\b((?:api[_-]?key|token|password|secret)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
          `$1${MASK}`,
        )
        .replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{12,}/gu, MASK);
      return redactPaths
        ? text.replace(
            /(?<![\w.-])(?:[A-Za-z]:[\\/]|\/)[^\s"'<>]+/gu,
            "[私有路径]",
          )
        : text;
    },
  };
}
function clip(text: string, limit: number, tail = false): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= limit) return text;
  let at = tail ? bytes.length - limit : limit;
  while (at > 0 && at < bytes.length && ((bytes[at] ?? 0) & 0xc0) === 0x80)
    at += tail ? 1 : -1;
  return (tail ? bytes.subarray(at) : bytes.subarray(0, at)).toString("utf8");
}
class BoundedOutput {
  private head = Buffer.alloc(0);
  private tail = Buffer.alloc(0);
  private bytes = 0;
  constructor(private readonly filter: ReturnType<typeof redactor>) {}
  append(text: string) {
    const chunk = Buffer.from(text),
      capacity = CHECK_OUTPUT_LIMIT / 2 + this.filter.padding;
    this.bytes += chunk.length;
    if (this.head.length < capacity)
      this.head = Buffer.concat([
        this.head,
        chunk.subarray(0, capacity - this.head.length),
      ]);
    this.tail = Buffer.from(
      Buffer.concat([this.tail, chunk]).subarray(-capacity),
    );
  }
  text(): string {
    if (this.bytes <= CHECK_OUTPUT_LIMIT) {
      const joined = Buffer.concat([
        this.head,
        this.tail.subarray(
          Math.max(0, this.head.length - (this.bytes - this.tail.length)),
        ),
      ]);
      const text = this.filter.redact(joined.toString("utf8"));
      if (Buffer.byteLength(text) <= CHECK_OUTPUT_LIMIT) return text;
      return this.edges(text, text);
    }
    return this.edges(
      this.filter.redact(this.head.toString("utf8")),
      this.filter.redact(this.tail.toString("utf8")),
    );
  }
  private edges(head: string, tail: string) {
    const size = Math.floor(
      (CHECK_OUTPUT_LIMIT - Buffer.byteLength(OMITTED)) / 2,
    );
    return clip(head, size) + OMITTED + clip(tail, size, true);
  }
}
async function privateDirectory(path: string, create: boolean) {
  if (create) {
    try {
      await mkdir(path, { mode: 0o700 });
      await chmod(path, 0o700);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const entry = await lstat(path);
  if (
    !entry.isDirectory() ||
    entry.uid !== process.getuid?.() ||
    (entry.mode & 0o777) !== 0o700 ||
    (await realpath(path)) !== path
  )
    throw new Error(
      "Merge check logs require a private host-owned directory without symlinks",
    );
}
/** One host queue owns the active writer; files are created exclusively and never contain raw output. */
export async function createMergeCheckLog(input: {
  readonly dataDir: string;
  readonly project: string;
  readonly attempt: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Precheck output is public card evidence; remove paths after credential filtering. */
  readonly redactPaths?: boolean;
}) {
  if (
    !/^[A-Za-z0-9_][A-Za-z0-9._-]*$/u.test(input.project) ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(input.attempt)
  )
    throw new Error("Invalid merge check log identity");
  const data = resolve(input.dataDir);
  for (let parent = dirname(data); ; parent = dirname(parent)) {
    const entry = await lstat(parent);
    if (
      !entry.isDirectory() ||
      ![0, process.getuid?.()].includes(entry.uid) ||
      (entry.mode & 0o022 && !(entry.mode & 0o1000))
    )
      throw new Error("Untrusted merge check log ancestor");
    if (parent === dirname(parent)) break;
  }
  await privateDirectory(data, false);
  const directory = join(data, "merge-gate", "logs", input.project);
  for (const path of [
    join(data, "merge-gate"),
    join(data, "merge-gate", "logs"),
    directory,
  ])
    await privateDirectory(path, true);
  const log_ref = `${input.attempt}.log`,
    path = join(directory, log_ref);
  const file = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  const filter = redactor(input.env ?? {}, input.redactPaths),
    output = new Map<string, BoundedOutput>();
  const header = filter.redact(
    `合并检查 ${input.project} / ${input.attempt}\n`,
  );
  try {
    await file.chmod(0o600);
    await file.writeFile(header);
  } finally {
    await file.close();
  }
  let finished = false;
  return {
    log_ref,
    append(name: string, text: string) {
      if (finished) throw new Error("Merge check log is already closed");
      let buffer = output.get(name);
      if (!buffer) {
        buffer = new BoundedOutput(filter);
        output.set(name, buffer);
      }
      buffer.append(text);
    },
    async finish(result: CheckoutResult) {
      if (finished) throw new Error("Merge check log is already closed");
      finished = true;
      const safe: CheckoutResult = {
        ...result,
        checks: result.checks.map((c) => ({
          ...c,
          name: filter.redact(c.name),
        })),
        cleanup_errors: result.cleanup_errors.map(filter.redact),
        ...(result.reason ? { reason: filter.redact(result.reason) } : {}),
      };
      const failed = result.checks.find(
        (c) => !["passed", "not_run", "skipped"].includes(c.status),
      );
      const failures = failed
        ? (output.get(failed.name)?.text() ?? "")
            .trimEnd()
            .split(/\r?\n/u)
            .slice(-40)
            .filter((line) => /^\s*(?:FAIL\b|Error\b|×)/u.test(line))
            .slice(-19)
        : [];
      const summary =
        result.status === "passed"
          ? result.checks.some((c) => c.status === "skipped")
            ? "本次范围内的检查已通过"
            : "检查全部通过"
          : clip(
              filter.redact(
                [
                  failed
                    ? `检查 ${failed.name} 未通过（${failed.status}，退出码 ${failed.exit_code ?? "无"}）`
                    : `${result.status === "interrupted" ? "合并检查已取消" : "合并检查未通过"}：${result.reason ?? result.status}`,
                  ...failures,
                ]
                  .join("\n")
                  .split(/\r?\n/u)
                  .slice(0, 20)
                  .join("\n"),
              ),
              12000,
            );
      // C-116: classified from the full retained output, before it is cleared.
      const timeout_only =
        !result.manual_attention &&
        checkTimedOutOnly(
          result.status,
          result.checks,
          (name) => output.get(name)?.text() ?? "",
        );
      const names = [
        ...new Set([...result.checks.map((c) => c.name), ...output.keys()]),
      ];
      const contents =
        header +
        names
          .map(
            (name) =>
              `\n=== ${filter.redact(name)} ===\n${output.get(name)?.text() ?? "未输出内容\n"}`,
          )
          .join("") +
        `\n${summary}\n` +
        (safe.cleanup_errors.length
          ? `\n清理提示：\n${safe.cleanup_errors.join("\n")}\n`
          : "");
      output.clear();
      const handle = await open(
        path,
        constants.O_WRONLY | constants.O_NOFOLLOW,
      );
      try {
        const entry = await handle.stat();
        if (
          !entry.isFile() ||
          entry.uid !== process.getuid?.() ||
          entry.nlink !== 1 ||
          (entry.mode & 0o777) !== 0o600
        )
          throw new Error("Unsafe merge check log file");
        await handle.truncate(0);
        await handle.writeFile(contents);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const logs = [];
      for (const name of await readdir(directory)) {
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.log$/u.test(name)) continue;
        const info = await lstat(join(directory, name));
        if (info.isFile() && info.uid === process.getuid?.())
          logs.push({ name, time: info.mtimeMs });
      }
      logs.sort((a, b) => b.time - a.time || b.name.localeCompare(a.name));
      for (const old of logs.slice(50)) await unlink(join(directory, old.name));
      return { ...safe, summary, log_ref, timeout_only };
    },
  };
}
