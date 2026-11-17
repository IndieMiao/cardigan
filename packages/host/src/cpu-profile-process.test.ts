import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { cpuProfileCommand } from "./cpu-profile-control.js";

test("SIGKILL preserves no false artifact; new generation rejects old request and SIGTERM flushes a new capture", async () => {
  const root = mkdtempSync(join(tmpdir(), "cpu-process-"));
  const children: ChildProcess[] = [];
  const directory = join(root, "cpu-profiles", "background");
  async function child() {
    const p = spawn(
      process.execPath,
      [
        new URL("../test-support/cpu-profile-child.mjs", import.meta.url)
          .pathname,
        root,
      ],
      {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: { PATH: process.env.PATH },
      },
    );
    children.push(p);
    const messages: unknown[] = [];
    p.on("message", (m) => messages.push(m));
    const exited = new Promise((resolve) =>
      p.once("exit", (code, signal) => resolve({ code, signal })),
    );
    await vi.waitFor(() => expect(messages).toContain("ready"));
    return { p, messages, exited };
  }
  try {
    const first = await child();
    cpuProfileCommand({
      dataDir: root,
      action: "start",
      target: "background",
      seconds: 60,
    });
    first.p.send("sync");
    await vi.waitFor(() => expect(first.messages).toContain("synced"));
    await new Promise((r) => setTimeout(r, 20));
    first.p.kill("SIGKILL");
    await first.exited;
    expect(
      readdirSync(directory).filter((n) => n.endsWith(".cpuprofile")),
    ).toEqual([]);
    const next = await child();
    next.p.send("sync");
    await vi.waitFor(() => expect(next.messages).toContain("synced"));
    expect(
      JSON.parse(readFileSync(join(directory, "state.json"), "utf8")).phase,
    ).toBe("idle");
    cpuProfileCommand({
      dataDir: root,
      action: "start",
      target: "background",
      seconds: 60,
    });
    next.messages.length = 0;
    next.p.send("sync");
    await vi.waitFor(() => expect(next.messages).toContain("synced"));
    await new Promise((r) => setTimeout(r, 20));
    next.p.kill("SIGTERM");
    expect(await next.exited).toEqual({ code: 0, signal: null });
    const profiles = readdirSync(directory).filter((n) =>
      n.endsWith(".cpuprofile"),
    );
    expect(profiles).toHaveLength(1);
    expect(
      JSON.parse(readFileSync(join(directory, profiles[0] as string), "utf8"))
        .nodes.length,
    ).toBeGreaterThan(0);
    expect(readdirSync(directory).some((n) => n.startsWith("partial-"))).toBe(
      false,
    );
  } finally {
    for (const p of children)
      if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
    await Promise.all(
      children.map((p) =>
        p.exitCode !== null || p.signalCode !== null
          ? Promise.resolve()
          : new Promise((resolve) => p.once("exit", resolve)),
      ),
    );
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);
