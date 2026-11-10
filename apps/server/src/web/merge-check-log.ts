import { constants } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { HttpRejection } from "./http.js";

const MAX_LOG_BYTES = 8 * 1024 * 1024;
const TRUNCATION_MARKER = Buffer.from(
  "\n\n[日志已截断：超过 8 MiB，仅保留首尾内容]\n\n",
);

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
  const available = MAX_LOG_BYTES - TRUNCATION_MARKER.length;
  const head = Math.floor(available / 2);
  const tail = available - head;
  return Buffer.concat([
    await readRange(file, 0, head),
    TRUNCATION_MARKER,
    await readRange(file, size - tail, tail),
  ]);
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
  const { res, projectId, attempt } = input;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
      attempt,
    )
  )
    throw new HttpRejection(
      400,
      "validation_failed",
      "检查编号必须为小写 UUID。",
    );
  const missing = () =>
    new HttpRejection(404, "not_found", "检查日志不存在或已清理。");
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*$/u.test(projectId)) throw missing();
  if (!input.hasAttempt(attempt)) throw missing();
  let path = resolve(input.dataDir);
  let contents: Buffer;
  try {
    // Reject links at every level below the trusted data root, including the file.
    for (const segment of ["", "merge-gate", "logs", projectId]) {
      path = join(path, segment);
      if (!(await lstat(path)).isDirectory()) throw missing();
    }
    const file = await open(
      join(path, `${attempt}.log`),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await file.stat();
      if (!info.isFile()) throw missing();
      contents = await readLog(file, info.size);
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
  input.authorize();
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  res.writeHead(200);
  res.end(contents);
}
