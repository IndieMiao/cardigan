import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { HttpRejection } from "./http.js";

/** The route has already authenticated and resolved the current project. */
export async function serveMergeCheckLog(input: {
  readonly res: ServerResponse;
  readonly dataDir: string;
  readonly projectId: string;
  readonly attempt: string;
  readonly authorize: () => unknown;
}): Promise<void> {
  const { res, projectId, attempt } = input;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      attempt,
    )
  )
    throw new HttpRejection(400, "validation_failed", "检查编号必须为 UUID。");
  const missing = () =>
    new HttpRejection(404, "not_found", "检查日志不存在或已清理。");
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*$/u.test(projectId)) throw missing();
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
      if (!(await file.stat()).isFile()) throw missing();
      contents = await file.readFile();
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
