/**
 * M2.T1 cross-acceptance for M2.5 (worktree service), written from the plan
 * (docs/plans/phase-1-m2.md §5 M2.5) and the development plan (§12.2), against
 * a real Git repository and only the public service surface.
 *
 * The worktree service is called exactly like the assembly layer calls it:
 * `new GitWorktreeService(new LocalGitTransport(), { worktreesRoot })`.
 */
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
  type EnsureWorktreeInput,
  GitWorktreeService,
} from "@cardigan/git-service";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { LocalGitTransport } from "./index.js";

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
      { timeout: 20000 },
    )
  ).stdout.trim();
const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/** A real source repository with one commit on `main`. */
async function sourceRepo(path: string, body: string): Promise<string> {
  await mkdir(path, { recursive: true });
  await git(path, "init", "-b", "main");
  await writeFile(join(path, "README.md"), body);
  await git(path, "add", "README.md");
  await git(path, "commit", "-m", "initial");
  return git(path, "rev-parse", "HEAD");
}

const card = (project: string, id = "C-1", base_branch = "main"): Card => ({
  id: id as never,
  project_id: project as never,
  title: "Cross acceptance",
  goal: "Check the worktree service",
  acceptance_criteria: [],
  source: { kind: "quote", text: "acceptance" },
  out_of_scope: [],
  related_cards: [],
  repo: "example/repo",
  base_branch,
  priority: 1,
  status: "todo",
  template: "dev",
  created_by: "human",
  created_at: "2026-01-01T00:00:00Z",
});

const assignment = (
  id: string,
  workItemId: string,
  overrides: Partial<Assignment> = {},
): Assignment => ({
  id: id as never,
  scope: "work_item",
  work_item_id: workItemId as never,
  role_id: "coder",
  role_version: 1,
  status: "active",
  runtime_state: "not_provisioned",
  machine_id: "local",
  runtime_ref: null,
  mcp_token_id: "fixture",
  created_at: "2026-01-01T00:00:00Z",
  ...overrides,
});

const workItem = (
  id: string,
  cardId: string,
  assignmentId: string,
  overrides: Partial<WorkItem> = {},
): WorkItem => ({
  id: id as never,
  card_id: cardId as never,
  title: "Implement",
  kind: "produce",
  role_id: "coder",
  required: true,
  depends_on: [],
  completion_criteria: [],
  assignment_id: assignmentId as never,
  status: "todo",
  ...overrides,
});

const role = (overrides: Partial<Role> = {}): Role => ({
  role_id: "coder",
  version: 1,
  display_name: "Coder",
  kind: "work",
  core_prompt: "Fixture core prompt.",
  harness: "pi",
  launch_profile_ref: "pi-agent",
  allowed_tools: ["whoami"],
  capabilities: [],
  abilities: [],
  worktree: "write",
  required_machine_tags: [],
  ...overrides,
});

let root: string;
let worktreesRoot: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cardigan-wt-acceptance-"));
  worktreesRoot = join(root, "worktrees");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** The service under test, configured like the assembly layer configures it. */
function service(): GitWorktreeService {
  // `dataDir` isolates the base clones too, so tests never share a clone.
  return new GitWorktreeService(new LocalGitTransport(), {
    dataDir: join(root, "data"),
    worktreesRoot,
  });
}

/** A complete, consistent input: card, work item, assignment and role agree. */
async function fixture(
  options: {
    project?: string;
    repoName?: string;
    sourceBody?: string;
    worktree?: Role["worktree"];
    cardId?: string;
    workItemId?: string;
    assignmentId?: string;
    assignment?: Partial<Assignment>;
  } = {},
): Promise<EnsureWorktreeInput> {
  const project = options.project ?? "p-one";
  const cardId = options.cardId ?? "C-1";
  const workItemId = options.workItemId ?? "W-1";
  const assignmentId = options.assignmentId ?? "A-1";
  const source = join(root, options.repoName ?? `${project}-source`);
  await sourceRepo(source, options.sourceBody ?? "fixture");
  const theCard = card(project, cardId);
  const theItem = workItem(workItemId, theCard.id, assignmentId);
  return {
    project_id: project,
    source_repo: source,
    card: theCard,
    work_item: theItem,
    assignment: assignment(assignmentId, theItem.id, options.assignment),
    role: role({ worktree: options.worktree ?? "write" }),
  };
}

