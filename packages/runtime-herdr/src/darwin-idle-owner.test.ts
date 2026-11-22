import { execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RuntimeRef } from "@cardigan/domain";
import { afterAll, afterEach, expect, test, vi } from "vitest";
import { enrollDarwinOwner, stopDarwinOwner } from "./darwin-idle-owner.js";
import { DARWIN_OWNER_SEED, darwinOwnerKey } from "./darwin-owner-key.js";
import type { ExecutionConfig } from "./execution.js";
import { assignment, launch, role } from "./test-support.js";
import { workerFileRequest } from "./worker-files.js";

const generation = "a".repeat(32),
  fingerprint = "b".repeat(64),
  dataDir = mkdtempSync(join(realpathSync(tmpdir()), "darwin-owner-data-"));
const e: Extract<ExecutionConfig, { mode: "agent-ssh" }> = {
  mode: "agent-ssh",
  machine: "fixture",
  agentRoot: "/fixture",
  gid: 1234,
  user: "worker",
  identityFile: "/private/id",
  knownHostsFile: "/private/hosts",
  dataDir,
  target: {
    machine_id: "remote",
    project_id: "fixture",
    generation: "binding",
    session: "fixture",
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
function launchArgsFor(execution: typeof e) {
  const packet = workerFileRequest(
    execution,
    {
      project: "fixture",
      assignment: "A-1",
      run: "R-1",
      generation,
      target: fingerprint,
    },
    "status",
  );
  return [
    "-I",
    "-B",
    "/installed/worker-files.py",
    JSON.stringify(execution.publication),
    "run",
    packet.subarray(0, packet.indexOf(10)).toString(),
    "a".repeat(64),
  ];
}
const launchArgs = launchArgsFor(e);
const l = {
  ...launch,
  command: "/usr/bin/python3",
  args: launchArgs,
  labels: { ...launch.labels, generation },
};
const ref: RuntimeRef = {
  machine_id: "remote",
  runtime_machine: "fixture",
  terminal_ref: "fixture/t1",
  agent_name: "fixture",
  target: e.target!,
  launch_generation: { run_id: "R-1" as never, generation },
};
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

test("registration excludes legacy, Linux, standing, external and disabled launches", async () => {
  vi.stubEnv("CARDIGAN_DARWIN_IDLE_TARGETS", "0");
  expect(await enrollDarwinOwner(e, assignment, role, l)).toBe(l);
  vi.stubEnv("CARDIGAN_DARWIN_IDLE_TARGETS", fingerprint);
  const { macosCore: _m, ...linux } = e;
  expect(await enrollDarwinOwner(linux, assignment, role, l)).toBe(l);
  for (const a of [
    { ...assignment, external: true },
    { ...assignment, scope: "standing" as const },
  ])
    expect(await enrollDarwinOwner(e, a, role, l)).toBe(l);
  expect(await enrollDarwinOwner(e, assignment, role, launch)).toBe(launch);
  const managed = await enrollDarwinOwner(e, assignment, role, l);
  expect(managed.args.slice(-8)).toEqual([l.command, ...launchArgs]);
  expect(managed.args.join(" ")).not.toContain("PRIVATE KEY");
  // Only the host-private seed is stored; the enrollment key is rebuilt from it.
  expect(statSync(join(dataDir, DARWIN_OWNER_SEED)).mode & 0o777).toBe(0o600);
  const config = JSON.parse(managed.args[4]!);
  const rebuilt = await darwinOwnerKey(
    dataDir,
    JSON.stringify([fingerprint, config.directory, "R-1"]),
  );
  expect(config.public_pem).toBe(
    rebuilt.publicKey.export({ type: "spki", format: "pem" }),
  );
  // No seed directory: the session still launches, just unenrolled.
  vi.spyOn(console, "error").mockImplementation(() => {});
  const missing = { ...e, dataDir: join(dataDir, "missing") };
  expect(await enrollDarwinOwner(missing, assignment, role, l)).toBe(l);
});

async function ownerFixture(publicPem?: string) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "darwin-owner-")),
    tree = join(root, "worktrees/fixture/A-1"),
    build = join(root, "builds/fixture/A-1"),
    repo = join(root, "repos/fixture"),
    execution = { ...e, agentRoot: root };
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
  // Same registered clone, branch worktree and detached build checkout as WorkerGitTransport.
  git("worktree", "add", "-q", "-b", "agent/fixture", "--", tree, "HEAD");
  git("worktree", "add", "-q", "--detach", "--", build, "HEAD");
  writeFileSync(join(root, "state"), "idle");
  const launched = await enrollDarwinOwner(execution, assignment, role, {
    ...l,
    args: launchArgsFor(execution),
    cwd: tree,
  });
  const config = JSON.parse(launched.args[4]!);
  // A legacy owner holds a key that only the previous controller process had.
  if (publicPem) config.public_pem = publicPem;
  mkdirSync(config.directory, { recursive: true });
  const proc = spawn(
    "python3",
    [
      "-IB",
      resolve("packages/runtime-herdr/test-support/darwin-idle-fixture.py"),
      resolve("deploy/darwin-idle-owner.py"),
      JSON.stringify(config),
    ],
    {
      cwd: tree,
      env: { ...process.env, HC_TERMINAL_ID: "t1" },
      stdio: "ignore",
    },
  );
  const closed = once(proc, "close");
  const cleanup = async () => {
    if (proc.exitCode === null) {
      proc.kill();
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
    before_signal: () => true,
    enrolled_process: enrolled,
  };
  // Exercise the exact worker-side relay without SSH or production credentials.
  const transport = async (_: unknown, argv: readonly string[]) => ({
    file: argv[0]!,
    args: argv.slice(1),
  });
  const stop = (
    patch: Partial<typeof options> = {},
    stopOwner = stopDarwinOwner,
  ) => stopOwner(execution, ref, { ...options, ...patch }, transport);
  return {
    root,
    tree,
    build,
    git,
    config,
    proc,
    closed,
    enrolled,
    pid: enrolled.pid as number,
    stop,
    cleanup,
  };
}

