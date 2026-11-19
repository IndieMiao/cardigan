import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type CliIo, startAssignment } from "@cardigan/cli";
import {
  type Assignment,
  acknowledgeRun,
  assign,
  dispatchRun,
  postComment,
  queueRun,
  type Runtime,
  type RuntimeLaunch,
  releaseAssignment,
  replaceVerificationWorkItem,
  submitReview,
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
  prepareRoleWorktree,
  worktreeBaselinePrompt,
} from "@cardigan/host";
import { defaultRoleDefinition, parseLaunchConfig } from "@cardigan/roles";
import { executionPaths } from "@cardigan/runtime-herdr";
import { writeRole } from "@cardigan/store";
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
    const status = vi.spyOn(runtime, "status").mockResolvedValue({
      ok: true,
      value: { process: "alive", agent: "working", observed_seq: 2 },
    });
    await dispatcher.tick(f.project_id);
    expect(prepare).not.toHaveBeenCalled();
    expect(runtime.wake).not.toHaveBeenCalled();
    expect(git(path, "rev-parse", "HEAD")).toBe(sha);
    f.endRun(s.reviewer);
    status.mockRestore();
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

// Exercise the host with the same persisted proposal/assignment transitions as a Git card.
async function replaceDuringPlan(proposeFirst: boolean) {
  f.store.uow.run((tx) => {
    for (const id of ["coder", "reviewer"] as const) {
      const role = defaultRoleDefinition(id, {
        harness: "pi",
        launch_profile_ref: "fixture",
      });
      writeRole(
        tx,
        f.project_id,
        { ...role, version: 2, core_prompt: role.core_prompt ?? "Fixture" },
        { mode: "update" },
      );
    }
  });
  const card = m4Scenario(f);
  f.store.uow.run((tx) =>
    tx.cards.put(f.project_id, { ...card.card, flow_version: 5 }),
  );
  const deliver = (head: string, verifier = card.codeReview) =>
    f.deliver(card.coder, card.development.id, {
      subject: head,
      verifiers: [verifier.id],
    });
  for (let i = 1; i <= 3; i++) {
    f.startRun(card.coder);
    // These rejected SHAs deliberately do not exist in the Git fixture.
    const candidate = await deliver(String(i).repeat(40));
    f.endRun(card.coder);
    f.startRun(card.reviewer);
    f.apply(
      (s, a, p) =>
        submitReview(
          s,
          a,
          {
            delivery_id: candidate.id,
            target_sha: candidate.subject.value,
            kind: "code",
            rejection_category: "并发时序",
            issues: [
              {
                severity: "major",
                must_fix: true,
                pre_existing: false,
                impact: "functional",
                description: "旧快照写回",
                proof: "旧数据覆盖新数据",
              },
            ],
          },
          p,
        ),
      f.actorFor(card.reviewer),
    );
    if (
      f
        .state()
        .runs.some(
          (r) => r.assignment_id === card.reviewer.id && r.status === "running",
        )
    )
      f.endRun(card.reviewer);
  }
  const q = f
    .state()
    .decisions.find(
      (q) => q.card_id === card.card.id && q.trigger === "review_limit",
    );
  if (!q) throw new Error("Missing intervention");
  f.decide(q, "change_approach");
  const propose = () =>
    f.apply(
      (s, a, p) =>
        postComment(
          s,
          a,
          {
            card_id: card.card.id,
            body: "写入前核对版本",
            review_plan: { decision_id: q.id, step: "propose" },
          },
          p,
        ),
      f.actorFor(card.coder),
    );
  const early = proposeFirst ? propose() : undefined;
  // Consume the resumed Run before retiring the reviewer.
  const resumed = f
    .state()
    .runs.find(
      (r) => r.assignment_id === card.reviewer.id && r.status === "queued",
    );
  if (!resumed) throw new Error("Missing resumed Run");
  f.apply((s, a, p) => dispatchRun(s, a, { run_id: resumed.id }, p));
  f.apply(
    (s, a, p) => acknowledgeRun(s, a, { run_id: resumed.id }, p),
    f.actorFor(card.reviewer),
  );
  f.endRun(card.reviewer);
  f.apply((s, a, p) =>
    releaseAssignment(s, a, { assignment_id: card.reviewer.id }, p),
  );
  const next = f.apply((s, a, p) =>
    replaceVerificationWorkItem(
      s,
      a,
      {
        card_id: card.card.id,
        work_item_id: card.codeReview.id,
        template_key: "code_review",
        reason: "继续确认方案",
      },
      p,
    ),
  );
  const owner = f.apply((s, a, p) =>
    assign(s, a, { work_item_id: next.id, role_id: next.role_id }, p),
  );
  const placement = {
    ...host(),
    execution: { mode: "local" as const, dataDir: f.dataDir },
  };
  const prepare = () => prepareRoleWorktree(placement, f.project_id, owner.id);
  const wake = () => prepareReadonlyWorktree(placement, f.project_id, owner.id);
  if (!proposeFirst)
    await expect(prepare()).rejects.toThrow("No current Git delivery");
  const proposal = early ?? propose();
  if (!proposal) throw new Error("Missing proposal");
  const confirm = () =>
    f.apply(
      (s, a, p) =>
        postComment(
          s,
          a,
          {
            card_id: card.card.id,
            body: "确认方向",
            reply_to: proposal.id,
            review_plan: { decision_id: q.id, step: "confirm" },
          },
          p,
        ),
      f.actorFor(owner),
    );
  return { card, owner, next, q, prepare, wake, confirm, deliver };
}

