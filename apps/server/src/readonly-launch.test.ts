import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type CliIo, startAssignment } from "@cardigan/cli";
import {
  type Assignment,
  acknowledgeRun,
  queueRun,
  type Runtime,
  type RuntimeLaunch,
  type RuntimeRef,
} from "@cardigan/domain";
import {
  CentralRepositoryService,
  GitWorktreeService,
} from "@cardigan/git-service";
import {
  CentralGitTransport,
  LocalGitTransport,
} from "@cardigan/git-transport";
import {
  launchRun,
  prepareReadonlyWorktree,
  withPreparationRetry,
  worktreeProvider,
} from "@cardigan/host";
import { parseLaunchConfig } from "@cardigan/roles";
import { executionPaths } from "@cardigan/runtime-herdr";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Dispatcher } from "./dispatch.js";
import { startQueuedRun } from "./host-start.js";
import { m4Fixture, m4Scenario } from "./m4-fixtures.js";

const TEST_PLAIN_SUMMARY = {
  changed: "测试用的改动说明",
  impact: "测试用的影响说明",
  risk: "无",
};

let f: ReturnType<typeof m4Fixture>, s: ReturnType<typeof m4Scenario>;
let source: string, sha: string, service: GitWorktreeService, runtime: Runtime;
const git = (path: string, ...args: string[]) =>
  execFileSync(
    "git",
    [
      "-C",
      path,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      ...args,
    ],
    { encoding: "utf8" },
  ).trim();
const launch = {
  config: parseLaunchConfig({
    profiles: { fixture: { harness: "pi", model: "fixture-model" } },
  }),
  secrets: {},
};
const launched: RuntimeLaunch[] = [];
const ok = <T>(value: T) => ({ ok: true as const, value });
beforeEach(async () => {
  f = m4Fixture({ reviewer_worktree: "readonly", pm_worktree: "readonly" });
  s = m4Scenario(f);
  source = join(f.dataDir, "source");
  mkdirSync(source);
  git(source, "init", "-qb", "main");
  writeFileSync(join(source, "version"), "one");
  git(source, "add", ".");
  git(source, "commit", "-qm", "one");
  sha = git(source, "rev-parse", "HEAD");
  f.store.setProjectRepo({ project_id: f.project_id, repo_path: source });
  service = new GitWorktreeService(
    new LocalGitTransport(),
    new CentralRepositoryService(
      new CentralGitTransport({ dataDir: f.dataDir }),
      { dataDir: f.dataDir },
    ),
    { dataDir: f.dataDir },
  );
  f.startRun(s.coder);
  await f.deliver(s.coder, s.development.id, {
    subject: sha,
    verifiers: [s.codeReview.id],
  });
  f.endRun(s.coder);
  launched.length = 0;
  runtime = {
    verifyExit: async (ref) => ({ ok: true, value: { ref, state: "exited" } }),
    provision: vi.fn(async (_a, _r, _m, desc) => {
      launched.push(desc);
      return ok({
        machine_id: "local",
        runtime_machine: "local",
        terminal_ref: "t-review",
        agent_name: desc.agent_name,
      });
    }),
    status: async () =>
      ok({ process: "alive", agent: "idle", observed_seq: 1 }),
    wake: vi.fn(async () => ok({ sent: true })),
    release: async () => ok(undefined),
    interrupt: async () => ok(undefined),
    human_entry: async () => ok("attach"),
    resume_or_replace: async () => ({
      ok: false,
      error: { code: "runtime_unavailable", message: "unused" },
    }),
  };
});
afterEach(() => f.close());
const host = () => ({
  store: f.store,
  runtime,
  launch,
  mcpUrl: "http://localhost/mcp",
  dataDir: f.dataDir,
});
const current = () =>
  f.state().assignments.find((a) => a.id === s.reviewer.id) ?? s.reviewer;