const placed = async (input: EnsureWorktreeInput) => {
  const result = await service().ensureWorktree(input);
  if (result === undefined) throw new Error("the service returned no worktree");
  return result;
};

describe("creating a worktree (§12.2)", () => {
  test("a write assignment gets <root>/<project>/<assignment> on agent/<card>/<work item>", async () => {
    const input = await fixture();
    const head = await git(input.source_repo, "rev-parse", "main");

    const created = await placed(input);

    expect(created.worktree_path).toBe(join(worktreesRoot, "p-one", "A-1"));
    expect(created.branch).toBe("agent/C-1/W-1");
    // The base is the source's current base-branch commit, recorded for M2.6.
    expect(created.base_sha).toBe(head);
    expect(await git(created.worktree_path, "rev-parse", "HEAD")).toBe(head);
    expect(
      await git(created.worktree_path, "symbolic-ref", "--short", "HEAD"),
    ).toBe("agent/C-1/W-1");
    expect(
      await readFile(join(created.worktree_path, "README.md"), "utf8"),
    ).toBe("fixture");

    // The base clone must not share objects with the source repository.
    const clone = join(root, "worktrees", "..", "worktrees");
    expect(await exists(join(root, "worktrees", "p-one", "A-1", ".git"))).toBe(
      true,
    );
    expect(clone).toBeDefined();
  });

  test("the base clone does not share objects with the source repository", async () => {
    const input = await fixture();
    await placed(input);

    // The worktree's git dir lives under the data directory, not in the source.
    const commonDir = await git(
      join(worktreesRoot, "p-one", "A-1"),
      "rev-parse",
      "--git-common-dir",
    );
    expect(commonDir).not.toContain("source");

    // `git clone --local` hardlinks the objects, so deleting one repository
    // would corrupt the other; `--no-local` copies them. Compare the inode of
    // every object file: a shared object is literally the same file on disk.
    const clone = join(root, "data", "agent", "repos", "p-one");
    const objectInodes = async (repository: string) => {
      const inodes = new Map<number, string>();
      const objects = join(repository, ".git", "objects");
      for (const entry of await readdir(objects, {
        recursive: true,
        withFileTypes: true,
      })) {
        if (!entry.isFile()) continue;
        const path = join(entry.parentPath, entry.name);
        inodes.set((await stat(path)).ino, path);
      }
      return inodes;
    };
    const fromClone = await objectInodes(clone);
    const fromSource = await objectInodes(input.source_repo);
    expect([...fromClone.keys()].filter((ino) => fromSource.has(ino))).toEqual(
      [],
    );
    expect(
      await exists(join(clone, ".git", "objects", "info", "alternates")),
    ).toBe(false);
  });

  test("a custom worktrees root is still namespaced by project", async () => {
    const input = await fixture({ project: "p-two" });
    const created = await placed(input);
    expect(created.worktree_path).toBe(join(worktreesRoot, "p-two", "A-1"));
  });

  test("a role with worktree none skips Git entirely", async () => {
    const input = await fixture({ worktree: "none" });
    expect(await service().ensureWorktree(input)).toBeUndefined();
    expect(await exists(join(worktreesRoot, "p-one"))).toBe(false);
  });

  test("an unsafe project id is refused before anything is created", async () => {
    const input = await fixture();
    for (const project of ["", ".", "..", "p/one", "-p-one"]) {
      // The guard must refuse the segment itself, not fail later in Git.
      await expect(
        service().ensureWorktree({ ...input, project_id: project as never }),
      ).rejects.toThrow(/path component/i);
    }
    expect(await exists(join(worktreesRoot, "p-one"))).toBe(false);
  });
});