test.each([true, false])(
  "replacement prepares a plan-only baseline for start and wake (propose first: %s)",
  async (before) => {
    const { card, owner, next, q, prepare, wake, confirm, deliver } =
      await replaceDuringPlan(before);
    const rejected = f
      .state()
      .deliveries.filter((d) => d.work_item_id === card.development.id);
    expect(rejected).toHaveLength(3);
    expect(rejected.every((d) => d.status === "superseded")).toBe(true);
    const buildPath = service.buildPath(f.project_id, owner.id);
    for (const place of [prepare, wake]) {
      const result = await place();
      if (!result) throw new Error("Missing plan checkout");
      expect(result.review_plan).toBe(q.id);
      expect(worktreeBaselinePrompt(result)).toContain("不是待审交付");
      expect(git(result.path, "rev-parse", "HEAD")).toBe(sha);
      expect(git(result.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
        "HEAD",
      );
      expect(result.build).toBeUndefined();
      expect(existsSync(buildPath)).toBe(false);
    }
    f.startRun(card.coder);
    await expect(deliver(sha, next)).rejects.toThrow(q.id);
    f.startRun(owner);
    confirm();
    await expect(wake()).rejects.toThrow("No current Git delivery");
    const old = rejected.at(-1);
    if (!old) throw new Error("Missing withdrawn target");
    expect(() => f.review(owner, old)).toThrow();
    f.endRun(owner);
    // The real next delivery must refresh that same directory and create the build checkout.
    git(source, "commit", "--allow-empty", "-qm", "reworked");
    const newSha = git(source, "rev-parse", "HEAD");
    await new CentralRepositoryService(
      new CentralGitTransport({ dataDir: f.dataDir }),
      { dataDir: f.dataDir },
    ).syncFromSource({
      project_id: f.project_id,
      source_repo: source,
      base_branch: "main",
    });
    const product = await deliver(newSha, next);
    const result = await wake();
    if (!result?.build) throw new Error("Missing delivery checkout");
    expect(result.review_plan).toBeUndefined();
    expect(git(result.path, "rev-parse", "HEAD")).toBe(newSha);
    expect(git(result.build.path, "rev-parse", "HEAD")).toBe(newSha);
    f.startRun(owner);
    expect(f.review(owner, product).verdict).toBe("pass");
  },
);

test("substitute readonly reviewer launches and wakes for the proposal without a reviewable delivery", async () => {
  const { owner, q } = await replaceDuringPlan(true);
  const queue = () =>
    f.apply((s, a, p) =>
      queueRun(
        s,
        a,
        {
          assignment_id: owner.id,
          model: "fixture-model",
          agent_cli_version: "pi fixture",
        },
        p,
      ),
    );
  const run = queue();
  await startQueuedRun(host(), {
    project: f.project_id,
    assignment: owner,
    run,
    bell: "确认方案",
  });
  const path = launched[0]?.cwd;
  if (!path) throw new Error("No launch directory");
  expect(git(path, "rev-parse", "HEAD")).toBe(sha);
  f.apply(
    (s, a, p) => acknowledgeRun(s, a, { run_id: run.id }, p),
    f.actorFor(owner),
  );
  f.endRun(owner);
  await launchRun(host(), {
    project: f.project_id,
    assignment_id: owner.id,
    actor: f.human,
    run: queue(),
    reuse_session: true,
    first_prompt: "核对最新方案",
  });
  expect(runtime.wake).toHaveBeenCalledWith(
    expect.anything(),
    expect.stringContaining(`只确认 ${q.id}`),
    expect.anything(),
  );
  expect(launched).toHaveLength(1);
});
