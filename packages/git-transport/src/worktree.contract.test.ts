import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Assignment, Card, Role, WorkItem } from "@cardigan/domain";
import {
  CentralRepositoryService,
  type EnsureWorktreeInput,
  GitWorktreeService,
  type WorktreePlacement,
} from "@cardigan/git-service";
import { afterEach, beforeEach, expect, test } from "vitest";
import { CentralGitTransport, LocalGitTransport } from "./index.js";

const exec = promisify(execFile);
const git = async (path: string, ...args: string[]) =>
  (
    await exec(
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
      { timeout: 15000 },
    )
  ).stdout.trim();
let root: string,
  source: string,
  dataDir: string,
  input: EnsureWorktreeInput,
  transport: LocalGitTransport,
  service: GitWorktreeService;
function placement(value: WorktreePlacement | undefined) {
  if (!value) throw new Error("Missing worktree");
  return value;
}
const commit = async (path: string, body: string) => {
  await writeFile(join(path, "tracked.txt"), body);
  await git(path, "add", ".");
  await git(path, "commit", "-m", "Fixture update");
  return git(path, "rev-parse", "HEAD");
};
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cardigan-git-"));
  source = join(root, "source");
  dataDir = join(root, "data");
  await mkdir(source);
  await git(source, "init", "-b", "main");
  await commit(source, "initial");
  const card: Card = {
    id: "C-1" as never,
    project_id: "fixture",
    title: "Build",
    goal: "Ship",
    acceptance_criteria: [],
    source: { kind: "quote", text: "Build" },
    out_of_scope: [],
    related_cards: [],
    repo: "example/repo",
    base_branch: "main",
    priority: 1,
    status: "todo",
    template: "dev",
    created_by: "human",
    created_at: "2026-01-01T00:00:00Z",
  };
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
    created_at: card.created_at,
  };
  const item: WorkItem = {
    id: "W-1" as never,
    card_id: card.id,
    title: "Build",
    kind: "produce",
    role_id: "coder",
    required: true,
    depends_on: [],
    completion_criteria: [],
    assignment_id: assignment.id,
    status: "todo",
  };
  const role: Role = {
    role_id: "coder",
    version: 1,
    display_name: "Coder",
    kind: "work",
    core_prompt: "Fixture",
    harness: "codex",
    launch_profile_ref: "fixture",
    allowed_tools: [],
    capabilities: [],
    abilities: [],
    worktree: "write",
    required_machine_tags: [],
  };
  input = {
    project_id: card.project_id,
    source_repo: source,
    assignment,
    role,
    card,
    work_item: item,
  };
  transport = new LocalGitTransport();
  service = new GitWorktreeService(
    transport,
    new CentralRepositoryService(new CentralGitTransport({ dataDir }), {
      dataDir,
    }),
    { dataDir },
  );
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test.each(["checkout", "bare"])(
  "creates an isolated clone and correctly named worktree from a local %s repository",
  async (kind) => {
    const head = await git(source, "rev-parse", "HEAD");
    await git(source, "gc", "--prune=now");
    if (kind === "bare") {
      const bare = join(root, "bare.git");
      await git(root, "clone", "--no-local", "--bare", source, bare);
      input = { ...input, source_repo: bare };
    }
    const before = await git(source, "show-ref");
    const created = placement(await service.ensureWorktree(input));
    expect(created).toEqual({
      worktree_path: join(dataDir, "agent", "worktrees", "fixture", "A-1"),
      branch: "agent/C-1/W-1",
      base_sha: head,
      baseline: { ref: "origin/main", sha: head },
      source_sync: "up_to_date",
    });
    expect(
      await git(created.worktree_path, "symbolic-ref", "--short", "HEAD"),
    ).toBe(created.branch);
    expect(
      await readFile(join(created.worktree_path, "tracked.txt"), "utf8"),
    ).toBe("initial");
    const clone = join(dataDir, "agent", "repos", "fixture");
    await expect(
      access(join(clone, ".git", "objects", "info", "alternates")),
    ).rejects.toThrow();
    const objectRoot =
      kind === "bare"
        ? join(input.source_repo, "objects")
        : join(source, ".git", "objects");
    for (const name of await readdir(join(objectRoot, "pack")))
      expect((await stat(join(objectRoot, "pack", name))).nlink).toBe(1);
    await commit(created.worktree_path, "Agent commit");
    expect(await git(source, "show-ref")).toBe(before); // No push and no source branch changes.
    expect(await git(source, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(await git(source, "status", "--porcelain")).toBe("");
  },
);

test("invariant 5: repeated start preserves its branch commits, uncommitted files and original base SHA", async () => {
  const first = placement(await service.ensureWorktree(input));
  const ownHead = await commit(first.worktree_path, "Agent commit");
  await writeFile(join(first.worktree_path, "tracked.txt"), "uncommitted");
  await commit(source, "Upstream changed");
  const again = await service.ensureWorktree({
    ...input,
    assignment: { ...input.assignment, ...first },
  });
  expect(again).toEqual({ ...first, source_sync: undefined });
  expect(await git(first.worktree_path, "rev-parse", "HEAD")).toBe(ownHead);
  expect(await readFile(join(first.worktree_path, "tracked.txt"), "utf8")).toBe(
    "uncommitted",
  );
  expect(await service.isDirty(first.worktree_path)).toBe(true);
});

test.each(["fast_forwarded", "ahead", "diverged"])(
  "a new Assignment uses the central baseline after %s synchronization",
  async (sync) => {
    const first = placement(await service.ensureWorktree(input));
    const central = join(dataDir, "central", "fixture.git");
    const nextHead = await commit(
      sync === "fast_forwarded" ? source : first.worktree_path,
      "Next baseline",
    );
    if (sync !== "fast_forwarded") {
      await git(
        central,
        "fetch",
        first.worktree_path,
        `${first.branch}:refs/heads/main`,
      );
      if (sync === "diverged") await commit(source, "Diverged source");
    }
    const sourceRefs = await git(source, "show-ref");
    const centralRefs = await git(central, "for-each-ref", "refs/heads/");
    if (!input.card || !input.work_item) throw new Error("Missing fixture");
    const next = placement(
      await service.ensureWorktree({
        ...input,
        assignment: {
          ...input.assignment,
          id: "A-2" as never,
          scope: "work_item",
          work_item_id: "W-2" as never,
        },
        card: { ...input.card, id: "C-2" as never },
        work_item: {
          ...input.work_item,
          id: "W-2" as never,
          card_id: "C-2" as never,
          assignment_id: "A-2" as never,
        },
      }),
    );
    expect(next).toMatchObject({
      branch: "agent/C-2/W-2",
      base_sha: nextHead,
      source_sync: sync,
    });
    expect(await git(next.worktree_path, "rev-parse", "HEAD")).toBe(nextHead);
    expect(await git(source, "show-ref")).toBe(sourceRefs);
    if (sync !== "fast_forwarded")
      expect(await git(central, "for-each-ref", "refs/heads/")).toBe(
        centralRefs,
      );
    expect(await git(first.worktree_path, "rev-parse", "HEAD")).toBe(
      sync === "fast_forwarded" ? first.base_sha : nextHead,
    );
    expect(await git(source, "for-each-ref", "refs/heads/agent/")).toBe("");
  },
);

test("S7 readonly worktrees refresh to an explicitly requested delivery SHA", async () => {
  const sha = await git(source, "rev-parse", "HEAD");
  const next = await commit(source, "Next version");
  const readonly = {
    ...input,
    role: { ...input.role, worktree: "readonly" as const },
    target_sha: sha,
  };
  const created = placement(await service.ensureWorktree(readonly));
  expect(created).not.toHaveProperty("branch");
  expect(created.base_sha).toBe(sha);
  await expect(
    git(created.worktree_path, "symbolic-ref", "HEAD"),
  ).rejects.toThrow();
  expect(await git(created.worktree_path, "rev-parse", "HEAD")).toBe(sha);
  expect(await service.ensureWorktree(readonly)).toEqual(created);
  // S12: test tools generate disposable, untracked caches in review workspaces.
  await mkdir(join(created.worktree_path, "__pycache__"));
  await writeFile(
    join(created.worktree_path, "__pycache__", "review.pyc"),
    "cache",
  );
  const refreshed = placement(
    await service.ensureWorktree({ ...readonly, target_sha: next }),
  );
  expect(refreshed.worktree_path).toBe(created.worktree_path);
  expect(await git(created.worktree_path, "rev-parse", "HEAD")).toBe(next);
  expect(
    await readFile(
      join(created.worktree_path, "__pycache__", "review.pyc"),
      "utf8",
    ),
  ).toBe("cache");
  await expect(
    git(created.worktree_path, "symbolic-ref", "HEAD"),
  ).rejects.toThrow();
  await writeFile(join(created.worktree_path, "tracked.txt"), "review notes");
  await expect(service.ensureWorktree(readonly)).rejects.toThrow(
    /dirty|uncommitted/i,
  );
  expect(await git(created.worktree_path, "rev-parse", "HEAD")).toBe(next);
  expect(
    await readFile(join(created.worktree_path, "tracked.txt"), "utf8"),
  ).toBe("review notes");
});

test("dirty queries include tracked, staged and untracked changes but do not modify anything", async () => {
  const { worktree_path: path } = placement(
    await service.ensureWorktree(input),
  );
  expect(await service.isDirty(path)).toBe(false);
  await writeFile(join(path, "tracked.txt"), "dirty");
  expect(await service.isDirty(path)).toBe(true);
  await git(path, "add", "tracked.txt");
  expect(await service.isDirty(path)).toBe(true);
  await git(path, "restore", "--staged", "--worktree", "tracked.txt");
  await writeFile(join(path, "untracked"), "keep");
  expect(await service.isDirty(path)).toBe(true);
  expect(await readFile(join(path, "untracked"), "utf8")).toBe("keep");
});

test("worktree=none skips Git and configured roots override the defaults", async () => {
  expect(
    await service.ensureWorktree({
      ...input,
      role: { ...input.role, worktree: "none" },
    }),
  ).toBeUndefined();
  await expect(access(dataDir)).rejects.toThrow();
  const custom = new GitWorktreeService(
    transport,
    new CentralRepositoryService(new CentralGitTransport({ dataDir }), {
      dataDir,
    }),
    {
      repositoriesRoot: join(root, "repos"),
      worktreesRoot: join(root, "trees"),
    },
  );
  expect(placement(await custom.ensureWorktree(input)).worktree_path).toBe(
    join(root, "trees", "fixture", "A-1"),
  );
});

test("non-local sources, ownership mismatches and missing readonly SHAs are rejected", async () => {
  for (const source_repo of [
    "relative",
    "https://example.invalid/repo",
    "user@host:repo",
  ])
    await expect(
      service.ensureWorktree({ ...input, source_repo }),
    ).rejects.toThrow(/absolute local/);
  await expect(
    service.ensureWorktree({
      ...input,
      assignment: { ...input.assignment, machine_id: "remote" },
    }),
  ).rejects.toThrow(/local Assignment/);
  await expect(
    service.ensureWorktree({ ...input, role: { ...input.role, version: 2 } }),
  ).rejects.toThrow(/Role version/);
  await expect(
    service.ensureWorktree({
      ...input,
      work_item: undefined,
    } as unknown as EnsureWorktreeInput),
  ).rejects.toThrow(/must belong/);
  await expect(
    service.ensureWorktree({
      ...input,
      role: { ...input.role, worktree: "readonly" },
    }),
  ).rejects.toThrow(/commit SHA/);
});

test.each([
  "",
  ".",
  "..",
  "../outside",
  "nested/project",
  "/absolute",
  "-project",
  "back\\slash",
])(
  "unsafe project path component %j is rejected before creating directories",
  async (project_id) => {
    await expect(
      service.ensureWorktree({ ...input, project_id }),
    ).rejects.toThrow(/path component/);
    await expect(access(dataDir)).rejects.toThrow();
  },
);

test("existing foreign paths, branches and source repositories are never overwritten", async () => {
  const path = join(dataDir, "agent", "worktrees", "fixture", "A-1");
  await mkdir(dataDir, { mode: 0o700 });
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "keep"), "private");
  await expect(service.ensureWorktree(input)).rejects.toThrow(/already exists/);
  expect(await readFile(join(path, "keep"), "utf8")).toBe("private");
  await rm(path, { recursive: true });
  const created = placement(await service.ensureWorktree(input));
  await git(created.worktree_path, "switch", "-c", "different");
  await expect(service.ensureWorktree(input)).rejects.toThrow(
    /different branch/,
  );
  const clone = join(dataDir, "agent", "repos", "fixture");
  await git(
    clone,
    "remote",
    "set-url",
    "origin",
    "https://example.invalid/never-fetch",
  );
  await expect(service.ensureWorktree(input)).rejects.toThrow(
    /does not belong/,
  );
});