describe("reusing a worktree (§12.2)", () => {
  test("a second call keeps the worktree, its commits and its dirty files", async () => {
    const input = await fixture();
    const first = await placed(input);
    const head = await git(first.worktree_path, "rev-parse", "HEAD");

    // The Agent worked in the worktree: a commit, a staged file, a stray file.
    await writeFile(join(first.worktree_path, "committed.txt"), "committed\n");
    await git(first.worktree_path, "add", "committed.txt");
    await git(first.worktree_path, "commit", "-m", "agent work");
    const agentHead = await git(first.worktree_path, "rev-parse", "HEAD");
    await writeFile(join(first.worktree_path, "staged.txt"), "staged\n");
    await git(first.worktree_path, "add", "staged.txt");
    await writeFile(join(first.worktree_path, "dirty.txt"), "dirty\n");

    const again = await placed({
      ...input,
      assignment: {
        ...input.assignment,
        base_sha: head,
        worktree_path: first.worktree_path,
        branch: first.branch,
      },
    });

    expect(again.worktree_path).toBe(first.worktree_path);
    expect(again.branch).toBe("agent/C-1/W-1");
    // The recorded base SHA wins over the moved HEAD.
    expect(again.base_sha).toBe(head);
    expect(await git(again.worktree_path, "rev-parse", "HEAD")).toBe(agentHead);
    expect(await readFile(join(again.worktree_path, "dirty.txt"), "utf8")).toBe(
      "dirty\n",
    );
    expect(await git(again.worktree_path, "status", "--porcelain")).toContain(
      "staged.txt",
    );
    expect(await git(again.worktree_path, "log", "-1", "--format=%s")).toBe(
      "agent work",
    );

    // Reuse must not create a second entry in the clone's worktree list.
    const listed = await git(
      join(worktreesRoot, "p-one", "A-1"),
      "worktree",
      "list",
      "--porcelain",
    );
    expect(
      listed.split("\n").filter((line) => line.startsWith("worktree ")),
    ).toHaveLength(2);
  });

  test("an existing worktree for a different branch is refused, not rebuilt", async () => {
    const input = await fixture();
    const first = await placed(input);
    // The card changes, so the derived branch would change too.
    await expect(
      service().ensureWorktree({
        ...input,
        card: card("p-one", "C-2"),
        work_item: workItem("W-2", "C-2" as never, "A-1"),
        assignment: assignment("A-1", "W-2"),
        role: role({ worktree: "write" }),
      }),
    ).rejects.toThrow(/card and work item|branch/i);
    // The original worktree is untouched.
    expect(
      await git(first.worktree_path, "symbolic-ref", "--short", "HEAD"),
    ).toBe("agent/C-1/W-1");
  });

  test("a recorded worktree path that differs from the derived one is refused", async () => {
    const input = await fixture();
    await placed(input);
    await expect(
      service().ensureWorktree({
        ...input,
        assignment: {
          ...input.assignment,
          worktree_path: join(root, "somewhere-else"),
        },
      }),
    ).rejects.toThrow(/root changed/i);
  });
});

