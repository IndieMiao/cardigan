import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RuntimeRef } from "@cardigan/domain";
import { afterEach, expect, test, vi } from "vitest";
import { exitDarwinHarness, stopDarwinOwner } from "./darwin-idle-owner.js";
import type { ExecutionConfig } from "./execution.js";

const generation = "c".repeat(32),
  fingerprint = "d".repeat(64),
  fixture = resolve(
    "packages/runtime-herdr/test-support/darwin-exit-fixture.py",
  );
afterEach(() => vi.unstubAllEnvs());

/** A pre-enrollment session: no owner socket, so only the exit fallback applies. */
async function legacySession() {
  // Short root: the core socket path must fit Darwin's sun_path.
  const root = mkdtempSync(join(realpathSync(tmpdir()), "dx-")),
    tree = join(root, "worktrees/fixture/A-1"),
    repo = join(root, "repos/fixture"),
    data = join(root, "data");
  mkdirSync(data, { mode: 0o700 });
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args]);
  mkdirSync(repo, { recursive: true });
  git("init", "--template=", "-q");
  git("config", "--local", "remote.origin.url", "cardigan-central:fixture");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-qm",
    "initial",
  );
  git("worktree", "add", "-q", "-b", "agent/fixture", "--", tree, "HEAD");
  // The relay's chdir target exists, but no owner ever listened there.
  mkdirSync(join(root, "runs/fixture/A-1/generations", generation), {
    recursive: true,
  });
  writeFileSync(join(root, "state"), "idle");
  const e: Extract<ExecutionConfig, { mode: "agent-ssh" }> = {
    mode: "agent-ssh",
    machine: "fixture",
    agentRoot: root,
    gid: 1234,
    user: "worker",
    identityFile: "/private/id",
    knownHostsFile: "/private/hosts",
    dataDir: data,
    target: {
      machine_id: "remote",
      project_id: "fixture",
      generation: "binding",
      session: "s",
      fingerprint,
    },
    publication: {
      header_max_bytes: 4096,
      file_max_bytes: 4096,
      batch_max_bytes: 8192,
      timeout_ms: 5000,
    },
    macosCore: { python: "/usr/bin/python3", retiredLaunchdLabel: "fixture" },
    fileHelper: {
      python: "/usr/bin/python3",
      path: "/installed/worker-files.py",
    },
  };
  const ref: RuntimeRef = {
    machine_id: "remote",
    runtime_machine: "fixture",
    terminal_ref: "fixture/t1",
    agent_name: "coder",
    target: e.target!,
    launch_generation: { run_id: "R-1" as never, generation },
    worktree_path: tree,
  };
  const core = spawn(
    "python3",
    [
      "-IB",
      fixture,
      "core",
      root,
      "s",
      "coder",
      "R-1",
      generation,
      "fixture",
      "A-1",
      fingerprint,
    ],
    { stdio: ["pipe", "ignore", "ignore"] },
  );
  const closed = once(core, "close");
  const cleanup = async () => {
    if (core.exitCode === null) {
      core.kill();
      await closed;
    }
    rmSync(root, { recursive: true, force: true });
  };
  try {
    await expect.poll(() => existsSync(join(root, "child"))).toBe(true);
  } catch (err) {
    await cleanup();
    throw err;
  }
  const enrolled = JSON.parse(readFileSync(join(root, "child"), "utf8"));
  const options = {
    project_id: "fixture",
    assignment_id: "A-1",
    hangup_ms: 100,
    terminate_ms: 500,
    harness: "claude-code" as const,
    before_signal: () => true,
    enrolled_process: enrolled,
  };
  // The owner relay runs as shipped; the exit script runs under the
  // synthetic account. Neither SSH nor production credentials are used.
  const transport = async (_: unknown, argv: readonly string[]) =>
    argv.length === 7
      ? {
          file: "python3",
          args: ["-IB", fixture, "worker", root, ...argv.slice(3)],
        }
      : { file: argv[0]!, args: argv.slice(1) };
  const sends = () =>
    existsSync(join(root, "sends"))
      ? readFileSync(join(root, "sends"), "utf8")
      : "";
  return {
    root,
    tree,
    e,
    ref,
    options,
    sends,
    stop: (patch: Partial<Parameters<typeof stopDarwinOwner>[2]> = {}) =>
      stopDarwinOwner(e, ref, { ...options, ...patch }, transport),
    cleanup,
  };
}

const withdrawn = (reason: string) => ({
  outcome: "withdrawn",
  evidence: { stage: "probe", reason },
});

test("no owner: an idle, clean, exactly bound harness is asked to exit once; nothing else is typed", async () => {
  vi.stubEnv("CARDIGAN_DARWIN_IDLE_TARGETS", fingerprint);
  const { root, tree, e, ref, options, sends, stop, cleanup } =
    await legacySession();
  const state = (mode: string) => writeFileSync(join(root, "state"), mode);
  try {
    // Unknown or unsupported harness, or a disabled target: no worker IO at all.
    expect(await stop({ harness: undefined })).toEqual(
      withdrawn("conditional_close_unavailable"),
    );
    expect(await stop({ harness: "pi" })).toEqual(
      withdrawn("conditional_close_unavailable"),
    );
    vi.stubEnv("CARDIGAN_DARWIN_IDLE_TARGETS", "0");
    expect(await exitDarwinHarness(e, ref, options)).toEqual(
      withdrawn("conditional_close_unavailable"),
    );
    vi.stubEnv("CARDIGAN_DARWIN_IDLE_TARGETS", fingerprint);
    // Unpreserved work is never put at risk.
    writeFileSync(join(tree, "pending"), "keep me");
    expect(await stop()).toEqual(withdrawn("workspace_unverified"));
    rmSync(join(tree, "pending"));
    // Busy, kept, reused address after a manager change, PID reuse.
    state("working");
    expect(await stop()).toEqual(withdrawn("terminal_busy"));
    state("keep");
    expect(await stop()).toEqual(withdrawn("kept_terminal"));
    state("reused");
    expect(await stop()).toEqual(withdrawn("identity_changed"));
    state("idle");
    expect(
      await stop({
        enrolled_process: { ...options.enrolled_process, start: "reused" },
      }),
    ).toEqual(withdrawn("identity_changed"));
    // The controller's final business guard declines, or work arrives while it runs.
    expect(await stop({ before_signal: () => false })).toEqual(
      withdrawn("guard_changed"),
    );
    expect(
      await stop({
        before_signal: () => {
          state("working");
          return true;
        },
      }),
    ).toEqual(withdrawn("terminal_busy"));
    // hc's own idle condition refuses at typing time.
    state("flip");
    expect(await stop()).toEqual(withdrawn("terminal_busy"));
    expect(sends()).toBe("");
    // A lost receipt after go keeps the fence: never reported as not sent.
    state("drop");
    expect((await stop()).outcome).toBe("uncertain");
    expect(sends()).toBe("");
    state("idle");
    expect((await stop()).outcome).toBe("uncertain");
    expect(sends()).toBe("/exit\n");
    await expect.poll(() => existsSync(join(root, "exited"))).toBe(true);
    expect(readFileSync(join(root, "exited"), "utf8")).toBe("0");
    expect(readFileSync(join(root, "typed"), "utf8")).toBe("/exit\n");
    // A finished terminal is never typed into again.
    expect(await stop()).toEqual(withdrawn("terminal_not_live"));
    expect(sends()).toBe("/exit\n");
    expect(existsSync(join(tree, ".git"))).toBe(true);
  } finally {
    await cleanup();
  }
}, 60000);