test("signed normal stop binds the direct child; dirty, stale, busy and withdrawn requests do not stop it", async () => {
  vi.stubEnv("CARDIGAN_DARWIN_IDLE_TARGETS", fingerprint);
  const f = await ownerFixture();
  const { root, tree, build, git, config, proc, closed, enrolled, pid } = f;
  const { stop, cleanup } = f;
  try {
    expect(
      (
        await stop({
          enrolled_process: { ...enrolled, start: "reused" },
        })
      ).outcome,
    ).toBe("withdrawn");
    expect((await stop({ before_signal: () => false })).outcome).toBe(
      "withdrawn",
    );
    writeFileSync(join(tree, "pending"), "preserve me");
    expect((await stop()).outcome).toBe("withdrawn");
    expect(readFileSync(join(tree, "pending"), "utf8")).toBe("preserve me");
    rmSync(join(tree, "pending"));
    writeFileSync(join(build, "pending"), "keep build changes");
    expect((await stop()).outcome).toBe("withdrawn");
    expect(readFileSync(join(build, "pending"), "utf8")).toBe(
      "keep build changes",
    );
    rmSync(join(build, "pending"));
    const marker = join(tree, ".git"),
      registered = readFileSync(marker);
    writeFileSync(marker, readFileSync(join(build, ".git"))); // Same repository, wrong backlink.
    expect((await stop()).outcome).toBe("withdrawn");
    writeFileSync(marker, `gitdir: ${join(root, "unbound", ".git")}\n`);
    expect((await stop()).outcome).toBe("withdrawn");
    rmSync(marker);
    symlinkSync(join(build, ".git"), marker);
    expect((await stop()).outcome).toBe("withdrawn");
    rmSync(marker);
    writeFileSync(marker, registered);
    const commonFile = join(
      registered.toString().trim().slice("gitdir: ".length),
      "commondir",
    );
    const common = readFileSync(commonFile);
    writeFileSync(commonFile, "../elsewhere\n");
    expect((await stop()).outcome).toBe("withdrawn");
    writeFileSync(commonFile, common);
    git("config", "remote.origin.url", "cardigan-central:other");
    expect((await stop()).outcome).toBe("withdrawn");
    git("config", "remote.origin.url", "cardigan-central:fixture");
    // Become busy AFTER worker readiness. A signed request without independent
    // exit evidence retains the fence, even when the worker reports refusal.
    expect(
      (
        await stop({
          before_signal: () => {
            writeFileSync(join(root, "state"), "working");
            return true;
          },
        })
      ).outcome,
    ).toBe("uncertain");
    expect(proc.exitCode).toBeNull();
    process.kill(pid, 0);
    writeFileSync(join(root, "state"), "replaced");
    expect((await stop()).outcome).toBe("withdrawn");
    writeFileSync(join(root, "state"), "idle");
    // A missing or replaced seed cannot serve this owner: refuse, never sign.
    const seed = join(dataDir, DARWIN_OWNER_SEED);
    renameSync(seed, `${seed}.saved`);
    expect(await stop()).toEqual({
      outcome: "withdrawn",
      evidence: { stage: "probe", reason: "conditional_close_unavailable" },
    });
    writeFileSync(seed, Buffer.alloc(32, 7), { mode: 0o600 });
    expect(await stop()).toEqual({
      outcome: "withdrawn",
      evidence: { stage: "probe", reason: "conditional_close_unavailable" },
    });
    renameSync(`${seed}.saved`, seed);
    expect(proc.exitCode).toBeNull();
    process.kill(pid, 0);
    // A restarted controller holds no enrollment state; it rebuilds the key.
    vi.resetModules();
    const restarted = await import("./darwin-idle-owner.js");
    expect((await stop({}, restarted.stopDarwinOwner)).outcome).toBe(
      "uncertain",
    );
    expect((await closed)[0]).toBe(143);
    expect(existsSync(join(config.directory, "idle-owner.sock"))).toBe(false);
    expect(existsSync(join(tree, ".git"))).toBe(true);
  } finally {
    await cleanup();
  }
}, 20000);