const queueReviewer = () =>
  f.apply((state, actor, ports) =>
    queueRun(
      state,
      actor,
      {
        assignment_id: s.reviewer.id,
        model: "fixture-model",
        agent_cli_version: "pi fixture",
      },
      ports,
    ),
  );

async function previousReview() {
  const run = queueReviewer();
  await startQueuedRun(host(), {
    project: f.project_id,
    assignment: s.reviewer,
    run,
    bell: "first review",
  });
  f.apply(
    (state, actor, ports) =>
      acknowledgeRun(state, actor, { run_id: run.id }, ports),
    f.actorFor(s.reviewer),
  );
  f.endRun(s.reviewer);
  const build = join(f.dataDir, "agent", "builds", f.project_id, s.reviewer.id);
  const marker = join(build, "previous-run-evidence");
  writeFileSync(marker, "retain until complete scope exit proof");
  return { run, build, marker };
}

test.each(["cli-reuse", "cli-start", "dispatcher"])(
  "IR-1 %s retains an occupied build when a completed Run has a detached process",
  async (entry) => {
    const { build, marker } = await previousReview();
    const original = statSync(build);
    const detached = spawn("/bin/sleep", ["60"], {
      cwd: build,
      detached: true,
      stdio: "ignore",
      env: { PATH: "/usr/bin:/bin" },
    });
    await once(detached, "spawn");
    try {
      const ref = current().runtime_ref;
      const verify = vi.fn(async (scope: RuntimeRef) =>
        ok({ ref: scope, state: "unknown" as const }),
      );
      runtime.verifyExit = verify;
      const run = queueReviewer();
      if (entry === "cli-reuse") {
        await expect(
          launchRun(host(), {
            project: f.project_id,
            assignment_id: s.reviewer.id,
            run,
            actor: { kind: "system", project_id: f.project_id },
            first_prompt: "next review",
            reuse_session: true,
          }),
        ).rejects.toThrow(/exit is unconfirmed/);
      } else if (entry === "cli-start") {
        await expect(
          startAssignment({
            ...host(),
            project_id: f.project_id,
            assignment_id: s.reviewer.id,
            io: {
              env: { CARDIGAN_RUNTIME_MODE: "local" },
              cwd: f.dataDir,
              platform: "linux",
              stdout() {},
              stderr() {},
              signals: { on() {}, off() {} },
              spawnInherit: async () => 0,
              captureCommand: async () => ({
                code: 0,
                stdout: "pi fixture",
                stderr: "",
              }),
            },
            worktree: worktreeProvider(
              { mode: "local", dataDir: f.dataDir },
              runtime,
              f.store,
            ),
          }),
        ).rejects.toThrow(/exit is unconfirmed/);
      } else {
        const prepare = vi.fn(async ({ project, assignment }) => {
          await withPreparationRetry(() =>
            prepareReadonlyWorktree(
              { ...host(), execution: { mode: "local", dataDir: f.dataDir } },
              project,
              assignment.id,
            ),
          );
        });
        await new Dispatcher({
          store: f.store,
          runtime,
          standing: () => undefined,
          snapshot: async () => ({
            model: "fixture-model",
            agent_cli_version: "pi fixture",
          }),
          startRun: async () => {
            throw new Error("Must reuse reviewer session");
          },
          beforeWake: prepare,
        }).tick(f.project_id);
        expect(prepare).toHaveBeenCalledOnce();
      }
      expect(verify).toHaveBeenCalledWith(ref);
      expect(runtime.wake).not.toHaveBeenCalled();
      expect(existsSync(marker)).toBe(true);
      expect(statSync(build).ino).toBe(original.ino);
      expect(statSync(build).dev).toBe(original.dev);
      expect(
        git(
          join(f.dataDir, "agent", "repos", f.project_id),
          "worktree",
          "list",
          "--porcelain",
        ),
      ).toContain(`worktree ${build}\n`);
      expect(current().runtime_ref).toEqual(ref);
      expect(f.state().runs.find((r) => r.id === run.id)?.status).toBe(
        "queued",
      );
      expect(detached.exitCode).toBeNull();
      if (process.platform === "linux")
        expect(readlinkSync(`/proc/${detached.pid}/cwd`)).toBe(build);
      expect(
        f
          .state()
          .human_actions.some((h) => h.instructions.includes("进程退出核实")),
      ).toBe(true);
    } finally {
      const closed = once(detached, "close");
      detached.kill("SIGTERM");
      await closed;
    }
  },
);

