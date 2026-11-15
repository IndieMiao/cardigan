import { chmod, lstat, mkdir, realpath, unlink } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { acquireRepositoryFlock } from "@cardigan/host";
import {
  CheckHandoffController,
  type HandoffOptions,
  type HandoffRequest,
} from "./check-handoff.js";

export const checkControlPath = (dataDir: string): string =>
  join(dataDir, "check-control", "controller.sock");
async function privateDirectory(path: string, create: boolean) {
  if (create)
    await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    stat.mode & 0o077 ||
    (await realpath(path)) !== path
  )
    throw new Error("检查管理目录不安全");
}
function parseRequest(value: unknown): HandoffRequest {
  const request = value as HandoffRequest;
  if (
    !request ||
    typeof request !== "object" ||
    Array.isArray(request) ||
    Object.keys(request).some(
      (k) => !["action", "project", "generation", "width"].includes(k),
    ) ||
    !["begin", "status", "measure", "stop", "resume"].includes(
      request.action,
    ) ||
    typeof request.project !== "string" ||
    !/^[a-zA-Z0-9_][a-zA-Z0-9._-]*$/u.test(request.project) ||
    (request.width !== undefined &&
      (request.action !== "measure" ||
        !Number.isSafeInteger(request.width) ||
        request.width < 1)) ||
    (request.generation !== undefined &&
      (!Number.isSafeInteger(request.generation) || request.generation < 1))
  )
    throw new Error("无效管理请求");
  return request;
}

/** Filesystem access is the existing host/local-admin boundary. No HTTP, MCP or Agent credential. */
export async function startCheckControl(
  options: HandoffOptions,
): Promise<{ close(): Promise<void> }> {
  const { dataDir } = options.execution;
  await privateDirectory(dataDir, false);
  const directory = join(dataDir, "check-control");
  await privateDirectory(directory, true);
  // Controller identity lock only; never a replacement for a repository or executor slot lock.
  const unlock = await acquireRepositoryFlock(
    join(directory, "controller.lock"),
    1,
  );
  const path = checkControlPath(dataDir);
  const sockets = new Set<Socket>();
  const controller = new CheckHandoffController(options);
  const server = createServer((socket) => {
    sockets.add(socket);
    const abort = new AbortController();
    socket.once("close", () => {
      abort.abort();
      sockets.delete(socket);
    });
    socket.on("error", () => abort.abort());
    let input = "",
      consumed = false;
    socket.setEncoding("utf8");
    socket.on("data", (data: string) => {
      if (consumed) {
        socket.destroy();
        return;
      }
      input += data;
      if (Buffer.byteLength(input) > 4096) {
        socket.destroy();
        return;
      }
      if (!input.includes("\n")) return;
      consumed = true;
      void (async () => {
        try {
          if (input.indexOf("\n") !== input.length - 1)
            throw new Error("只允许一个请求");
          const result = await controller.request(
            parseRequest(JSON.parse(input)),
            abort.signal,
          );
          if (!socket.destroyed)
            socket.end(`${JSON.stringify({ ok: true, result })}\n`);
        } catch {
          // Never expose YAML, environment values, Git/SSH diagnostics or local paths.
          if (!socket.destroyed)
            socket.end(
              `${JSON.stringify({ ok: false, error: "移交操作被拒绝；检查当前代次、固定批准和原资源状态，围栏不会自动解除" })}\n`,
            );
        }
      })();
    });
  });
  try {
    const old = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (old) {
      if (!old.isSocket() || old.uid !== process.getuid?.())
        throw new Error("检查管理端点不安全");
      await unlink(path); // Only an old socket, after acquiring the controller identity lock.
    }
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, resolve);
    });
    await chmod(path, 0o600);
    controller.facts.recover();
  } catch (error) {
    server.close();
    await unlock();
    throw error;
  }
  return {
    close: async () => {
      // Disconnect only measurement clients. Abort and await only this controller's executions.
      for (const socket of sockets) socket.destroy();
      await controller.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      try {
        await unlink(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      } finally {
        await unlock();
      }
    },
  };
}

export async function requestCheckControl(
  dataDir: string,
  request: HandoffRequest,
  signal?: AbortSignal,
): Promise<unknown> {
  await privateDirectory(dataDir, false);
  await privateDirectory(join(dataDir, "check-control"), false);
  const path = checkControlPath(dataDir);
  const stat = await lstat(path);
  if (!stat.isSocket() || stat.uid !== process.getuid?.() || stat.mode & 0o077)
    throw new Error("检查管理端点不安全");
  parseRequest(request);
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const stop = () =>
      socket.destroy(new Error("操作员已断开；请核对停止状态并显式恢复"));
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    let output = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      output += chunk;
    });
    socket.once("error", reject);
    socket.once("close", () => {
      signal?.removeEventListener("abort", stop);
      try {
        const reply = JSON.parse(output);
        if (!reply.ok) throw new Error(reply.error);
        resolve(reply.result);
      } catch {
        reject(new Error("管理操作未确认；保持围栏，先核对当前状态"));
      }
    });
  });
}
