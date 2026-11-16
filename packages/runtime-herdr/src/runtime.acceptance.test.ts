/**
 * M2.T1 (M2.3 part): runtime acceptance tests.
 *
 * The same contract runs against two implementations of the domain `Runtime`
 * port (ADR 0001): a small in-memory fake written here, and the real
 * herdr-core adapter. The real side uses its own hc session, never `default`
 * or `cardigan`, and stops the core it started when the suite finishes.
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Assignment,
  Machine,
  Role,
  Runtime,
  RuntimeLaunch,
  RuntimeObservation,
  RuntimeRef,
  RuntimeResult,
} from "@cardigan/domain";
import { afterAll, describe, expect, test } from "vitest";
import { testHcBinary } from "../../../test-support/hc.js";
import { createTestRuntime } from "../../../test-support/paths.js";
import { corePid, stopCore } from "../test-support/hc-core.js";
import { HC_RELEASE } from "./hc-version.js";
import { HerdrRuntime } from "./index.js";

const SESSION = `m2t1-${process.pid}-${Math.floor(Date.now() / 1000) % 100000}`;
/** Keep actual cores under the supervisor runtime, separate from private data. */
const RUNTIME = createTestRuntime(join(tmpdir(), SESSION));
const SOCKET = join(RUNTIME, "hc.sock");

const assignment: Assignment = {
  id: "A-1" as never,
  scope: "work_item",
  work_item_id: "W-1" as never,
  role_id: "coder",
  role_version: 1,
  status: "active",
  runtime_state: "not_provisioned",
  machine_id: "local",
  runtime_ref: null,
  mcp_token_id: "fixture",
  created_at: "2026-01-01T00:00:00.000Z",
  worktree_path: "/srv/agent/worktrees/A-1",
  branch: "agent/C-1/W-1",
  base_sha: "a".repeat(40),
};
const role: Role = {
  role_id: "coder",
  version: 1,
  display_name: "Coder",
  kind: "work",
  core_prompt: "Fixture prompt",
  harness: "codex",
  launch_profile_ref: "fixture",
  allowed_tools: ["whoami"],
  capabilities: [],
  abilities: [],
  worktree: "write",
  required_machine_tags: [],
};
const machine: Machine = {
  id: "local",
  label: "Local",
  herdr_machine: "local",
  os: "linux",
  arch: "x64",
  tags: [],
  max_assignments: 10,
  status: "online",
  last_seen: "2026-01-01T00:00:00.000Z",
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(
  read: () => Promise<T | undefined>,
  timeoutMs = 15000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline)
      throw new Error("timed out waiting for the runtime");
    await sleep(100);
  }
}

const unwrap = <T>(result: RuntimeResult<T>): T => {
  if (!result.ok)
    throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};

/** A small in-memory Runtime; it models the port, not any harness. */
class MemoryRuntime implements Runtime {
  #terminals = new Map<
    string,
    { ref: RuntimeRef; alive: boolean; agent: RuntimeObservation["agent"] }
  >();
  #seq = 0;
  #next = 0;

  async provision(
    _assignment: Assignment,
    _role: Role,
    _machine: Machine,
    launch: RuntimeLaunch,
  ): Promise<RuntimeResult<RuntimeRef>> {
    this.#next += 1;
    const ref: RuntimeRef = {
      machine_id: "local",
      runtime_machine: "local",
      terminal_ref: `t${this.#next}` as never,
      agent_name: launch.agent_name,
      ...(launch.cwd ? { worktree_path: launch.cwd } : {}),
    };
    this.#terminals.set(ref.terminal_ref, { ref, alive: true, agent: "idle" });
    this.#seq += 1;
    return { ok: true, value: ref };
  }

