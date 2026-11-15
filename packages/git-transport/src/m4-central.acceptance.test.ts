/**
 * M4.T1 cross-acceptance for M4.2 (central repository, source sync, delivery
 * verification, pinning, backups; #88/#89).
 *
 * Oracles: docs/plans/phase-1-m4.md §3.1–§3.4, §3.7, §4 (M4.2), the M4
 * acceptance in development plan §16 ("a forged or off-branch SHA is
 * rejected") and §12.1–§12.3, §14. Only public packages are used:
 * `CentralRepositoryService`, `GitDeliveryVerifier`, `GitWorktreeService`,
 * `CentralGitTransport` and `LocalGitTransport`. Every Git operation is real;
 * the agent-ssh case injects a fake Agent upload-pack entry that records its
 * calls and asserts the host never runs Git inside the Agent workspace.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  Assignment,
  Card,
  DeliverySubject,
  Role,
  WorkItem,
} from "@cardigan/domain";
import {
  type CentralProject,
  CentralRepositoryService,
  GitDeliveryVerifier,
  GitWorktreeService,
} from "@cardigan/git-service";
import { afterEach, beforeEach, expect, test } from "vitest";
import { CentralGitTransport, LocalGitTransport } from "./index.js";

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (
    await exec(
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
      { timeout: 15000 },
    )
  ).stdout.trim();
const commit = async (cwd: string, body: string) => {
  await writeFile(join(cwd, "tracked.txt"), body);
  await git(cwd, "add", "-A");
  await git(cwd, "commit", "-m", body);
  return git(cwd, "rev-parse", "HEAD");
};

interface Fixture {
  readonly root: string;
  readonly source: string;
  readonly dataDir: string;
  readonly agentRoot: string;
  readonly project: CentralProject;
  readonly repo: string;
  readonly base: string;
  readonly work: string;
  readonly initial: string;
  readonly assignment: Assignment;
  readonly central: CentralRepositoryService;
  readonly local: LocalGitTransport;
  readonly verifier: GitDeliveryVerifier;
  /** Host Git invocations, as the central transport observed them. */
  readonly calls: { cwd: string; args: readonly string[] }[];
  /** Agent upload-pack entries the host asked for (agent-ssh only). */
  readonly agentCalls: string[];
  close(): Promise<void>;
}

async function fixture(options: { agent?: boolean } = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "cardigan-m4t1-git-")),
    source = join(root, "source"),
    dataDir = join(root, "data"),
    agentRoot = join(root, "agent"),
    calls: { cwd: string; args: readonly string[] }[] = [],
    agentCalls: string[] = [];
  if (options.agent) await mkdir(agentRoot, { recursive: true, mode: 0o750 });
  await git(root, "init", "-b", "main", source);
  const initial = await commit(source, "initial");
  const transport = new CentralGitTransport({
    dataDir,
    ...(options.agent ? { agentRoot } : {}),
    onCommand: (cwd, args) => calls.push({ cwd, args }),
  });
  const central = new CentralRepositoryService(transport, {
    dataDir,
    ...(options.agent
      ? {
          repositoriesRoot: join(agentRoot, "repos"),
          uploadPack: async (repository: string) => {
            agentCalls.push(repository);
            return "git-upload-pack";
          },
        }
      : {}),
  });
  const project: CentralProject = {
      project_id: "p-m4t1",
      source_repo: source,
      base_branch: "main",
    },
    repo = await central.ensureCentral(project),
    local = new LocalGitTransport(),
    base = options.agent
      ? join(agentRoot, "repos", project.project_id)
      : join(dataDir, "agent", "repos", project.project_id),
    work = options.agent
      ? join(agentRoot, "worktrees", project.project_id, "A-1")
      : join(dataDir, "agent", "worktrees", project.project_id, "A-1");
  await local.ensureClone(repo, base);
  await local.addWorktree(base, work, initial, "agent/C-1/W-1");
  const assignment = {
    id: "A-1",
    scope: "work_item",
    work_item_id: "W-1",
    role_id: "coder",
    role_version: 1,
    status: "active",
    runtime_state: "not_provisioned",
    runtime_ref: null,
    machine_id: "local",
    mcp_token_id: "reserved",
    created_at: "2030-01-01T00:00:00.000Z",
    branch: "agent/C-1/W-1",
    worktree_path: work,
    base_sha: initial,
  } as unknown as Assignment;
  return {
    root,
    source,
    dataDir,
    agentRoot,
    project,
    repo,
    base,
    work,
    initial,
    assignment,
    central,
    local,
    verifier: new GitDeliveryVerifier(central, project),
    calls,
    agentCalls,
    close: () => rm(root, { recursive: true, force: true }),
  };
}

