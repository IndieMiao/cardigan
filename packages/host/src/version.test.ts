import type { RuntimeResult } from "@cardigan/domain";
import type { ExecutionConfig } from "@cardigan/runtime-herdr";
import { describe, expect, test, vi } from "vitest";
import { HostLaunchError } from "./errors.js";
import { agentCliVersion, harnessBinary } from "./version.js";

const local: ExecutionConfig = { mode: "local", dataDir: "/data" };
const agentSsh: ExecutionConfig = {
  mode: "agent-ssh",
  dataDir: "/data",
  agentRoot: "/agent",
  gid: 2000,
  machine: "cardigan-agent",
  identityFile: "/keys/id",
  knownHostsFile: "/keys/known_hosts",
};

describe("agentCliVersion (M2 plan §4 step 2)", () => {
  test("local mode asks the host binary", async () => {
    const captureLocal = vi.fn(async () => "codex 1.2.3");
    const captureAgent = vi.fn();
    const version = await agentCliVersion(
      { execution: local, captureAgent, captureLocal },
      harnessBinary("codex"),
    );
    expect(version).toBe("codex 1.2.3");
    expect(captureLocal).toHaveBeenCalledWith("codex");
    expect(captureAgent).not.toHaveBeenCalled();
  });

  test("agent-ssh mode asks the Agent account, never the host (§13.4)", async () => {
    const captureLocal = vi.fn(async () => "host-version");
    const captureAgent = vi.fn(
      async (): Promise<RuntimeResult<string>> => ({
        ok: true,
        value: "claude 9.9.9\nsecond line",
      }),
    );
    const version = await agentCliVersion(
      { execution: agentSsh, captureAgent, captureLocal },
      harnessBinary("claude-code"),
    );
    expect(version).toBe("claude 9.9.9");
    expect(captureAgent).toHaveBeenCalledWith("claude", ["--version"]);
    expect(captureLocal).not.toHaveBeenCalled();
  });

  test("agent-ssh mode without an Agent entry refuses instead of falling back", async () => {
    const captureLocal = vi.fn(async () => "host-version");
    await expect(
      agentCliVersion(
        { execution: agentSsh, captureLocal },
        harnessBinary("codex"),
      ),
    ).rejects.toBeInstanceOf(HostLaunchError);
    expect(captureLocal).not.toHaveBeenCalled();
  });

  test("a failed Agent probe keeps the runtime error code", async () => {
    const captureAgent = vi.fn(
      async (): Promise<RuntimeResult<string>> => ({
        ok: false,
        error: { code: "runtime_unavailable", message: "offline" },
      }),
    );
    await expect(
      agentCliVersion(
        { execution: agentSsh, captureAgent, captureLocal: async () => "x" },
        harnessBinary("pi"),
      ),
    ).rejects.toThrow(/runtime_unavailable/);
  });
});