  async wake(
    ref: RuntimeRef,
    _doorbell: string,
    options?: { readonly if_idle?: boolean },
  ): Promise<RuntimeResult<{ readonly sent: boolean }>> {
    const terminal = this.#terminals.get(ref.terminal_ref);
    if (terminal === undefined || !terminal.alive) {
      return {
        ok: false,
        error: { code: "runtime_not_found", message: "gone" },
      };
    }
    if (options?.if_idle === true && terminal.agent !== "idle") {
      return { ok: true, value: { sent: false } };
    }
    terminal.agent = "working";
    this.#seq += 1;
    void sleep(200).then(() => {
      if (terminal.alive) terminal.agent = "idle";
    });
    return { ok: true, value: { sent: true } };
  }

  async status(ref: RuntimeRef): Promise<RuntimeResult<RuntimeObservation>> {
    const terminal = this.#terminals.get(ref.terminal_ref);
    if (terminal === undefined) {
      return {
        ok: false,
        error: { code: "runtime_not_found", message: "gone" },
      };
    }
    this.#seq += 1;
    return {
      ok: true,
      value: {
        process: terminal.alive ? "alive" : "exited",
        agent: terminal.alive ? terminal.agent : "unknown",
        observed_seq: this.#seq,
      },
    };
  }

  async interrupt(ref: RuntimeRef): Promise<RuntimeResult<void>> {
    const terminal = this.#terminals.get(ref.terminal_ref);
    if (terminal === undefined) {
      return {
        ok: false,
        error: { code: "runtime_not_found", message: "gone" },
      };
    }
    terminal.agent = "idle";
    return { ok: true, value: undefined };
  }

  async resume_or_replace(
    ref: RuntimeRef,
    launch: RuntimeLaunch,
  ): Promise<RuntimeResult<RuntimeRef>> {
    await this.release(ref, { force: true });
    return this.provision(assignment, role, machine, launch);
  }

  async human_entry(ref: RuntimeRef): Promise<RuntimeResult<string>> {
    return { ok: true, value: `attach ${ref.terminal_ref}` };
  }

  async release(
    ref: RuntimeRef,
    options: { readonly force: boolean },
  ): Promise<RuntimeResult<void>> {
    const terminal = this.#terminals.get(ref.terminal_ref);
    if (terminal === undefined) {
      return {
        ok: false,
        error: { code: "runtime_not_found", message: "gone" },
      };
    }
    if (!options.force && terminal.agent === "working") {
      return {
        ok: false,
        error: { code: "runtime_conflict", message: "busy" },
      };
    }
    terminal.alive = false;
    return { ok: true, value: undefined };
  }
}

interface UnderTest {
  readonly runtime: Runtime;
  readonly kind: "memory" | "herdr";
}

/** A fake agent: idle until it is prompted, then working for a moment. */
function fakeAgent(directory: string): { command: string; args: string[] } {
  const script = join(directory, "agent.sh");
  writeFileSync(
    script,
    `#!/bin/sh
printf '\\033]7501;state=idle\\007'
while IFS= read -r line; do
  printf '\\033]7501;state=working\\007'
  sleep 0.2
  printf '\\033]7501;state=idle\\007'
done
`,
  );
  chmodSync(script, 0o755);
  return { command: "sh", args: [script] };
}

const realAvailable = Boolean(testHcBinary());

const launchFor = (
  agentName: string,
  cwd: string,
  command: string,
  args: string[],
): RuntimeLaunch => ({
  command,
  args,
  cwd,
  agent_name: agentName,
  labels: {
    cardigan: "1",
    project: "p-acceptance",
    run: "R-1",
    assignment: "A-1",
  },
});

