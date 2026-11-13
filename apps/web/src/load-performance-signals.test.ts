// @vitest-environment node
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";

const script = fileURLToPath(
  new URL("../test-support/load-performance.mjs", import.meta.url),
);
const stub = new URL("../test-support/load-cdp-fixture.mjs", import.meta.url);
const password = "signal-fixture-password";
const cookie = "cardigan_session=signal-fixture-cookie";

test.each([
  ["SIGINT", 204, 130, "collect"],
  ["SIGTERM", 204, 143, "collect"],
  ["SIGINT", 503, 130, "collect"],
  ["SIGTERM", 503, 143, "collect"],
  ["SIGINT", "pending", 130, "collect"],
  ["SIGINT", 204, 130, "login"],
  ["SIGINT", 204, 130, "cleanup"],
  ["SIGINT", 503, 130, "cleanup"],
] as const)(
  "%s closes the browser and attempts logout once (%s; exit %i; during %s)",
  async (signal, status, code, phase) => {
    const root = await mkdtemp(join(tmpdir(), "load-signal-"));
    const ready = join(root, "ready");
    const closed = join(root, "closed");
    const executable = join(root, "browser");
    await writeFile(
      executable,
      `#!${process.execPath}\n${await readFile(stub, "utf8")}`,
      { mode: 0o700 },
    );
    let logins = 0;
    let logouts = 0;
    let browserClosedAtLogout = false;
    let logoutCookie: string | undefined;
    let releaseLogout: (() => void) | undefined;
    let releaseLogin: (() => void) | undefined;
    const server = createServer((req, res) => {
      req.resume();
      if (req.url === "/api/login") {
        logins++;
        releaseLogin = () => {
          if (res.writableEnded || res.destroyed) return;
          res.writeHead(200, { "set-cookie": `${cookie}; HttpOnly` });
          res.end("{}");
        };
        if (phase !== "login") releaseLogin();
      } else if (req.url === "/api/logout") {
        logouts++;
        browserClosedAtLogout = existsSync(closed);
        logoutCookie = req.headers.cookie;
        // Hold cleanup while sending a second signal to exercise idempotence.
        releaseLogout = () => {
          if (status === "pending" || res.writableEnded || res.destroyed)
            return;
          res.writeHead(status);
          res.end();
        };
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const child = spawn(
      process.execPath,
      [script, "--url", origin, "--project", "fixture", "--samples", "1"],
      {
        env: {
          ...process.env,
          TMPDIR: root,
          CHROMIUM_PATH: executable,
          WORKBENCH_PASSWORD: password,
          LOAD_TEST_READY: ready,
          LOAD_TEST_CLOSED: closed,
          LOAD_TEST_COMPLETE: phase === "cleanup" ? "1" : "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const exited = once(child, "exit");
    try {
      if (phase === "cleanup") {
        await vi.waitFor(() => expect(logouts).toBe(1), { timeout: 5000 });
      } else if (phase === "login") {
        await vi.waitFor(() => expect(logins).toBe(1), { timeout: 5000 });
      } else {
        await vi.waitFor(() => expect(existsSync(ready)).toBe(true), {
          timeout: 5000,
        });
      }
      child.kill(signal);
      if (phase === "login") {
        await vi.waitFor(() =>
          expect(output).toContain("Collection interrupted"),
        );
        releaseLogin?.();
      }
      await vi.waitFor(() => expect(logouts).toBe(1), { timeout: 5000 });
      child.kill(signal === "SIGINT" ? "SIGTERM" : "SIGINT");
      releaseLogout?.();
      const [exitCode, exitSignal] = await exited;
      expect(exitCode).toBe(code);
      expect(exitSignal).toBeNull();
      expect(logins).toBe(1);
      expect(logouts).toBe(1);
      expect(logoutCookie === cookie).toBe(true);
      expect(browserClosedAtLogout).toBe(true);
      expect(
        (await readdir(root)).some((name) =>
          name.startsWith("cardigan-layout-"),
        ),
      ).toBe(false);
      expect(output).toContain(
        `Collection interrupted (${signal}); cleaning up.`,
      );
      if (status === 503)
        expect(output).toContain("session cleanup failed (HTTP 503)");
      else if (status === "pending")
        expect(output).toContain(
          "cleanup timed out; the session may still be active",
        );
      else expect(output).not.toContain("cleanup failed");
      expect(output.includes(password) || output.includes(cookie)).toBe(false);
    } finally {
      releaseLogin?.();
      releaseLogout?.();
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await exited;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
  25000,
);
