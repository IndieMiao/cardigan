/**
 * M4.4 release and worktree cleanup (plan §3.6, development plan §12.6).
 *
 * Real Git in temporary repositories and real domain commands: a done card's
 * Assignments are released, their tokens die, the terminal goes back, a clean
 * worktree is removed, a dirty one becomes a decision, and the decision's answer
 * is what the loop executes.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Assignment,
  type Runtime,
  type RuntimeRef,
  releaseAssignment,
} from "@cardigan/domain";
import {
  type CentralProject,
  CentralRepositoryService,
} from "@cardigan/git-service";
import { CentralGitTransport } from "@cardigan/git-transport";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CleanupExecutor } from "./cleanup-loop.js";
import { ServerGit } from "./git.js";
import {
  acceptThroughMergeGate,
  type M4Fixture,
  type M4Scenario,
  m4Fixture,
  m4Scenario,
} from "./m4-fixtures.js";
import { MergeExecutor } from "./merge-loop.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    [
      "-C",
      cwd,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      ...args,
    ],
    { encoding: "utf8" },
  ).trim();

let f: M4Fixture;
let scenario: M4Scenario;
let root: string;
let source: string;
let base: string;
let worktree: string;
let project: CentralProject;
let central: CentralRepositoryService;
const released: RuntimeRef[] = [];
const runtime: Runtime = {
  provision: async () => {
    throw new Error("not used");
  },
  wake: async () => ({ ok: true, value: { sent: true } }),
  status: async () => ({
    ok: true,
    value: { process: "alive", agent: "idle", observed_seq: 1 },
  }),
  interrupt: async () => ({ ok: true, value: undefined }),
  resume_or_replace: async () => {
    throw new Error("not used");
  },
  human_entry: async () => ({ ok: true, value: "fixture" }),
  release: async (ref) => {
    released.push(ref);
    return { ok: true, value: undefined };
  },
};

const commitOn = (cwd: string, name: string, text: string) => {
  writeFileSync(join(cwd, name), text);
  git(cwd, "add", name);
  git(cwd, "commit", "-m", text);
  return git(cwd, "rev-parse", "HEAD");
};

beforeEach(() => {
  f = m4Fixture();
  root = mkdtempSync(join(tmpdir(), "cardigan-cleanup-"));
  source = join(root, "source");
  git(root, "init", "-q", "-b", "main", source);
  commitOn(source, "README.md", "fixture\n");
  f.store.setProjectRepo({
    project_id: f.project_id,
    repo_path: source,
    base_branch: "main",
  });
  project = {
    project_id: f.project_id,
    source_repo: source,
    base_branch: "main",
  };
  central = new CentralRepositoryService(
    new CentralGitTransport({ dataDir: f.dataDir }),
    { dataDir: f.dataDir },
  );
  base = join(f.dataDir, "agent", "repos", f.project_id);
  worktree = join(f.dataDir, "agent", "worktrees", f.project_id, "A-2");
  released.length = 0;
});
afterEach(() => {
  f.close();
  rmSync(root, { recursive: true, force: true });
});

/** Drive the card to done through the merge loop, with a real worktree. */
async function doneCard() {
  scenario = m4Scenario(f, "auto");
  worktree = join(
    f.dataDir,
    "agent",
    "worktrees",
    f.project_id,
    scenario.coder.id,
  );
  // The coder's branch, delivered and pinned into the central repository.
  const agent = join(root, "agent-clone");
  git(root, "clone", "-q", source, agent);
  git(agent, "checkout", "-q", "-b", "agent/C-1/W-1");
  const sha = commitOn(agent, "feature.txt", "feature\n");
  const { product } = await acceptThroughMergeGate(f, scenario, sha, {
    path: worktree,
    branch: "agent/C-1/W-1",
  });
  const repository = await central.ensureCentral(project);
  await central.git.fetchRefs(repository, agent, [`+${sha}:${sha}`]);
  await central.pinDelivery(project, product.id, sha);
  await new MergeExecutor({
    store: f.store,
    git: new ServerGit({ store: f.store, dataDir: f.dataDir }),
  }).tick(f.project_id);
  expect(f.card().status).toBe("done");

  // A real base clone of the central repository with the assignment's worktree.
  mkdirp(join(f.dataDir, "agent", "repos"));
  git(root, "clone", "-q", "--no-local", repository, base);
  mkdirp(join(f.dataDir, "agent", "worktrees", f.project_id));
  git(base, "worktree", "add", "-q", "-b", "agent/C-1/W-1", worktree, sha);
  return { sha };
}
function mkdirp(path: string) {
  execFileSync("mkdir", ["-p", path]);
}

const cleanup = () =>
  new CleanupExecutor({
    store: f.store,
    git: new ServerGit({ store: f.store, dataDir: f.dataDir }),
    runtime,
    clock: f.clock,
    onError: () => undefined,
  });

const assignment = (): Assignment => {
  const found = f
    .state()
    .assignments.find((candidate) => candidate.id === scenario.coder.id);
  if (found === undefined) throw new Error("missing assignment");
  return found;
};

test("a done card releases its Assignments, revokes tokens and removes a clean worktree", async () => {
  const { sha } = await doneCard();
  const token = f.store.issueToken({
    project_id: f.project_id as never,
    assignment_id: scenario.coder.id,
    role: { role_version: 1, allowed_tools: ["submit_delivery"] },
  });
  expect(f.store.verifyToken(token.token)).toBeDefined();
  const worktreePath = assignment().worktree_path as string;
  expect(worktreePath).toBe(worktree);
  expect(existsSync(worktree)).toBe(true);

  await cleanup().tick(f.project_id);

  const after = assignment();
  expect(after.status).toBe("released");
  expect(after.runtime_state).toBe("released");
  expect(f.store.verifyToken(token.token)).toBeUndefined();
  expect(released.map((ref) => ref.terminal_ref)).toContain(`t-${after.id}`);
  expect(existsSync(worktree)).toBe(false);
  // The branch went with it; the commit survives in the central repository.
  expect(git(base, "for-each-ref", "refs/heads/agent")).toBe("");
  expect(
    await new CentralRepositoryService(
      new CentralGitTransport({ dataDir: f.dataDir }),
      { dataDir: f.dataDir },
    ).hasCommit(project, sha),
  ).toBe(true);
});