let f: Fixture;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.close();
});

const refs = async (prefix: string, fixture_ = f) =>
  git(
    fixture_.repo,
    "for-each-ref",
    "--format=%(refname)",
    `refs/cardigan/${prefix}`,
  ).then((value) => value.split("\n").filter(Boolean));
const verify = (
  value: string,
  fixture_ = f,
  subject_kind: "git_head" | "doc_version" = "git_head",
) =>
  fixture_.verifier.verify(
    { kind: subject_kind, value } as DeliverySubject,
    fixture_.assignment,
  );
const fineSha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;

// ------------------------------------------------------------- M4.2 §3.3 ---

test("§16/§3.3 a forged, non-commit, off-branch, abbreviated or uppercase SHA is rejected without candidate or delivery refs", async () => {
  const own = await commit(f.work, "delivered");
  const tree = await git(f.work, "rev-parse", `HEAD^{tree}`);
  const blob = await git(f.work, "rev-parse", "HEAD:tracked.txt");
  await git(f.work, "tag", "-a", "annotated", "-m", "annotated tag");
  const tag = await git(f.work, "rev-parse", "refs/tags/annotated");
  // A commit on another Assignment's branch, reachable in the center like a backup.
  const other = join(
    f.dataDir,
    "agent",
    "worktrees",
    f.project.project_id,
    "A-2",
  );
  await f.local.addWorktree(f.base, other, f.initial, "agent/C-2/W-2");
  const foreign = await commit(other, "another assignment");
  await f.central.backupAgentBranches(f.project, "local");
  await f.central.git.fetchRefs(f.repo, other, [
    `refs/tags/annotated:refs/tags/annotated`,
  ]);
  expect(fineSha.test(tag)).toBe(true);

  const cases: [string, string, RegExp][] = [
    ["missing", "0".repeat(40), /not a commit/],
    ["tree", tree, /not a commit/],
    ["blob", blob, /not a commit/],
    ["annotated tag", tag, /not a commit/],
    ["other branch", foreign, /not on the recorded Assignment branch/],
    ["abbreviated", own.slice(0, 10), /full lowercase hexadecimal/],
    ["uppercase", own.toUpperCase(), /full lowercase hexadecimal/],
  ];
  for (const [name, value, message] of cases) {
    const result = await verify(value);
    expect(result.ok, name).toBe(false);
    if (!result.ok) expect(result.error.message, name).toMatch(message);
    expect(await refs("candidates"), name).toEqual([]);
    expect(await refs("deliveries"), name).toEqual([]);
  }
  // An Assignment without the recorded writing metadata is refused before Git.
  for (const broken of [
    { ...f.assignment, branch: undefined },
    { ...f.assignment, worktree_path: undefined },
    { ...f.assignment, branch: "main:refs/heads/evil" },
  ]) {
    const result = await f.verifier.verify(
      { kind: "git_head", value: own },
      broken as Assignment,
    );
    expect(result.ok).toBe(false);
  }
  expect(await refs("candidates")).toEqual([]);

  // Sanity: the same verifier accepts the recorded branch's own commit.
  const accepted = await verify(own);
  expect(accepted.ok).toBe(true);
  if (!accepted.ok) throw new Error(accepted.error.message);
  expect(accepted.value.map((e) => e.kind)).toEqual(["diff", "commit"]);
  expect(accepted.value.find((e) => e.kind === "commit")?.details).toEqual({
    sha: own,
    branch: "agent/C-1/W-1",
    base_sha: f.initial,
    commits_ahead: 1,
  });
  expect(
    accepted.value.find((e) => e.kind === "diff")?.details.role_rule_inventory,
  ).toMatchObject({
    version: 1,
    complete: true,
    base_sha: f.initial,
    sha: own,
    changes: [{ path: "tracked.txt", category: "ordinary" }],
  });
  expect(await refs("candidates")).toEqual([
    `refs/cardigan/candidates/A-1/${own}`,
  ]);
  // The registered source is never written.
  expect(await git(f.source, "rev-parse", "main")).toBe(f.initial);
  expect(await git(f.source, "show-ref")).not.toContain(other);
});

test("§3.3 non-Git subjects skip Git entirely and an existing delivery ref is never overwritten", async () => {
  const before = f.calls.length;
  expect(await verify("doc-v1", f, "doc_version")).toEqual({
    ok: true,
    value: [],
  });
  expect(f.calls).toHaveLength(before);

  const first = await commit(f.work, "first delivery");
  const second = await commit(f.work, "second delivery");
  expect((await verify(first)).ok).toBe(true);
  await f.central.pinDelivery(f.project, "D-1", first);
  // Create-only: a different SHA is refused, the same SHA is idempotent.
  await expect(f.central.pinDelivery(f.project, "D-1", second)).rejects.toThrow(
    /different SHA/,
  );
  await expect(
    f.central.pinDelivery(f.project, "D-1", first),
  ).resolves.toBeUndefined();
  expect(
    await f.central.git.readRef(f.repo, "refs/cardigan/deliveries/D-1"),
  ).toBe(first);
  await expect(
    f.central.pinDelivery(f.project, "not-a-delivery", first),
  ).rejects.toThrow();
});