test.each([
  "alive",
  "missing",
  "wrong-scope",
  "run-changed",
  "directory-changed",
])(
  "IR-1 rejects build replacement when exit evidence is %s",
  async (caseName) => {
    const { run: previous, build, marker } = await previousReview();
    let calls = 0;
    runtime.verifyExit = async (ref) => {
      calls++;
      if (caseName === "run-changed")
        f.store.uow.run((tx) => {
          const run = tx.runs.get(f.project_id, previous.id);
          if (run)
            tx.runs.put(f.project_id, {
              ...run,
              summary: "changed while proving exit",
            });
        });
      if (caseName === "directory-changed" && calls === 2) {
        renameSync(build, `${build}-original`);
        mkdirSync(build);
        writeFileSync(marker, "different instance");
      }
      return ok({
        ref:
          caseName === "wrong-scope"
            ? { ...ref, terminal_ref: "different-launch" }
            : ref,
        state: caseName === "alive" ? "alive" : "exited",
      });
    };
    if (caseName === "missing") delete runtime.verifyExit;
    const run = queueReviewer();
    await expect(
      launchRun(host(), {
        project: f.project_id,
        assignment_id: s.reviewer.id,
        run,
        actor: { kind: "system", project_id: f.project_id },
        first_prompt: "next review",
        reuse_session: true,
      }),
    ).rejects.toThrow(/unconfirmed|directory changed/);
    expect(existsSync(marker)).toBe(true);
    expect(runtime.wake).not.toHaveBeenCalled();
    if (caseName === "directory-changed")
      expect(
        readFileSync(
          join(`${build}-original`, "previous-run-evidence"),
          "utf8",
        ),
      ).toContain("retain");
  },
);

test.each(["cli", "server"])(
  "S7 %s starts a readonly reviewer at its current delivery SHA",
  async (entry) => {
    if (entry === "cli") {
      const io: CliIo = {
        env: { CARDIGAN_RUNTIME_MODE: "local" },
        cwd: f.dataDir,
        platform: "linux",
        stdout: () => {},
        stderr: () => {},
        signals: { on() {}, off() {} },
        spawnInherit: async () => 0,
        captureCommand: async () => ({
          code: 0,
          stdout: "pi fixture",
          stderr: "",
        }),
      };
      await startAssignment({
        ...host(),
        io,
        project_id: f.project_id,
        assignment_id: s.reviewer.id,
        worktree: async (request) => {
          const placed = await service.ensureWorktree(request);
          return (
            placed && { path: placed.worktree_path, base_sha: placed.base_sha }
          );
        },
      });
    } else {
      const run = f.apply((state, actor, ports) =>
        queueRun(
          state,
          actor,
          {
            assignment_id: s.reviewer.id,
            model: "fixture-model",
            agent_cli_version: "pi fixture",
          },
          ports,
        ),
      );
      await startQueuedRun(host(), {
        project: f.project_id,
        assignment: s.reviewer,
        run,
        bell: "review current delivery",
      });
    }
    const path = join(
      f.dataDir,
      "agent",
      "worktrees",
      f.project_id,
      s.reviewer.id,
    );
    expect(launched[0]?.cwd).toBe(path);
    expect(current().worktree_path).toBe(path);
    expect(git(path, "rev-parse", "HEAD")).toBe(sha);
    expect(readFileSync(join(path, "version"), "utf8")).toBe("one");
    expect(() => git(path, "symbolic-ref", "HEAD")).toThrow();
  },
);