test("an owner enrolled with a key the controller cannot rebuild is never signed for", async () => {
  vi.stubEnv("CARDIGAN_DARWIN_IDLE_TARGETS", fingerprint);
  const legacy = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const { proc, pid, stop, cleanup } = await ownerFixture(
    legacy.publicKey.export({ type: "spki", format: "pem" }).toString(),
  );
  try {
    expect(await stop()).toEqual({
      outcome: "withdrawn",
      evidence: { stage: "probe", reason: "conditional_close_unavailable" },
    });
    expect(proc.exitCode).toBeNull();
    process.kill(pid, 0);
  } finally {
    await cleanup();
  }
}, 20000);

test("a generation without an owner is refused with no further worker command", async () => {
  vi.stubEnv("CARDIGAN_DARWIN_IDLE_TARGETS", fingerprint);
  const root = mkdtempSync(join(realpathSync(tmpdir()), "darwin-unowned-"));
  const execution = { ...e, agentRoot: root };
  const launched = await enrollDarwinOwner(execution, assignment, role, {
    ...l,
    args: launchArgsFor(execution),
  });
  // The launch directory exists, but no owner ever listened in it.
  mkdirSync(JSON.parse(launched.args[4]!).directory, { recursive: true });
  const commands: (readonly string[])[] = [];
  const transport = async (_: unknown, argv: readonly string[]) => {
    commands.push(argv);
    return { file: argv[0]!, args: argv.slice(1) };
  };
  try {
    expect(
      await stopDarwinOwner(
        execution,
        ref,
        {
          project_id: "fixture",
          assignment_id: "A-1",
          hangup_ms: 100,
          terminate_ms: 500,
          before_signal: () => {
            throw new Error("never reached without an owner");
          },
          enrolled_process: {
            machine: fingerprint,
            boot: "boot",
            uid: 501,
            pid: 4242,
            start: "1",
            process_group: 4242,
            terminal: generation,
          },
        },
        transport,
      ),
    ).toEqual({
      outcome: "withdrawn",
      evidence: { stage: "probe", reason: "conditional_close_unavailable" },
    });
    // Only the signal-free relay ran; nothing was typed, signalled or sent.
    expect(commands).toHaveLength(1);
    expect(commands[0]!.slice(0, 3)).toEqual(["/usr/bin/python3", "-IB", "-c"]);
    expect(commands[0]![3]).toContain("idle-owner.sock");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