// ------------------------------------------------------------- M4.2 §3.2 ---

test("§3.2 source synchronization reports all four outcomes and never moves either side on divergence", async () => {
  expect(await f.central.syncFromSource(f.project)).toBe("up_to_date");
  const forward = await commit(f.source, "source forward");
  expect(await f.central.syncFromSource(f.project)).toBe("fast_forwarded");
  expect(await git(f.repo, "rev-parse", "refs/heads/main")).toBe(forward);
  // The source is behind the center: the center stays put (the user has not
  // fetched the merge result back yet).
  await git(f.source, "reset", "--hard", f.initial);
  expect(await f.central.syncFromSource(f.project)).toBe("ahead");
  expect(await git(f.repo, "rev-parse", "refs/heads/main")).toBe(forward);
  // Divergence: both sides moved independently.
  const centralChild = await commit(f.work, "central side");
  await f.central.git.fetchRefs(f.repo, f.work, [
    `+refs/heads/agent/C-1/W-1:refs/heads/main`,
  ]);
  const sourceChild = await commit(f.source, "source side");
  expect(await f.central.syncFromSource(f.project)).toBe("diverged");
  expect(await git(f.repo, "rev-parse", "refs/heads/main")).toBe(centralChild);
  expect(await git(f.source, "rev-parse", "main")).toBe(sourceChild);
  expect(await git(f.repo, "rev-parse", "refs/cardigan/source/main")).toBe(
    sourceChild,
  );
});

test("§3.2 a diverged source still creates a new worktree from the central baseline and reports diverged", async () => {
  const service = new GitWorktreeService(f.local, f.central, {
    dataDir: f.dataDir,
  });
  const centralChild = await commit(f.work, "merged central baseline");
  await f.central.git.fetchRefs(f.repo, f.work, [
    `+refs/heads/agent/C-1/W-1:refs/heads/main`,
  ]);
  const sourceChild = await commit(f.source, "unmerged source work");
  const card: Card = {
    id: "C-2" as never,
    project_id: f.project.project_id,
    title: "Fixture",
    goal: "Fixture",
    acceptance_criteria: [],
    source: { kind: "quote", text: "fixture" },
    out_of_scope: [],
    related_cards: [],
    repo: "example/repo",
    base_branch: "main",
    priority: 1,
    status: "todo",
    template: "dev",
    merge_policy: "confirm",
    created_by: "human",
    created_at: "2030-01-01T00:00:00.000Z",
  };
  const item: WorkItem = {
    id: "W-2" as never,
    card_id: card.id,
    title: "Fixture",
    kind: "produce",
    role_id: "coder",
    required: true,
    depends_on: [],
    completion_criteria: [],
    assignment_id: "A-3" as never,
    status: "todo",
  };
  const role: Role = {
    role_id: "coder",
    version: 1,
    display_name: "Coder",
    kind: "work",
    core_prompt: "fixture",
    harness: "pi",
    launch_profile_ref: "fixture",
    allowed_tools: [],
    capabilities: [],
    abilities: [],
    worktree: "write",
    required_machine_tags: [],
  };
  // A fresh Assignment for this card: no worktree recorded yet.
  const assignment = {
    ...f.assignment,
    id: "A-3",
    work_item_id: "W-2",
    branch: "agent/C-2/W-2",
    worktree_path: undefined,
    base_sha: undefined,
  } as unknown as Assignment;
  const placed = await service.ensureWorktree({
    project_id: f.project.project_id,
    source_repo: f.source,
    assignment,
    role,
    card,
    work_item: item,
  });
  expect(placed).toMatchObject({
    worktree_path: join(
      f.dataDir,
      "agent",
      "worktrees",
      f.project.project_id,
      "A-3",
    ),
    branch: "agent/C-2/W-2",
    base_sha: centralChild,
    source_sync: "diverged",
  });
  if (placed === undefined) throw new Error("missing placement");
  expect(await git(placed.worktree_path, "rev-parse", "HEAD")).toBe(
    centralChild,
  );
  // Neither baseline moved.
  expect(await git(f.repo, "rev-parse", "refs/heads/main")).toBe(centralChild);
  expect(await git(f.source, "rev-parse", "main")).toBe(sourceChild);
});

// ------------------------------------------------------------- M4.2 §3.7 ---