describe("runtime contract", () => {
  describe("in-memory fake", () => {
    runContract("memory", async () => ({
      runtime: new MemoryRuntime(),
      kind: "memory",
    }));
  });

  describe.skipIf(!realAvailable)(
    `herdr-core >= ${HC_RELEASE.minimum_version}`,
    () => {
      runContract("herdr", async () => {
        const created = await HerdrRuntime.create({
          session: SESSION,
          socketPath: SOCKET,
          env: { ...process.env, XDG_RUNTIME_DIR: RUNTIME },
          timeoutMs: 20000,
        });
        if (!created.ok)
          throw new Error(`${created.error.code}: ${created.error.message}`);
        return { runtime: created.value, kind: "herdr" };
      });

      test("a version mismatch is refused", async () => {
        const created = await HerdrRuntime.create({
          session: SESSION,
          version: "0.1.17",
        });
        expect(created.ok).toBe(false);
        expect(created.ok === false && created.error.code).toBe(
          "version_mismatch",
        );
      });

      test("an absent socket is runtime_unavailable and starts no core", async () => {
        const socketPath = join(
          tmpdir(),
          `m2t1-absent-${process.pid}`,
          "none.sock",
        );
        const created = await HerdrRuntime.create({
          session: SESSION,
          socketPath,
        });
        if (!created.ok) throw new Error("adapter creation failed");
        const status = await created.value.status({
          machine_id: "local",
          runtime_machine: "local",
          terminal_ref: "t1" as never,
          agent_name: "coder-c1-w1-a1",
        });
        expect(status.ok).toBe(false);
        expect(status.ok === false && status.error.code).toBe(
          "runtime_unavailable",
        );
        // `hc ls` would start a core for this session, so it is the probe that
        // must stay absent: the socket path still does not exist.
        expect(existsSync(join(socketPath, ".."))).toBe(false);

        // Any core that a helper started for this session is stopped again.
        const pid = corePid({ session: SESSION, socket: socketPath });
        await stopCore({ session: SESSION, socket: socketPath, pid });
        rmSync(join(socketPath, ".."), { recursive: true, force: true });
      });
    },
  );

  if (!realAvailable) {
    test.skip(`compatible herdr-core >= ${HC_RELEASE.minimum_version} is unavailable`, () => {
      expect(realAvailable).toBe(true);
    });
  }

  afterAll(async () => {
    // Leave nothing behind: this suite only ever used its own session.
    expect(SESSION.startsWith("m2t1-")).toBe(true);
    // Record the core before any probe can remove its socket.
    const pid = corePid({ session: SESSION, socket: SOCKET });
    try {
      if (existsSync(SOCKET)) {
        const listed = execFileSync("hc", ["ls", "--all", "--json"], {
          encoding: "utf8",
          env: { ...process.env, HC_SESSION: SESSION, HC_SOCKET: SOCKET },
        });
        expect(JSON.parse(listed).terminals ?? []).toEqual([]);
      }
    } catch {
      // A core that never started has nothing to list; the stop below runs.
    } finally {
      await stopCore({ session: SESSION, socket: SOCKET, pid });
      rmSync(join(tmpdir(), SESSION), { recursive: true, force: true });
    }
  }, 120_000);
});

