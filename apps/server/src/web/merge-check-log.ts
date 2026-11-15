import { constants } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { CheckLogReadLimitError } from "@cardigan/mcp-server";
import { HttpRejection } from "./http.js";

const MAX_LOG_BYTES = 8 * 1024 * 1024;
const isUtf8Continuation = (byte: number | undefined) =>
  byte !== undefined && (byte & 0xc0) === 0x80;

async function readRange(file: FileHandle, position: number, length: number) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await file.read(
      buffer,
      offset,
      length - offset,
      position + offset,
    );
    if (!bytesRead) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

async function readLog(file: FileHandle, size: number): Promise<Buffer> {
  // Read only the stat snapshot, even if a running check appends more output.
  if (size <= MAX_LOG_BYTES) return readRange(file, 0, size);
  const marker = Buffer.from(
    `\n\n[日志已截断：原大小 ${size} 字节，超过 8 MiB，已省略中间内容，以下为日志尾部]\n\n`,
  );
  const available = MAX_LOG_BYTES - marker.length;
  const head = Math.floor(available / 2);
  const tail = available - head;
  // One lookahead byte tells us whether the head ends inside a UTF-8 character.
  const headBytes = await readRange(file, 0, head + 1);
  let headEnd = Math.min(head, headBytes.length);
  while (headEnd > 0 && isUtf8Continuation(headBytes[headEnd])) headEnd--;
  const tailBytes = await readRange(file, size - tail, tail);
  let tailStart = 0;
  while (isUtf8Continuation(tailBytes[tailStart])) tailStart++;
  return Buffer.concat([
    headBytes.subarray(0, headEnd),
    marker,
    tailBytes.subarray(tailStart),
  ]);
}

/** Shared trusted-path boundary; callers own their separate authorization. */
async function withLogFile<T>(
  input: {
    dataDir: string;
    projectId: string;
    attempt: string;
  },
  read: (file: FileHandle, size: number) => Promise<T>,
): Promise<T> {
  const missing = () =>
    new HttpRejection(404, "not_found", "检查日志不存在或已清理。");
  if (
    !/^[A-Za-z0-9_][A-Za-z0-9._-]*$/u.test(input.projectId) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/u.test(input.attempt)
  )
    throw missing();
  let path = resolve(input.dataDir);
  try {
    for (const segment of ["", "merge-gate", "logs", input.projectId]) {
      path = join(path, segment);
      if (!(await lstat(path)).isDirectory()) throw missing();
    }
    const file = await open(
      join(path, `${input.attempt}.log`),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await file.stat();
      if (!info.isFile()) throw missing();
      return await read(file, info.size);
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof HttpRejection) throw error;
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      ["ENOENT", "ENOTDIR", "ELOOP"].includes(String(error.code))
    )
      throw missing();
    throw error;
  }
}

/** Byte offsets address the already-redacted private log, before Web clipping. */
export async function readMergeCheckLogRange(input: {
  dataDir: string;
  projectId: string;
  attempt: string;
  offset: number;
  limit: number;
}): Promise<{ text: string; next_offset: number; size: number }> {
  return withLogFile(input, async (file, size) => {
    const info = await file.stat();
    if (
      (info.mode & 0o777) !== 0o600 ||
      info.nlink !== 1 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new HttpRejection(404, "not_found", "检查日志不可安全读取。");
    const start = Math.min(input.offset, size);
    const bytes = await readRange(
      file,
      start,
      Math.min(input.limit + 4, size - start),
    );
    let from = 0;
    // A caller may supply a byte offset inside a character: skip its suffix.
    while (isUtf8Continuation(bytes[from])) from++;
    let end = Math.min(bytes.length, input.limit);
    while (end > from && isUtf8Continuation(bytes[end])) end--;
    end = Math.max(from, end);
    if (end === from && start + end < size) throw new CheckLogReadLimitError();
    return {
      text: bytes.subarray(from, end).toString("utf8"),
      next_offset: start + end,
      size,
    };
  });
}

/** The route has already authenticated and resolved the current project. */
export async function serveMergeCheckLog(input: {
  readonly res: ServerResponse;
  readonly dataDir: string;
  readonly projectId: string;
  readonly attempt: string;
  readonly hasAttempt: (attempt: string) => boolean;
  readonly authorize: () => unknown;
}): Promise<void> {
  input.authorize();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
      input.attempt,
    )
  )
    throw new HttpRejection(
      400,
      "validation_failed",
      "检查编号必须为小写 UUID。",
    );
  if (!input.hasAttempt(input.attempt))
    throw new HttpRejection(404, "not_found", "检查日志不存在或已清理。");
  const contents = await withLogFile(input, readLog);
  input.authorize();
  const { res } = input;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  res.writeHead(200);
  res.end(contents);
}
