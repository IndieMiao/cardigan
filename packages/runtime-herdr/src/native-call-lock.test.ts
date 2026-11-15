import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { governHcClient } from "./call-queue.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "native-hc-lock-"));
  roots.push(root);
  const socket = join(root, "hc.sock"),
    session = "fixture";
  await mkdir(join(root, "locks"), { mode: 0o700 });
  const key = createHash("sha256")
    .update(JSON.stringify([socket, session]))
    .digest("hex");
  const path = join(root, "locks", `hc-${key}-0.lock`);
  const raw = {
    available: async () => true,
    async *lines() {},
    exec: vi.fn(async () => "done"),
  };
  return {
    root,
    path,
    raw,
    client: governHcClient(raw, {
      dataDir: root,
      socket,
      session,
      policy: { concurrency: 1, queueWaitMs: 80 },
    }),
  };
}

test.skipIf(process.platform !== "linux")(
  "native slots interoperate with the legacy system flock without reclaiming unknown occupancy",
  async () => {
    const f = await fixture();
    await writeFile(f.path, "", { mode: 0o600 });
    const child = spawn(
      "flock",
      ["--exclusive", f.path, "sh", "-c", "printf ready; read reply"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const closed = new Promise<void>((resolve) =>
      child.once("close", () => resolve()),
    );
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.once("data", () => resolve());
        child.once("error", reject);
        child.once("exit", () =>
          reject(Error("Legacy holder exited before ready")),
        );
      });
      await expect(f.client.exec(["get", "t1"])).rejects.toMatchObject({
        code: "runtime_queue_timeout",
      });
      expect(f.raw.exec).not.toHaveBeenCalled();
      // There is no PID/lease-based takeover: only the kernel's lock release
      // allows a new call. Killing the owner is tested separately in governance.
      child.stdin.end("release\n");
      await closed;
      await expect(f.client.exec(["get", "t1"])).resolves.toBe("done");
    } finally {
      child.stdin.end();
      child.kill("SIGKILL");
      await closed;
    }
  },
);

test
  .skipIf(process.platform !== "linux")
  .each(["symlink", "hardlink", "public", "directory"])(
  "%s lock files are refused before raw IO",
  async (kind) => {
    const f = await fixture(),
      other = join(f.root, "other");
    await writeFile(other, "private", { mode: 0o600 });
    if (kind === "symlink") await symlink(other, f.path);
    if (kind === "hardlink") await link(other, f.path);
    if (kind === "public") {
      await writeFile(f.path, "");
      await chmod(f.path, 0o644);
    }
    if (kind === "directory") await mkdir(f.path);
    await expect(f.client.exec(["get", "t1"])).rejects.toThrow();
    expect(f.raw.exec).not.toHaveBeenCalled();
  },
);