function runContract(name: string, create: () => Promise<UnderTest>): void {
  test(`${name}: provision returns a local ref and a live status`, async () => {
    const { runtime } = await create();
    const directory = mkdtempSync(
      join(tmpdir(), "cardigan-runtime-acceptance-"),
    );
    try {
      const agent = fakeAgent(directory);
      const ref = unwrap(
        await runtime.provision(
          assignment,
          role,
          machine,
          launchFor("coder-c1-w1-a1", directory, agent.command, agent.args),
        ),
      );
      expect(ref.machine_id).toBe("local");
      expect(ref.runtime_machine).toBe("local");
      expect(ref.terminal_ref).toMatch(/^t[a-z0-9]+$/u);
      expect(ref.agent_name).toBe("coder-c1-w1-a1");

      const status = unwrap(await runtime.status(ref));
      expect(status.process).toBe("alive");
      expect(typeof status.observed_seq).toBe("number");

      unwrap(await runtime.release(ref, { force: true }));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60000);

  test(`${name}: observed_seq never goes backwards`, async () => {
    const { runtime } = await create();
    const directory = mkdtempSync(
      join(tmpdir(), "cardigan-runtime-acceptance-"),
    );
    try {
      const agent = fakeAgent(directory);
      const ref = unwrap(
        await runtime.provision(
          assignment,
          role,
          machine,
          launchFor("coder-c1-w1-a2", directory, agent.command, agent.args),
        ),
      );
      const first = unwrap(await runtime.status(ref));
      await sleep(150);
      const second = unwrap(await runtime.status(ref));
      expect(second.observed_seq).toBeGreaterThanOrEqual(first.observed_seq);
      unwrap(await runtime.release(ref, { force: true }));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60000);

  test(`${name}: a doorbell reaches the agent and status follows it`, async () => {
    const { runtime } = await create();
    const directory = mkdtempSync(
      join(tmpdir(), "cardigan-runtime-acceptance-"),
    );
    try {
      const agent = fakeAgent(directory);
      const ref = unwrap(
        await runtime.provision(
          assignment,
          role,
          machine,
          launchFor("coder-c1-w1-a3", directory, agent.command, agent.args),
        ),
      );
      // The agent reports idle at start; wait until the runtime sees something.
      const idle = await until(async () => {
        const status = await runtime.status(ref);
        return status.ok ? status.value.agent : undefined;
      });
      expect(["idle", "working", "done", "unknown"]).toContain(idle);

      const sent = unwrap(
        await runtime.wake(ref, "[bell] card=C-1 wi=W-1", { if_idle: true }),
      );
      expect(sent.sent).toBe(true);

      const working = await until(async () => {
        const status = await runtime.status(ref);
        return status.ok && status.value.agent === "working"
          ? status.value
          : undefined;
      });
      expect(working.agent).toBe("working");

      const backToIdle = await until(async () => {
        const status = await runtime.status(ref);
        return status.ok && status.value.agent !== "working"
          ? status.value
          : undefined;
      });
      expect(backToIdle.agent).not.toBe("working");
      unwrap(await runtime.release(ref, { force: true }));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 90000);

  test(`${name}: human_entry is a paste-able command naming the terminal`, async () => {
    const { runtime } = await create();
    const directory = mkdtempSync(
      join(tmpdir(), "cardigan-runtime-acceptance-"),
    );
    try {
      const agent = fakeAgent(directory);
      const ref = unwrap(
        await runtime.provision(
          assignment,
          role,
          machine,
          launchFor("coder-c1-w1-a4", directory, agent.command, agent.args),
        ),
      );
      const entry = unwrap(await runtime.human_entry(ref));
      // The terminal must be an argument, not a substring of the session name
      // (which also contains "t1"-like digits).
      expect(entry).toMatch(
        new RegExp(`attach ['"]?${ref.terminal_ref}['"]?$`),
      );
      if (name === "herdr") {
        expect(entry).toContain("attach");
        expect(entry).toContain(SESSION);
      }
      unwrap(await runtime.release(ref, { force: true }));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60000);

  test(`${name}: release ends the terminal and is idempotent afterwards`, async () => {
    const { runtime } = await create();
    const directory = mkdtempSync(
      join(tmpdir(), "cardigan-runtime-acceptance-"),
    );
    try {
      const agent = fakeAgent(directory);
      const ref = unwrap(
        await runtime.provision(
          assignment,
          role,
          machine,
          launchFor("coder-c1-w1-a5", directory, agent.command, agent.args),
        ),
      );
      unwrap(await runtime.release(ref, { force: true }));

      const status = await runtime.status(ref);
      // Released terminals are either gone or reported as exited.
      if (status.ok) expect(status.value.process).toBe("exited");
      else expect(status.error.code).toBe("runtime_not_found");

      const again = await runtime.release(ref, { force: true });
      if (!again.ok) expect(again.error.code).toBe("runtime_not_found");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60000);
}
