import { execFile, execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
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
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { RuntimeRef } from "@cardigan/domain";
import { afterAll, afterEach, expect, test, vi } from "vitest";
import { testHcBinary } from "../../../test-support/hc.js";
import {
  createPrivateTestRoot,
  createTestRuntime,
} from "../../../test-support/paths.js";
import { corePid, stopCore } from "../test-support/hc-core.js";
import { enrollDarwinOwner, stopDarwinOwner } from "./darwin-idle-owner.js";
import { DARWIN_OWNER_SEED, darwinOwnerKey } from "./darwin-owner-key.js";
import type { ExecutionConfig } from "./execution.js";
import { assignment, launch, role } from "./test-support.js";
import { workerFileRequest } from "./worker-files.js";

const execFileAsync = promisify(execFile);

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

/** The registered clone, branch worktree and build checkout one owner guards. */
async function enrolledWorkspace(parent = realpathSync(tmpdir())) {
  const root = mkdtempSync(join(parent, "darwin-owner-")),
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
  mkdirSync(config.directory, { recursive: true });
  return { root, tree, build, git, config, execution };
}

async function ownerFixture(publicPem?: string) {
  const { root, tree, build, git, config, execution } =
    await enrolledWorkspace();
  // A legacy owner holds a key that only the previous controller process had.
  if (publicPem) config.public_pem = publicPem;
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
    // A harness that self-reports a busy state is never stopped.
    for (const busy of ["working", "blocked", "error"]) {
      writeFileSync(join(root, "state"), busy);
      expect(await stop()).toEqual({
        outcome: "withdrawn",
        evidence: { stage: "probe", reason: "probe_invalid" },
      });
    }
    expect(proc.exitCode).toBeNull();
    process.kill(pid, 0);
    // Claude Code and Codex never self-report: hc keeps their status null.
    // Null alone is not idle: a turn still running on screen is never stopped.
    writeFileSync(join(root, "state"), "null");
    writeFileSync(join(root, "screen"), "busy");
    expect(await stop()).toEqual({
      outcome: "withdrawn",
      evidence: { stage: "probe", reason: "probe_invalid" },
    });
    expect(proc.exitCode).toBeNull();
    process.kill(pid, 0);
    // Back at its own empty prompt, the same null-status session may be stopped.
    writeFileSync(join(root, "screen"), "idle");
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

// C-602: the owner reads the terminal record and screen from the real core,
// not a model. Only the Darwin platform/account checks and the native birth
// adapter are substituted (on macOS the birth adapter is the native one); the
// isolated session never touches a production socket or session.
const hcBinary =
  process.env.CARDIGAN_TEST_HC ?? join(homedir(), ".local/bin/hc");
const hcAvailable = testHcBinary({ binary: hcBinary });
test.skipIf(!hcAvailable || !["linux", "darwin"].includes(process.platform))(
  "real hc: a null-status session at its empty prompt is stopped; one still in its turn or reporting busy is not",
  async () => {
    vi.stubEnv("CARDIGAN_DARWIN_IDLE_TARGETS", fingerprint);
    // Short, canonical paths: Darwin limits UNIX socket names to 104 bytes.
    const dir = createPrivateTestRoot();
    const runtime = realpathSync(createTestRuntime(join(dir, "rt")));
    const session = `own-${randomUUID().slice(0, 8)}`,
      socket = join(runtime, "hc.sock");
    const env = {
      ...process.env,
      HC_SESSION: session,
      HC_SOCKET: socket,
      XDG_RUNTIME_DIR: runtime,
      XDG_STATE_HOME: join(dir, "state"),
      XDG_CONFIG_HOME: join(dir, "config"),
    };
    const hc = async (...args: string[]) =>
      (await execFileAsync(hcBinary, args, { env, timeout: 10000 })).stdout;
    const transport = async (_: unknown, argv: readonly string[]) => ({
      file: argv[0]!,
      args: argv.slice(1),
    });
    const owned = async (screen: "idle" | "busy", report?: "working") => {
      const w = await enrolledWorkspace(dir);
      // Names are unique among live terminals; the owner checks its own.
      w.config.agent_name = ["fixture", screen, report]
        .filter(Boolean)
        .join("-");
      const launched = JSON.parse(
        await hc(
          "run",
          "--bg",
          "--json",
          "--no-parent",
          "--no-notify",
          "--name",
          w.config.agent_name,
          "--cwd",
          w.tree,
          ...Object.entries({
            cardigan: "1",
            project: "fixture",
            assignment: "A-1",
            run: "R-1",
            generation,
          }).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
          "--",
          "python3",
          "-IB",
          resolve("packages/runtime-herdr/test-support/darwin-idle-fixture.py"),
          resolve("deploy/darwin-idle-owner.py"),
          JSON.stringify(w.config),
          ["real", screen, ...(report ? [report] : [])].join(":"),
        ),
      );
      const terminal = launched.address as string;
      const record = async () =>
        JSON.parse(await hc("get", terminal, "--json"));
      await expect
        .poll(() => existsSync(join(w.root, "child")), { timeout: 10000 })
        .toBe(true);
      await expect
        .poll(
          async () =>
            (await hc("read", terminal, "--lines", "0")).includes(
              "? for shortcuts",
            ) && (await record()).foreground?.pid,
          { timeout: 10000 },
        )
        .toEqual(expect.any(Number));
      if (report)
        await expect
          .poll(async () => (await record()).status?.state, { timeout: 10000 })
          .toBe(report);
      const enrolled = JSON.parse(readFileSync(join(w.root, "child"), "utf8"));
      const stop = () =>
        stopDarwinOwner(
          w.execution,
          { ...ref, terminal_ref: `fixture/${terminal}` },
          {
            project_id: "fixture",
            assignment_id: "A-1",
            hangup_ms: 100,
            terminate_ms: 500,
            before_signal: () => true,
            enrolled_process: enrolled,
          },
          transport,
        );
      return { ...w, terminal, record, enrolled, stop };
    };
    const refused = {
      outcome: "withdrawn",
      evidence: { stage: "probe", reason: "probe_invalid" },
    };
    try {
      // Codex and Claude Code never send OSC 7501: status stays null in both.
      const running = await owned("busy");
      const quiet = await owned("idle");
      for (const s of [running, quiet])
        expect(await s.record()).toMatchObject({
          state: "live",
          status: null,
          cwd: s.tree,
          name: s.config.agent_name,
          rm: false,
          keep: false,
        });
      // The old turn is still running on screen: never signed, never stopped.
      expect(await running.stop()).toEqual(refused);
      expect((await running.record()).state).toBe("live");
      process.kill(running.enrolled.pid, 0);
      // Back at its own empty prompt: signed, TERM to the direct child only.
      const before = await quiet.record();
      expect(before.foreground.pid).toBe(before.pid);
      expect(await quiet.stop()).toEqual({
        outcome: "uncertain",
        evidence: { stage: "confirm", reason: "confirmation_pending" },
      });
      await expect
        .poll(async () => (await quiet.record()).state, { timeout: 10000 })
        .toBe("finished");
      expect((await quiet.record()).exit_code).toBe(143);
      expect(() => process.kill(quiet.enrolled.pid, 0)).toThrow();
      expect(existsSync(join(quiet.tree, ".git"))).toBe(true);
      expect((await running.record()).state).toBe("live");
      // A harness that reports itself busy is refused even at a prompt.
      const working = await owned("idle", "working");
      expect(await working.stop()).toEqual(refused);
      process.kill(working.enrolled.pid, 0);
      for (const s of [running, working]) await hc("kill", s.terminal);
    } finally {
      await stopCore({
        session,
        socket,
        env,
        pid: corePid({ session, socket, env }),
      });
      rmSync(dir, { recursive: true, force: true });
    }
  },
  60000,
);