describe("readonly worktrees (§12.4)", () => {
  test("a review assignment gets a detached worktree at the delivery commit", async () => {
    const input = await fixture();
    const write = await placed(input);
    await writeFile(join(write.worktree_path, "delivery.txt"), "delivered\n");
    await git(write.worktree_path, "add", "delivery.txt");
    await git(write.worktree_path, "commit", "-m", "delivery");
    const delivery = await git(write.worktree_path, "rev-parse", "HEAD");

    // A reviewer on W-2 of the same card, reading the same delivery commit.
    const review: EnsureWorktreeInput = {
      ...input,
      assignment: assignment("A-2", "W-2"),
      work_item: workItem("W-2", "C-1" as never, "A-2"),
      role: role({ worktree: "readonly" }),
      target_sha: delivery,
    };
    const readonly = await placed(review);

    expect(readonly.worktree_path).toBe(join(worktreesRoot, "p-one", "A-2"));
    // Detached: no branch is attached, and the tip is the delivery commit.
    await expect(
      git(readonly.worktree_path, "symbolic-ref", "--short", "HEAD"),
    ).rejects.toThrow();
    expect(await git(readonly.worktree_path, "rev-parse", "HEAD")).toBe(
      delivery,
    );
    expect(
      await readFile(join(readonly.worktree_path, "delivery.txt"), "utf8"),
    ).toBe("delivered\n");
    expect(readonly.base_sha).toBe(delivery);
  });

  test("a readonly assignment without a target SHA is refused", async () => {
    const input = await fixture({ worktree: "readonly" });
    await expect(service().ensureWorktree(input)).rejects.toThrow(/SHA/i);
    expect(await exists(join(worktreesRoot, "p-one", "A-1"))).toBe(false);
  });

  test("a readonly worktree already at another commit is refused, not switched", async () => {
    const input = await fixture();
    const write = await placed(input);
    for (const [name, message] of [
      ["one.txt", "first"],
      ["two.txt", "second"],
    ]) {
      await writeFile(join(write.worktree_path, name), `${message}\n`);
      await git(write.worktree_path, "add", name);
      await git(write.worktree_path, "commit", "-m", message as string);
    }
    const second = await git(write.worktree_path, "rev-parse", "HEAD");
    const first = await git(write.worktree_path, "rev-parse", "HEAD~1");

    const review: EnsureWorktreeInput = {
      ...input,
      assignment: assignment("A-2", "W-2"),
      work_item: workItem("W-2", "C-1" as never, "A-2"),
      role: role({ worktree: "readonly" }),
      target_sha: second,
    };
    await placed(review);
    await expect(
      service().ensureWorktree({ ...review, target_sha: first }),
    ).rejects.toThrow(/target|SHA/i);
    expect(
      await git(join(worktreesRoot, "p-one", "A-2"), "rev-parse", "HEAD"),
    ).toBe(second);
  });
});

describe("project isolation (§12.2)", () => {
  test("two projects can both have A-1, with separate clones and contents", async () => {
    const one = await fixture({ project: "p-one", sourceBody: "one\n" });
    const two = await fixture({ project: "p-two", sourceBody: "two\n" });
    const a = await placed(one);
    const b = await placed(two);

    expect(a.worktree_path).toBe(join(worktreesRoot, "p-one", "A-1"));
    expect(b.worktree_path).toBe(join(worktreesRoot, "p-two", "A-1"));
    expect(await readFile(join(a.worktree_path, "README.md"), "utf8")).toBe(
      "one\n",
    );
    expect(await readFile(join(b.worktree_path, "README.md"), "utf8")).toBe(
      "two\n",
    );

    // A commit in one project is invisible to the other, even with the same
    // branch name.
    await writeFile(join(a.worktree_path, "only-one.txt"), "mine\n");
    await git(a.worktree_path, "add", "only-one.txt");
    await git(a.worktree_path, "commit", "-m", "only one");
    expect(await exists(join(b.worktree_path, "only-one.txt"))).toBe(false);
    expect(await git(b.worktree_path, "log", "-1", "--format=%s")).toBe(
      "initial",
    );
  });
});

