import { execFile, execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
import { boundPrompt } from "./bound-prompt.js";
import { enrollDarwinOwner, stopDarwinOwner } from "./darwin-idle-owner.js";
import {
  DARWIN_ENROLLMENT_DIR,
  readDarwinEnrollment,
} from "./darwin-owner-enrollment.js";
import { DARWIN_OWNER_SEED, darwinOwnerKey } from "./darwin-owner-key.js";
import type { ExecutionConfig } from "./execution.js";
import { assignment, launch, role } from "./test-support.js";
import { workerFileRequest, workerLaunchPath } from "./worker-files.js";

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
// C-611: the owner fixture marks where a case is (task.meta.cardigan_phases),
// so a timed-out macOS check reports the last step the case reached.
let current: { meta: object; started: number } | undefined;
test.beforeEach(({ task }) => {
  current = { meta: task.meta, started: performance.now() };
});
function phases() {
  const marks: { name: string; at_ms: number }[] = [];
  const at = current;
  if (at) Object.assign(at.meta, { cardigan_phases: marks });
  return (name: string) => {
    if (at && marks.length < 50)
      marks.push({ name, at_ms: Math.round(performance.now() - at.started) });
  };
}

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
/** C-804: still `conditional_close_unavailable`, now naming the precondition
 * and this host's enrollment record of the launch. */
const unavailable = (
  precondition: string,
  facts: { enrollment?: string; exit_code?: number } = {},
) => ({
  outcome: "withdrawn",
  evidence: {
    stage: "probe",
    reason: "conditional_close_unavailable",
    precondition,
    enrollment: "enrolled",
    ...facts,
  },
});
/** C-746: a pre-challenge refusal the owner named (nothing was signed). */
const refusedBy = (
  reason: "probe_invalid" | "workspace_not_clean" | "terminal_busy",
  owner_reason: string,
) => ({
  outcome: "withdrawn",
  evidence: { stage: "probe", reason, owner_reason },
});

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

test("C-804: a skipped registration records why; retirement reads it back", async () => {
  vi.stubEnv("CARDIGAN_DARWIN_IDLE_TARGETS", fingerprint);
  vi.spyOn(console, "error").mockImplementation(() => {});
  const data = mkdtempSync(join(realpathSync(tmpdir()), "darwin-skip-"));
  const execution = { ...e, dataDir: data };
  const id = JSON.stringify([
    fingerprint,
    workerLaunchPath(e, {
      project: "fixture",
      assignment: "A-1",
      run: "R-1",
      generation,
      target: fingerprint,
    }).value,
    "R-1",
  ]);
  const recorded = () => readDarwinEnrollment(data, id);
  try {
    // Not this controller's opted-in Darwin launch: nothing recorded.
    vi.stubEnv("CARDIGAN_DARWIN_IDLE_TARGETS", "0");
    expect(await enrollDarwinOwner(execution, assignment, role, l)).toBe(l);
    expect(await recorded()).toBe("unrecorded");
    vi.stubEnv("CARDIGAN_DARWIN_IDLE_TARGETS", fingerprint);
    const { user: _u, ...noUser } = execution;
    const cases = [
      ["worker_config", noUser, assignment, role, l],
      [
        "assignment_scope",
        execution,
        { ...assignment, external: true },
        role,
        l,
      ],
      [
        "assignment_scope",
        execution,
        { ...assignment, scope: "standing" as const },
        role,
        l,
      ],
      [
        "role_worktree",
        execution,
        assignment,
        { ...role, worktree: undefined },
        l,
      ],
      ["launch_shape", execution, assignment, role, { ...l, command: "node" }],
      [
        "launch_labels",
        execution,
        assignment,
        role,
        { ...l, labels: { ...l.labels, assignment: "A-2" } },
      ],
      [
        "launch_packet",
        execution,
        assignment,
        role,
        { ...l, args: l.args.map((v, i) => (i === 5 ? "{}" : v)) },
      ],
    ] as const;
    for (const [reason, ex, a, r, launched] of cases) {
      expect(await enrollDarwinOwner(ex, a, r as never, launched)).toBe(
        launched,
      );
      expect(await recorded()).toBe(reason);
    }
    // A seed this host cannot verify is never replaced: launched unenrolled.
    writeFileSync(join(data, DARWIN_OWNER_SEED), Buffer.alloc(32, 1), {
      mode: 0o644,
    });
    expect(await enrollDarwinOwner(execution, assignment, role, l)).toBe(l);
    expect(await recorded()).toBe("seed_unavailable");
    // The record is host-private and holds only the bounded token.
    const dir = join(data, DARWIN_ENROLLMENT_DIR);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(readdirSync(dir)).toHaveLength(1);
    const file = join(dir, readdirSync(dir)[0]!);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toBe("seed_unavailable\n");
    // The refused retirement names the launch's skipped enrollment.
    const transport = vi.fn();
    expect(
      await stopDarwinOwner(
        execution,
        ref,
        {
          project_id: "fixture",
          assignment_id: "A-1",
          hangup_ms: 100,
          terminate_ms: 500,
          before_signal: () => true,
        },
        transport,
      ),
    ).toEqual(
      unavailable("enrolled_process_missing", {
        enrollment: "seed_unavailable",
      }),
    );
    expect(transport).not.toHaveBeenCalled();
    // A record that is not a bounded token is not repeated.
    writeFileSync(file, "/Users/someone/secret\n");
    expect(await recorded()).toBe("unreadable");
    rmSync(file);
    symlinkSync(join(data, DARWIN_OWNER_SEED), file);
    expect(await recorded()).toBe("unreadable");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("C-804: every refused precondition before the relay is named; none runs a worker command", async () => {
  vi.stubEnv("CARDIGAN_DARWIN_IDLE_TARGETS", fingerprint);
  const root = mkdtempSync(join(realpathSync(tmpdir()), "darwin-pre-"));
  const execution = { ...e, agentRoot: root };
  await enrollDarwinOwner(execution, assignment, role, {
    ...l,
    args: launchArgsFor(execution),
  });
  const process_ = {
    machine: fingerprint,
    boot: "boot",
    uid: 501,
    pid: 4242,
    start: "1",
    process_group: 4242,
    terminal: generation,
  };
  const transport = vi.fn();
  const before_signal = vi.fn(() => true);
  const ask = (
    patch: { ref?: Partial<RuntimeRef>; process?: typeof process_ | null } = {},
    ex: typeof e = execution,
  ) =>
    stopDarwinOwner(
      ex,
      { ...ref, ...patch.ref },
      {
        project_id: "fixture",
        assignment_id: "A-1",
        hangup_ms: 100,
        terminate_ms: 500,
        before_signal,
        ...(patch.process === null
          ? {}
          : { enrolled_process: patch.process ?? process_ }),
      },
      transport,
    );
  const without = (precondition: string) => ({
    outcome: "withdrawn",
    evidence: {
      stage: "probe",
      reason: "conditional_close_unavailable",
      precondition,
    },
  });
  try {
    vi.stubEnv("CARDIGAN_DARWIN_IDLE_TARGETS", "0");
    expect(await ask()).toEqual(without("target_not_enabled"));
    vi.stubEnv("CARDIGAN_DARWIN_IDLE_TARGETS", fingerprint);
    const { target: _t, ...untargeted } = execution;
    expect(await ask({}, untargeted)).toEqual(without("target_not_enabled"));
    const { launch_generation: _g, ...legacy } = ref;
    expect(
      await stopDarwinOwner(
        execution,
        legacy,
        {
          project_id: "fixture",
          assignment_id: "A-1",
          hangup_ms: 100,
          terminate_ms: 500,
          before_signal,
          enrolled_process: process_,
        },
        transport,
      ),
    ).toEqual(without("launch_generation_missing"));
    expect(await ask({ ref: { terminal_ref: "other/t1" } })).toEqual(
      without("terminal_machine_mismatch"),
    );
    expect(await ask({ process: null })).toEqual(
      unavailable("enrolled_process_missing"),
    );
    expect(
      await ask({ process: { ...process_, machine: "e".repeat(64) } }),
    ).toEqual(unavailable("receipt_target_mismatch"));
    expect(
      await ask({ process: { ...process_, terminal: "f".repeat(32) } }),
    ).toEqual(unavailable("receipt_generation_mismatch"));
    // Launched before C-804 (or the record was lost): said so, still refused.
    const other = { ...execution, agentRoot: join(root, "other") };
    expect(await ask({ process: null }, other)).toEqual(
      unavailable("enrolled_process_missing", { enrollment: "unrecorded" }),
    );
    // Nothing reached the worker, and nothing was signed.
    expect(transport).not.toHaveBeenCalled();
    expect(before_signal).not.toHaveBeenCalled();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
  let child: number | undefined;
  const cleanup = async () => {
    if (proc.exitCode === null) {
      proc.kill();
      await closed;
    }
    // A failed test leaves the owner's direct child running; end it too.
    try {
      if (child) process.kill(child);
    } catch {}
    rmSync(root, { recursive: true, force: true });
  };
  try {
    await expect.poll(() => existsSync(join(root, "child"))).toBe(true);
  } catch (err) {
    await cleanup();
    throw err;
  }
  const enrolled = JSON.parse(readFileSync(join(root, "child"), "utf8"));
  child = enrolled.pid;
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
  const mark = phases();
  mark("fixture ready");
  void closed.then(
    ([code]) => mark(`child closed: ${code}`),
    () => {},
  );
  let stops = 0;
  const stop = async (
    patch: Partial<typeof options> = {},
    stopOwner = stopDarwinOwner,
  ) => {
    const n = ++stops;
    mark(`stop ${n}`);
    const result = await stopOwner(
      execution,
      ref,
      { ...options, ...patch },
      transport,
    );
    mark(`stop ${n}: ${result.outcome}`);
    return result;
  };
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
    // C-746: every refusal names its failed proof; none of them signals.
    // A receipt whose birth identity differs is never the process to stop.
    expect(
      await stop({
        enrolled_process: { ...enrolled, start: "reused" },
      }),
    ).toEqual(refusedBy("probe_invalid", "cli_identity_unproven"));
    // Another PID than the owner's own direct child is refused before any proof.
    expect(
      await stop({
        enrolled_process: { ...enrolled, pid: enrolled.pid + 1 },
      }),
    ).toEqual(refusedBy("probe_invalid", "request_mismatch"));
    expect(proc.exitCode).toBeNull();
    process.kill(pid, 0);
    expect((await stop({ before_signal: () => false })).outcome).toBe(
      "withdrawn",
    );
    writeFileSync(join(tree, "pending"), "preserve me");
    // The abandoned challenge released the owner: the next request is served
    // without waiting out the owner's 3 s signature read.
    const served = Date.now();
    expect(await stop()).toEqual(
      refusedBy("workspace_not_clean", "worktree_dirty"),
    );
    expect(Date.now() - served).toBeLessThan(2500);
    expect(readFileSync(join(tree, "pending"), "utf8")).toBe("preserve me");
    rmSync(join(tree, "pending"));
    writeFileSync(join(build, "pending"), "keep build changes");
    expect(await stop()).toEqual(
      refusedBy("workspace_not_clean", "build_worktree_dirty"),
    );
    expect(readFileSync(join(build, "pending"), "utf8")).toBe(
      "keep build changes",
    );
    rmSync(join(build, "pending"));
    const marker = join(tree, ".git"),
      registered = readFileSync(marker);
    writeFileSync(marker, readFileSync(join(build, ".git"))); // Same repository, wrong backlink.
    expect(await stop()).toEqual(
      refusedBy("workspace_not_clean", "worktree_unregistered"),
    );
    writeFileSync(marker, `gitdir: ${join(root, "unbound", ".git")}\n`);
    expect(await stop()).toEqual(
      refusedBy("workspace_not_clean", "worktree_unregistered"),
    );
    rmSync(marker);
    symlinkSync(join(build, ".git"), marker);
    expect(await stop()).toEqual(
      refusedBy("workspace_not_clean", "workspace_unreadable"),
    );
    rmSync(marker);
    writeFileSync(marker, registered);
    const commonFile = join(
      registered.toString().trim().slice("gitdir: ".length),
      "commondir",
    );
    const common = readFileSync(commonFile);
    writeFileSync(commonFile, "../elsewhere\n");
    expect(await stop()).toEqual(
      refusedBy("workspace_not_clean", "worktree_unregistered"),
    );
    writeFileSync(commonFile, common);
    git("config", "remote.origin.url", "cardigan-central:other");
    expect(await stop()).toEqual(
      refusedBy("workspace_not_clean", "git_remote"),
    );
    git("config", "remote.origin.url", "cardigan-central:fixture");
    // A repository-local setting outside the allowed set is not proof either.
    git("config", "lfs.repositoryformatversion", "0");
    expect(await stop()).toEqual(
      refusedBy("workspace_not_clean", "git_config"),
    );
    git("config", "--unset", "lfs.repositoryformatversion");
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
    expect(await stop()).toEqual(
      refusedBy("probe_invalid", "terminal_unreadable"),
    );
    // A harness that self-reports a busy state is never stopped.
    for (const busy of ["working", "blocked", "error"]) {
      writeFileSync(join(root, "state"), busy);
      expect(await stop()).toEqual(
        refusedBy("terminal_busy", "terminal_not_idle"),
      );
    }
    expect(proc.exitCode).toBeNull();
    process.kill(pid, 0);
    // Claude Code and Codex never self-report: hc keeps their status null.
    // Null alone is not idle: a turn still running on screen is never stopped.
    writeFileSync(join(root, "state"), "null");
    writeFileSync(join(root, "screen"), "busy");
    expect(await stop()).toEqual(
      refusedBy("terminal_busy", "terminal_not_idle"),
    );
    expect(proc.exitCode).toBeNull();
    process.kill(pid, 0);
    // A malformed core reply refuses this request; the owner keeps serving.
    writeFileSync(join(root, "screen"), "malformed");
    expect(await stop()).toEqual(
      refusedBy("probe_invalid", "terminal_unreadable"),
    );
    // Still listening: an exited owner would answer conditional_close_unavailable.
    writeFileSync(join(root, "screen"), "busy");
    expect(await stop()).toEqual(
      refusedBy("terminal_busy", "terminal_not_idle"),
    );
    expect(proc.exitCode).toBeNull();
    process.kill(pid, 0);
    // C-746: a running turn or a draft under the status line is still kept.
    for (const screen of ["status_busy", "status_draft"]) {
      writeFileSync(join(root, "screen"), screen);
      expect(await stop()).toEqual(
        refusedBy("terminal_busy", "terminal_not_idle"),
      );
    }
    // Back at its own empty prompt, the same null-status session may be
    // stopped, also with Cardigan's status line drawn under the editor
    // (sensen A-252: refused as probe_invalid for hours before C-746).
    writeFileSync(join(root, "screen"), "status");
    // A missing or replaced seed cannot serve this owner: refuse, never sign.
    const seed = join(dataDir, DARWIN_OWNER_SEED);
    renameSync(seed, `${seed}.saved`);
    expect(await stop()).toEqual(unavailable("seed_missing"));
    // C-804: another seed rebuilds another key; the owner's id disagrees.
    writeFileSync(seed, Buffer.alloc(32, 7), { mode: 0o600 });
    expect(await stop()).toEqual(unavailable("owner_key_mismatch"));
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
  // About 19 real owner round trips, two of them with both 1.5 s idle reads.
}, 30000);

test("an owner enrolled with a key the controller cannot rebuild is never signed for", async () => {
  vi.stubEnv("CARDIGAN_DARWIN_IDLE_TARGETS", fingerprint);
  const legacy = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const { proc, pid, stop, cleanup } = await ownerFixture(
    legacy.publicKey.export({ type: "spki", format: "pem" }).toString(),
  );
  try {
    expect(await stop()).toEqual(unavailable("owner_key_mismatch"));
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
    ).toEqual(unavailable("owner_not_listening", { exit_code: 3 }));
    // Only the signal-free relay ran; nothing was typed, signalled or sent.
    expect(commands).toHaveLength(1);
    expect(commands[0]!.slice(0, 3)).toEqual(["/usr/bin/python3", "-IB", "-c"]);
    expect(commands[0]![3]).toContain("idle-owner.sock");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("C-746: an owner's named refusal, an anonymous close and a transport failure are told apart; none is signed", async () => {
  vi.stubEnv("CARDIGAN_DARWIN_IDLE_TARGETS", fingerprint);
  const root = mkdtempSync(join(realpathSync(tmpdir()), "darwin-refusal-"));
  const execution = { ...e, agentRoot: root };
  // Enrolls the key the controller would rebuild for this generation.
  const launched = await enrollDarwinOwner(execution, assignment, role, {
    ...l,
    args: launchArgsFor(execution),
  });
  const { directory } = JSON.parse(launched.args[4]!);
  // Stands in for the worker relay: prints `reply` (if any) after reading the
  // request line, then exits with `code`. Never reads a signature.
  const relay =
    (reply: string, code: number) =>
    async (_: unknown, argv: readonly string[]) => {
      expect(argv[3]).toContain("idle-owner.sock");
      return {
        file: "python3",
        args: [
          "-c",
          `import sys\nsys.stdin.readline()\nsys.stdout.write(${JSON.stringify(reply)})\nsys.stdout.flush()\nsys.exit(${code})`,
        ],
      };
    };
  const signed = vi.fn(() => true);
  const ask = (reply: string, code: number) =>
    stopDarwinOwner(
      execution,
      ref,
      {
        project_id: "fixture",
        assignment_id: "A-1",
        hangup_ms: 100,
        terminate_ms: 500,
        before_signal: signed,
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
      relay(reply, code),
    );
  try {
    for (const [code, reason] of [
      ["worktree_dirty", "workspace_not_clean"],
      ["git_config", "workspace_not_clean"],
      ["git_timeout", "workspace_not_clean"],
      ["workspace_cwd", "workspace_not_clean"],
      ["build_worktree_dirty", "workspace_not_clean"],
      ["terminal_not_idle", "terminal_busy"],
      ["terminal_unreadable", "probe_invalid"],
      ["terminal_owner_mismatch", "probe_invalid"],
      ["cli_identity_unproven", "probe_invalid"],
      ["request_mismatch", "probe_invalid"],
      ["cli_exited", "probe_invalid"],
    ] as const)
      expect(await ask(`refused ${code}\n`, 1)).toEqual({
        outcome: "withdrawn",
        evidence: { stage: "probe", reason, owner_reason: code },
      });
    // An owner enrolled before C-746 closes without a word (relay exit 1).
    expect(await ask("", 1)).toEqual({
      outcome: "withdrawn",
      evidence: {
        stage: "probe",
        reason: "probe_invalid",
        owner_reason: "no_reply",
        exit_code: 1,
      },
    });
    // SSH itself failed: the exit status says so.
    expect(await ask("", 255)).toEqual({
      outcome: "withdrawn",
      evidence: {
        stage: "probe",
        reason: "probe_invalid",
        owner_reason: "no_reply",
        exit_code: 255,
      },
    });
    // Neither a refusal nor a challenge: not trusted, nothing signed.
    expect((await ask("refused ../../etc\n", 1)).evidence).toMatchObject({
      reason: "probe_invalid",
      owner_reason: "relay_failed",
    });
    // C-804: no owner listens for this generation (relay exit 3).
    const seen = [await ask("", 3)];
    expect(seen[0]).toEqual(
      unavailable("owner_not_listening", { exit_code: 3 }),
    );
    // An owner enrolled before durable keys names no key id; another names
    // a different one. Only whether they agree is recorded.
    seen.push(await ask(`${"c".repeat(64)}\n`, 1));
    expect(seen[1]).toEqual(unavailable("owner_key_absent"));
    seen.push(await ask(`${"c".repeat(64)} ${"d".repeat(64)}\n`, 1));
    expect(seen[2]).toEqual(unavailable("owner_key_mismatch"));
    // A seed this controller cannot verify is never replaced or used.
    const seedPath = join(dataDir, DARWIN_OWNER_SEED);
    chmodSync(seedPath, 0o644);
    try {
      seen.push(await ask("", 3));
    } finally {
      chmodSync(seedPath, 0o600);
    }
    expect(seen[3]).toEqual(unavailable("seed_unavailable"));
    // Diagnostics never carry the seed, either key, the key id or a signature.
    const seed = readFileSync(seedPath);
    const key = await darwinOwnerKey(
      dataDir,
      JSON.stringify([fingerprint, directory, "R-1"]),
    );
    const evidence = JSON.stringify(seen);
    for (const secret of [
      seed.toString("hex"),
      seed.toString("base64"),
      seed.toString("base64url"),
      key.id,
      "PRIVATE KEY",
      "PUBLIC KEY",
    ])
      expect(evidence).not.toContain(secret);
    expect(signed).not.toHaveBeenCalled();
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
  "real hc: a null-status session at its steady empty prompt is stopped; one still in its turn, redrawing or reporting busy is not",
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
    const owned = async (
      screen: "idle" | "busy" | "ticking",
      report?: "working",
    ) => {
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
    const refused = refusedBy("terminal_busy", "terminal_not_idle");
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
      // Still redrawing above an idle-looking prompt: two reads differ, kept.
      const drawing = await owned("ticking");
      expect(await drawing.stop()).toEqual(refused);
      expect((await drawing.record()).state).toBe("live");
      process.kill(drawing.enrolled.pid, 0);
      // Back at its own empty prompt: signed, TERM to the direct child only.
      const before = await quiet.record();
      expect(before.foreground.pid).toBe(before.pid);
      // C-849: hc names the owner, not the CLI, as the foreground. Only a
      // macOS launch lets the terminal's own program stand for the CLI; its
      // empty editor still has to be on screen (a running turn is not).
      const raw = { exec: (args: readonly string[]) => hc(...args) };
      const shown = (s: typeof quiet, launcher?: boolean) =>
        boundPrompt(
          raw,
          {
            machine_id: "local",
            runtime_machine: "local",
            terminal_ref: s.terminal,
            agent_name: s.config.agent_name,
            launch_generation: { run_id: "R-1" as never, generation },
          },
          {
            project_id: "fixture",
            assignment_id: "A-1",
            harness: "claude-code",
          },
          launcher,
        );
      expect(await shown(quiet)).toBe(false);
      expect(await shown(quiet, true)).toBe("unknown");
      expect(await shown(running, true)).toBe(false);
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
      for (const s of [running, drawing, working]) await hc("kill", s.terminal);
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