test("a dirty worktree asks the human and is not deleted", async () => {
  await doneCard();
  writeFileSync(join(worktree, "local-notes.txt"), "unsaved\n");
  await cleanup().tick(f.project_id);
  await cleanup().tick(f.project_id);

  const decisions = f
    .state()
    .decisions.filter((decision) => decision.trigger === "worktree_cleanup");
  expect(decisions).toHaveLength(1);
  expect(decisions[0]).toMatchObject({
    status: "open",
    decider: "human",
    blocking: false,
  });
  expect(decisions[0]?.context).toContain("untracked=1");
  expect(existsSync(worktree)).toBe(true);
  expect(assignment().status).toBe("released");
});

test("force_clean backs up a patch and then removes the worktree", async () => {
  await doneCard();
  writeFileSync(join(worktree, "local-notes.txt"), "unsaved\n");
  await cleanup().tick(f.project_id);
  const decision = f
    .state()
    .decisions.find((candidate) => candidate.trigger === "worktree_cleanup");
  expect(decision).toBeDefined();
  f.decide(decision as never, "force_clean");
  await cleanup().tick(f.project_id);

  expect(existsSync(worktree)).toBe(false);
  const patches = readdirSync(join(f.dataDir, "cleanup", f.project_id));
  expect(patches).toHaveLength(1);
  expect(patches[0]).toMatch(/^A-\d+-.*\.patch$/u);
});

test("keep leaves the worktree in place and stops asking", async () => {
  await doneCard();
  writeFileSync(join(worktree, "local-notes.txt"), "unsaved\n");
  await cleanup().tick(f.project_id);
  const decision = f
    .state()
    .decisions.find((candidate) => candidate.trigger === "worktree_cleanup");
  f.decide(decision as never, "keep");
  await cleanup().tick(f.project_id);
  await cleanup().tick(f.project_id);

  expect(existsSync(worktree)).toBe(true);
  expect(
    f
      .state()
      .decisions.filter(
        (candidate) => candidate.trigger === "worktree_cleanup",
      ),
  ).toHaveLength(1);
});

test("an unfinished card keeps its Assignments", async () => {
  scenario = m4Scenario(f, "auto");
  f.startRun(scenario.coder);
  await cleanup().tick(f.project_id);
  expect(assignment().status).toBe("active");
  expect(released).toEqual([]);
});

test("S17 releases every terminal and token, including PM acceptance without a worktree", async () => {
  await doneCard();
  const all = f.state().assignments.filter((a) => a.runtime_ref);
  const tokens = all.map(
    (a) =>
      f.store.issueToken({
        project_id: f.project_id,
        assignment_id: a.id,
        role: { role_version: 1, allowed_tools: [] },
      }).token,
  );
  await cleanup().tick(f.project_id);
  expect(released.map((r) => r.terminal_ref).sort()).toEqual(
    all.map((a) => a.runtime_ref?.terminal_ref).sort(),
  );
  for (const token of tokens)
    expect(f.store.verifyToken(token)).toBeUndefined();
});

test("S17 sweeps an already released terminal even in a project with no repository", async () => {
  const noGit = m4Fixture();
  try {
    const s = m4Scenario(noGit);
    noGit.startRun(s.pmAcceptance);
    noGit.endRun(s.pmAcceptance);
    noGit.apply((state, actor, ports) =>
      releaseAssignment(
        state,
        actor,
        { assignment_id: s.pmAcceptance.id },
        ports,
      ),
    );
    const closed = vi.fn(runtime.release);
    const executor = new CleanupExecutor({
      store: noGit.store,
      git: new ServerGit({ store: noGit.store, dataDir: noGit.dataDir }),
      runtime: { ...runtime, release: closed },
    });
    await executor.tick();
    await executor.tick();
    // The fake runtime still reports alive: a prior success must not suppress repair.
    expect(closed).toHaveBeenCalledTimes(2);
    expect(closed).toHaveBeenLastCalledWith(
      expect.objectContaining({ terminal_ref: `t-${s.pmAcceptance.id}` }),
      { force: true },
    );
  } finally {
    noGit.close();
  }
});

test.each(["result", "throw"])(
  "S17 retries a failed terminal release (%s) before deleting its worktree",
  async (mode) => {
    await doneCard();
    const ref = assignment().runtime_ref;
    let attempts = 0;
    const release = vi.fn(
      async (r: RuntimeRef, options: { readonly force: boolean }) => {
        expect(options.force).toBe(true);
        if (r.terminal_ref === ref?.terminal_ref && ++attempts === 1) {
          if (mode === "throw") throw new Error("transient transport failure");
          return {
            ok: false as const,
            error: { code: "runtime_unavailable" as const, message: "retry" },
          };
        }
        return { ok: true as const, value: undefined };
      },
    );
    const report = vi.fn();
    const executor = new CleanupExecutor({
      store: f.store,
      git: new ServerGit({ store: f.store, dataDir: f.dataDir }),
      runtime: { ...runtime, release },
      report,
    });
    await executor.tick();
    expect(existsSync(worktree)).toBe(true);
    expect(report).toHaveBeenCalled();
    await executor.tick();
    expect(attempts).toBe(2);
    expect(existsSync(worktree)).toBe(false);
  },
);