test("two projects with A-1 have simultaneous independent worktrees under the default root", async () => {
  if (!input.card) throw new Error("Missing fixture");
  const other = {
    ...input,
    project_id: "other",
    card: { ...input.card, project_id: "other" },
  };
  const [first, second] = (
    await Promise.all([
      service.ensureWorktree(input),
      service.ensureWorktree(other),
    ])
  ).map(placement);
  if (!first || !second) throw new Error("Missing placements");
  expect(first.worktree_path).toBe(
    join(dataDir, "agent", "worktrees", "fixture", "A-1"),
  );
  expect(second.worktree_path).toBe(
    join(dataDir, "agent", "worktrees", "other", "A-1"),
  );
  const [firstHead, secondHead] = await Promise.all([
    commit(first.worktree_path, "First project"),
    commit(second.worktree_path, "Second project"),
  ]);
  expect(firstHead).not.toBe(secondHead);
  await writeFile(
    join(first.worktree_path, "tracked.txt"),
    "First project pending",
  );
  expect(await service.isDirty(first.worktree_path)).toBe(true);
  expect(await service.isDirty(second.worktree_path)).toBe(false);
  expect(
    await service.ensureWorktree({
      ...input,
      assignment: { ...input.assignment, ...first },
    }),
  ).toEqual({ ...first, source_sync: undefined });
  expect(
    await service.ensureWorktree({
      ...other,
      assignment: { ...other.assignment, ...second },
    }),
  ).toEqual({ ...second, source_sync: undefined });
  expect(await git(first.worktree_path, "rev-parse", "HEAD")).toBe(firstHead);
  expect(await git(second.worktree_path, "rev-parse", "HEAD")).toBe(secondHead);
  expect(await readFile(join(first.worktree_path, "tracked.txt"), "utf8")).toBe(
    "First project pending",
  );
  expect(
    await readFile(join(second.worktree_path, "tracked.txt"), "utf8"),
  ).toBe("Second project");
});