describe("the source repository is never touched (§12.2)", () => {
  test("cloning and fetching leave the source branch, HEAD and refs unchanged", async () => {
    const input = await fixture();
    const head = await git(input.source_repo, "rev-parse", "HEAD");
    const branch = await git(
      input.source_repo,
      "symbolic-ref",
      "--short",
      "HEAD",
    );
    const refs = await git(
      input.source_repo,
      "for-each-ref",
      "--format=%(refname)",
    );
    const status = await git(input.source_repo, "status", "--porcelain");

    await placed(input);
    await placed(input); // reuse triggers a fetch as well

    expect(await git(input.source_repo, "rev-parse", "HEAD")).toBe(head);
    expect(
      await git(input.source_repo, "symbolic-ref", "--short", "HEAD"),
    ).toBe(branch);
    expect(
      await git(input.source_repo, "for-each-ref", "--format=%(refname)"),
    ).toBe(refs);
    expect(await git(input.source_repo, "status", "--porcelain")).toBe(status);
    // Nothing was pushed: no agent branches, no cardigan refs anywhere.
    expect(
      refs.split("\n").filter((ref) => ref.includes("agent/")),
    ).toHaveLength(0);
    expect(refs).not.toContain("refs/cardigan/");
  });

  test("a dirty source repository still starts a clean worktree from its HEAD", async () => {
    const input = await fixture();
    await writeFile(join(input.source_repo, "README.md"), "uncommitted edit\n");
    const head = await git(input.source_repo, "rev-parse", "HEAD");

    const created = await placed(input);

    expect(created.base_sha).toBe(head);
    expect(
      await readFile(join(created.worktree_path, "README.md"), "utf8"),
    ).toBe("fixture");
    expect(await readFile(join(input.source_repo, "README.md"), "utf8")).toBe(
      "uncommitted edit\n",
    );
  });
});

describe("isDirty is a query only (§12.2)", () => {
  test("it reports tracked, staged and untracked changes without touching them", async () => {
    const input = await fixture();
    const created = await placed(input);
    const subject = service();

    expect(await subject.isDirty(created.worktree_path)).toBe(false);

    await writeFile(join(created.worktree_path, "untracked.txt"), "x\n");
    expect(await subject.isDirty(created.worktree_path)).toBe(true);
    await rm(join(created.worktree_path, "untracked.txt"));

    await writeFile(join(created.worktree_path, "staged.txt"), "x\n");
    await git(created.worktree_path, "add", "staged.txt");
    expect(await subject.isDirty(created.worktree_path)).toBe(true);
    await git(created.worktree_path, "reset", "staged.txt");

    await writeFile(join(created.worktree_path, "README.md"), "edited\n");
    const before = await stat(join(created.worktree_path, "README.md"));
    expect(await subject.isDirty(created.worktree_path)).toBe(true);
    // The query did not revert or rewrite the file.
    expect(
      await readFile(join(created.worktree_path, "README.md"), "utf8"),
    ).toBe("edited\n");
    expect((await stat(join(created.worktree_path, "README.md"))).mtimeMs).toBe(
      before.mtimeMs,
    );
  });
});

describe("the Assignment must match its role and work item (§12.2)", () => {
  test("an inactive assignment is refused", async () => {
    const input = await fixture({ assignment: { status: "done" } });
    await expect(service().ensureWorktree(input)).rejects.toThrow(/active/i);
  });

  test("a role version that the assignment does not use is refused", async () => {
    const input = await fixture();
    await expect(
      service().ensureWorktree({ ...input, role: role({ version: 2 }) }),
    ).rejects.toThrow(/role version/i);
  });

  test("a work item that belongs to another assignment is refused", async () => {
    const input = await fixture();
    await expect(
      service().ensureWorktree({
        ...input,
        work_item: {
          ...(input.work_item as WorkItem),
          assignment_id: "A-9" as never,
        },
      }),
    ).rejects.toThrow(/card and work item/i);
  });

  test("a card from another project is refused", async () => {
    const input = await fixture();
    await expect(
      service().ensureWorktree({ ...input, card: card("p-two", "C-1") }),
    ).rejects.toThrow(/card and work item/i);
  });
});
