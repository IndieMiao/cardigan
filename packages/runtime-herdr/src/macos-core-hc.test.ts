import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { testHcBinary } from "../../../test-support/hc.js";
import { createTestRuntime } from "../../../test-support/paths.js";
import { corePid, stopCore } from "../test-support/hc-core.js";
import { agentCoreCommand } from "./agent-ssh.js";
import { shellQuote } from "./execution.js";

const binary = testHcBinary();

// Required remote checks run the real hc parser/RPC validation. Employee local
// tests keep the existing hc skip; the synthetic SSH never contacts a worker.
test.skipIf(!binary || process.platform !== "linux")(
  "real hc accepts the macOS via target and rejects control characters before SSH",
  async () => {
    if (!binary) throw new Error("hc unavailable");
    const root = mkdtempSync(join(tmpdir(), "cg-via-hc-"));
    const runtimeDir = createTestRuntime(join(root, "runtime"));
    const socket = join(runtimeDir, "hc.sock");
    const session = `via-${randomUUID().slice(0, 8)}`;
    const marker = join(root, "ssh-arguments");
    const env = {
      PATH: `${root}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      HOME: root,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state"),
      XDG_RUNTIME_DIR: runtimeDir,
      HC_SESSION: session,
      HC_SOCKET: socket,
      HC_RUNTIME: "1",
    };
    writeFileSync(
      join(root, "ssh"),
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${shellQuote(marker)}\nexit 73\n`,
      { mode: 0o700 },
    );
    const target = agentCoreCommand(
      {
        mode: "agent-ssh",
        dataDir: join(root, "data"),
        agentRoot: "/workers/example",
        gid: 2201,
        machine: "example-a",
        host: "worker.invalid",
        user: "worker_fixture",
        identityFile: join(root, "key"),
        knownHostsFile: join(root, "hosts"),
        macosCore: {
          python: "/opt/homebrew/bin/python3",
          retiredLaunchdLabel: "dev.cardigan.example",
        },
      },
      "cg",
    );
    const register = (via: string) =>
      spawnSync(
        binary,
        [
          "machine",
          "add",
          "--name",
          "fixture-mac",
          "--session",
          "cg",
          "--via",
          via,
          "--json",
        ],
        { encoding: "utf8", env, timeout: 10000 },
      );
    try {
      const invalid = register(`${target}\n`);
      expect(invalid.status).not.toBe(0);
      expect(invalid.stdout + invalid.stderr).toContain(
        "one line, no control characters",
      );
      expect(existsSync(marker)).toBe(false);
      const valid = register(target);
      expect(valid.error).toBeUndefined();
      // Transport fails intentionally, but the real registration validator
      // must accept the target and execute the selected SSH entry first.
      expect(valid.status).not.toBe(0);
      expect(valid.stdout + valid.stderr).not.toContain(
        "one line, no control characters",
      );
      expect(readFileSync(marker, "utf8")).toContain(
        "worker_fixture@worker.invalid",
      );
      expect(readFileSync(marker, "utf8")).toContain("base64.b64decode(");
    } finally {
      await stopCore({
        session,
        socket,
        env,
        pid: corePid({ session, socket, env }),
      });
      rmSync(root, { recursive: true, force: true });
    }
  },
  30000,
);
