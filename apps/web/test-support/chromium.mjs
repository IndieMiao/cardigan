import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Minimal CDP pipe transport; requires a local Chromium, no browser dependency. */
export async function chromium() {
  const profile = await mkdtemp(join(tmpdir(), "cardigan-layout-"));
  const process = spawn(
    globalThis.process.env.CHROMIUM_PATH ?? "chromium",
    [
      "--headless",
      "--hide-scrollbars",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--remote-debugging-pipe",
      `--user-data-dir=${profile}`,
    ],
    { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
  );
  const pending = new Map();
  let sequence = 0,
    buffer = "",
    sessionId;
  const errors = [];
  process.on("error", (error) => {
    for (const request of pending.values()) request.reject(error);
  });
  process.stdio[4].setEncoding("utf8");
  process.stdio[4].on("data", (data) => {
    buffer += data;
    while (buffer.includes("\0")) {
      const end = buffer.indexOf("\0");
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (message.method === "Runtime.exceptionThrown")
        errors.push(message.params);
      const request = pending.get(message.id);
      if (!request) continue;
      pending.delete(message.id);
      if (message.error)
        request.reject(new Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    }
  });
  async function send(method, params = {}) {
    const id = ++sequence;
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        timer = setTimeout(
          () => reject(new Error(`CDP timeout: ${method}`)),
          30000,
        );
        process.stdio[3].write(
          `${JSON.stringify({ id, method, params, sessionId })}\0`,
        );
      });
    } finally {
      clearTimeout(timer);
      pending.delete(id);
    }
  }
  async function close() {
    if (
      process.pid &&
      process.exitCode === null &&
      process.signalCode === null
    ) {
      const exited = new Promise((resolve) => process.once("exit", resolve));
      process.kill("SIGTERM");
      const timer = setTimeout(() => process.kill("SIGKILL"), 2000);
      await exited;
      clearTimeout(timer);
    }
    await rm(profile, { recursive: true, force: true });
  }
  try {
    const { targetId } = await send("Target.createTarget", {
      url: "about:blank",
    });
    ({ sessionId } = await send("Target.attachToTarget", {
      targetId,
      flatten: true,
    }));
    await send("Runtime.enable");
    await send("Page.enable");
  } catch (error) {
    await close();
    throw error;
  }
  return {
    send,
    close,
    errors,
    async evaluate(expression) {
      const value = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (value.exceptionDetails)
        throw new Error(JSON.stringify(value.exceptionDetails));
      return value.result.value;
    },
  };
}