test.each([false, true])(
  "S7 wake refreshes only an idle, clean reviewer (dirty=%s)",
  async (dirty) => {
    const run = f.apply((state, actor, ports) =>
      queueRun(
        state,
        actor,
        {
          assignment_id: s.reviewer.id,
          model: "fixture-model",
          agent_cli_version: "pi fixture",
        },
        ports,
      ),
    );
    await startQueuedRun(host(), {
      project: f.project_id,
      assignment: s.reviewer,
      run,
      bell: "review",
    });
    f.apply(
      (state, actor, ports) =>
        acknowledgeRun(state, actor, { run_id: run.id }, ports),
      f.actorFor(s.reviewer),
    );
    const path = current().worktree_path;
    if (!path) throw new Error("Missing reviewer worktree");
    writeFileSync(join(source, "version"), "two");
    git(source, "add", ".");
    git(source, "commit", "-qm", "two");
    const next = git(source, "rev-parse", "HEAD");
    // The real delivery endpoint normally imports and pins this commit in the center.
    const center = new CentralRepositoryService(
      new CentralGitTransport({ dataDir: f.dataDir }),
      { dataDir: f.dataDir },
    );
    await center.syncFromSource({
      project_id: f.project_id,
      source_repo: source,
      base_branch: "main",
    });
    f.startRun(s.coder);
    await f.deliver(s.coder, s.development.id, {
      subject: next,
      verifiers: [s.codeReview.id],
    });
    f.endRun(s.coder);
    const prepare = vi.fn(async ({ project, assignment }) => {
      await prepareReadonlyWorktree(
        { ...host(), execution: { mode: "local", dataDir: f.dataDir } },
        project,
        assignment.id,
      );
    });
    const dispatcher = new Dispatcher({
      store: f.store,
      runtime,
      standing: () => undefined,
      snapshot: async () => ({
        model: "fixture-model",
        agent_cli_version: "pi fixture",
      }),
      startRun: async () => {
        throw new Error("Must reuse reviewer session");
      },
      beforeWake: prepare,
    });
    await dispatcher.tick(f.project_id);
    expect(prepare).not.toHaveBeenCalled();
    expect(runtime.wake).not.toHaveBeenCalled();
    expect(git(path, "rev-parse", "HEAD")).toBe(sha);
    f.endRun(s.reviewer);
    // S12: untracked test outputs are disposable; tracked edits still block.
    writeFileSync(join(path, "local-notes"), "cache");
    if (dirty) writeFileSync(join(path, "version"), "keep");
    vi.mocked(runtime.wake).mockImplementation(async () => {
      expect(git(path, "rev-parse", "HEAD")).toBe(next);
      return ok({ sent: true });
    });
    await dispatcher.tick(f.project_id);
    expect(prepare).toHaveBeenCalledOnce();
    if (dirty) {
      expect(runtime.wake).not.toHaveBeenCalled();
      expect(git(path, "rev-parse", "HEAD")).toBe(sha);
      expect(readFileSync(join(path, "version"), "utf8")).toBe("keep");
      expect(
        f.store
          .listNotifications({ project_id: f.project_id })
          .some((n) => n.status === "delivery_failed"),
      ).toBe(true);
    } else {
      expect(runtime.wake).toHaveBeenCalledOnce();
      expect(readFileSync(join(path, "local-notes"), "utf8")).toBe("cache");
      expect(readFileSync(join(path, "version"), "utf8")).toBe("two");
    }
  },
);

// -------------------------------------------------- M5.S S6: writer launches