test("§3.7 a failed backup leaves every existing backup ref untouched, and successes never prune", async () => {
  const delivered = await commit(f.work, "backed up work");
  await f.central.backupAgentBranches(f.project, "local");
  const backupRef = "refs/cardigan/backups/local/agent/C-1/W-1";
  expect(await f.central.git.readRef(f.repo, backupRef)).toBe(delivered);

  // A broken ref in the base clone makes the whole atomic fetch fail.
  await mkdir(join(f.base, ".git", "refs", "heads", "agent"), {
    recursive: true,
  });
  await writeFile(
    join(f.base, ".git", "refs", "heads", "agent", "broken"),
    `${"f".repeat(40)}\n`,
  );
  const before = await refs("backups");
  await expect(
    f.central.backupAgentBranches(f.project, "local"),
  ).rejects.toThrow();
  expect(await refs("backups")).toEqual(before);
  expect(await f.central.git.readRef(f.repo, backupRef)).toBe(delivered);
  await rm(join(f.base, ".git", "refs", "heads", "agent", "broken"));

  // A deleted branch is not pruned from the backups.
  await git(f.work, "checkout", "--detach");
  await git(f.base, "branch", "-D", "agent/C-1/W-1");
  await f.central.backupAgentBranches(f.project, "local");
  expect(await f.central.git.readRef(f.repo, backupRef)).toBe(delivered);
});

// ------------------------------------------------------------ M4.2 §3.4 ---

test("§3.4/§14 agent-ssh: upload-pack runs through the Agent entry and host Git never enters the Agent workspace", async () => {
  await f.close();
  f = await fixture({ agent: true });
  const delivered = await commit(f.work, "agent delivery");
  f.calls.length = 0;
  f.agentCalls.length = 0;

  const verified = await verify(delivered);
  expect(verified).toMatchObject({ ok: true });
  expect(f.agentCalls).toEqual([f.base]);
  // Every host-side command ran inside the private central repository ...
  expect(f.calls.length).toBeGreaterThan(0);
  for (const call of f.calls) {
    expect(call.cwd.startsWith(join(f.dataDir, "central"))).toBe(true);
    const at = call.args.indexOf("-C");
    if (at >= 0) {
      expect(call.args[at + 1]?.startsWith(join(f.dataDir, "central"))).toBe(
        true,
      );
    }
    // The Agent clone may only appear as the fetch source, never as a cwd/-C.
    expect(call.args).not.toContain(f.work);
    expect(call.args).toContain("transfer.fsckObjects=true");
    expect(call.args).toContain("core.hooksPath=/dev/null");
  }
  // ... and the Agent repository was only ever a fetch source.
  const fetches = f.calls.filter((call) => call.args.includes("fetch"));
  expect(fetches).toHaveLength(1);
  expect(fetches[0]?.args).toContain(f.base);
  expect(fetches[0]?.args.some((arg) => arg.startsWith("--upload-pack="))).toBe(
    true,
  );

  await f.central.backupAgentBranches(f.project, "local");
  // Agent backups keep one streaming fetch each, including unchanged polls.
  expect(f.agentCalls).toHaveLength(2);
  await f.central.backupAgentBranches(f.project, "local");
  expect(f.agentCalls).toHaveLength(3);
  expect(f.calls.filter((call) => call.args.includes("ls-remote"))).toEqual([]);
  const transfers = f.calls.filter((call) => call.args.includes("fetch"));
  expect(transfers).toHaveLength(3);
  for (const call of transfers) {
    expect(call.args).toContain(f.base);
    expect(call.args).toContain("--upload-pack=git-upload-pack");
  }
  expect(
    await f.central.git.readRef(
      f.repo,
      "refs/cardigan/backups/local/agent/C-1/W-1",
    ),
  ).toBe(delivered);
  for (const call of f.calls)
    expect(call.cwd.startsWith(join(f.dataDir, "central"))).toBe(true);

  // Without an Agent entry the host refuses instead of falling back to its own
  // identity, and still runs nothing inside the Agent workspace.
  const isolated = new CentralRepositoryService(
    new CentralGitTransport({ dataDir: f.dataDir, agentRoot: f.agentRoot }),
    {
      dataDir: f.dataDir,
      repositoriesRoot: join(f.agentRoot, "repos"),
    },
  );
  const isolatedVerifier = new GitDeliveryVerifier(isolated, f.project);
  const rejected = await isolatedVerifier.verify(
    { kind: "git_head", value: delivered },
    f.assignment,
  );
  expect(rejected.ok).toBe(false);
  expect(await isolated.ensureCentral(f.project)).toBe(
    join(f.dataDir, "central", `${f.project.project_id}.git`),
  );
});