test("M5.S S6 a Dispatcher-started writer gets its worktree and branch", async () => {
  // Before S6 the Dispatcher only ever started readonly reviewers, so the host
  // never prepared a writer's worktree: the coder started with none and could
  // not commit. Assigning over MCP now goes through this exact path.
  const run = f.apply((state, actor, ports) =>
    queueRun(
      state,
      actor,
      {
        assignment_id: s.coder.id,
        model: "fixture-model",
        agent_cli_version: "pi fixture",
      },
      ports,
    ),
  );
  await startQueuedRun(host(), {
    project: f.project_id,
    assignment: s.coder,
    run,
    bell: "assigned",
  });
  const path = join(f.dataDir, "agent", "worktrees", f.project_id, s.coder.id);
  const branch = `agent/${s.card.id}/${s.development.id}`;
  expect(launched[0]?.cwd).toBe(path);
  const coder =
    f.state().assignments.find((entry) => entry.id === s.coder.id) ?? s.coder;
  expect(coder.worktree_path).toBe(path);
  expect(coder.branch).toBe(branch);
  // A real checkout of the central baseline, on the Agent's own branch.
  expect(git(path, "symbolic-ref", "HEAD")).toBe(`refs/heads/${branch}`);
  expect(git(path, "rev-parse", "HEAD")).toBe(sha);
});

// ------------------------------------ M5.S S13: readonly pm and PM acceptance

test("M5.S S13 a standing PM keeps no worktree even when the pm role is readonly", async () => {
  const standing: Assignment = {
    id: "A-90" as never,
    scope: "standing",
    standing_mode: "office",
    role_id: "pm",
    role_version: 1,
    status: "active",
    runtime_state: "not_provisioned",
    machine_id: "local",
    runtime_ref: null,
    mcp_token_id: "pm-office",
    created_at: f.clock.now(),
  };
  f.store.uow.run((tx) => tx.assignments.put(f.project_id, standing));
  const run = f.apply((state, actor, ports) =>
    queueRun(
      state,
      actor,
      {
        assignment_id: standing.id,
        model: "fixture-model",
        agent_cli_version: "pi fixture",
      },
      ports,
    ),
  );
  await startQueuedRun(host(), {
    project: f.project_id,
    assignment: standing,
    run,
    bell: "standing pm",
  });
  const saved = f.state().assignments.find((a) => a.id === standing.id);
  expect(saved?.worktree_path).toBeUndefined();
  const runDirectory = executionPaths(
    { mode: "local", dataDir: f.dataDir },
    f.project_id,
    standing.id,
  ).runDir;
  expect(launched[0]?.cwd).toBe(runDirectory);
  expect(launched[0]?.cwd).not.toContain("worktrees");
});

test("M5.S S13 a work-item PM acceptance reads the completion at its SHA", async () => {
  const product = f.state().deliveries.find((entry) => entry.kind === "code");
  if (product === undefined) throw new Error("Missing product delivery");
  f.startRun(s.reviewer);
  f.review(s.reviewer, product);
  f.endRun(s.reviewer);

  // §4.4: the completion request binds to the current product delivery subject.
  f.startRun(s.coder);
  const completion = await f.deliver(s.coder, s.development.id, {
    kind: "card_completion",
    plain_summary: TEST_PLAIN_SUMMARY,
    subject: sha,
    verifiers: [s.acceptance.id],
  });
  f.endRun(s.coder);
  expect(completion.subject.value).toBe(sha);

  const run = f.apply((state, actor, ports) =>
    queueRun(
      state,
      actor,
      {
        assignment_id: s.pmAcceptance.id,
        model: "fixture-model",
        agent_cli_version: "pi fixture",
      },
      ports,
    ),
  );
  await startQueuedRun(host(), {
    project: f.project_id,
    assignment: s.pmAcceptance,
    run,
    bell: "PM acceptance",
  });
  const path = join(
    f.dataDir,
    "agent",
    "worktrees",
    f.project_id,
    s.pmAcceptance.id,
  );
  expect(launched[0]?.cwd).toBe(path);
  const saved = f.state().assignments.find((a) => a.id === s.pmAcceptance.id);
  expect(saved?.worktree_path).toBe(path);
  expect(git(path, "rev-parse", "HEAD")).toBe(sha);
  expect(readFileSync(join(path, "version"), "utf8")).toBe("one");
  expect(() => git(path, "symbolic-ref", "HEAD")).toThrow();
});
