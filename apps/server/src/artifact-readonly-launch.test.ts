import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Delivery,
  queueRun,
  READONLY_CHECKOUT_EVENT,
  type Runtime,
  type RuntimeLaunch,
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
  launchEntities,
  prepareReadonlyWorktree,
  prepareRoleWorktree,
  worktreeBaselinePrompt,
} from "@cardigan/host";
import { parseLaunchConfig } from "@cardigan/roles";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { startQueuedRun } from "./host-start.js";
import { m4Fixture, m4Scenario } from "./m4-fixtures.js";

// C-630: a verifier of an artifact delivery (APK etc.) has no Git commit to
// check out. It starts at the recorded source commit or the card baseline.

let f: ReturnType<typeof m4Fixture>, s: ReturnType<typeof m4Scenario>;
let source: string, service: GitWorktreeService, runtime: Runtime;
const launched: RuntimeLaunch[] = [];
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
const commit = async (content: string) => {
  writeFileSync(join(source, "version"), content);
  git(source, "add", ".");
  git(source, "commit", "-qm", content);
  // The real delivery endpoint and writer preparation sync the center.
  await new CentralRepositoryService(
    new CentralGitTransport({ dataDir: f.dataDir }),
    { dataDir: f.dataDir },
  ).syncFromSource({
    project_id: f.project_id,
    source_repo: source,
    base_branch: "main",
  });
  return git(source, "rev-parse", "HEAD");
};
const ok = <T>(value: T) => ({ ok: true as const, value });
const host = () => ({
  store: f.store,
  runtime,
  launch: {
    config: parseLaunchConfig({
      profiles: { fixture: { harness: "pi", model: "fixture-model" } },
    }),
    secrets: {},
  },
  mcpUrl: "http://localhost/mcp",
  dataDir: f.dataDir,
});
const placement = () => ({
  ...host(),
  execution: { mode: "local" as const, dataDir: f.dataDir },
});
const deliver = async (subject: string, kind: "git" | "artifact") => {
  f.startRun(s.coder);
  const delivery = await f.deliver(s.coder, s.development.id, {
    ...(kind === "artifact"
      ? { kind: "other" as const, subject_kind: "artifact_sha256" as const }
      : {}),
    subject,
    verifiers: [s.codeReview.id],
  });
  f.endRun(s.coder);
  return delivery;
};
const checkouts = () =>
  f.state().events.filter((e) => e.type === READONLY_CHECKOUT_EVENT);
const notes = (delivery: Delivery) =>
  f
    .state()
    .timeline.filter(
      (t) => t.type === "system" && t.delivery_id === delivery.id,
    );
const artifact = "a".repeat(64);

beforeEach(() => {
  f = m4Fixture({ reviewer_worktree: "readonly" });
  s = m4Scenario(f);
  source = join(f.dataDir, "source");
  mkdirSync(source);
  git(source, "init", "-qb", "main");
  f.store.setProjectRepo({ project_id: f.project_id, repo_path: source });
  service = new GitWorktreeService(
    new LocalGitTransport(),
    new CentralRepositoryService(
      new CentralGitTransport({ dataDir: f.dataDir }),
      { dataDir: f.dataDir },
    ),
    { dataDir: f.dataDir },
  );
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

test("a pure artifact delivery starts its verifier at the baseline HEAD and says so", async () => {
  const first = await commit("one");
  const product = await deliver(artifact, "artifact");
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
    bell: "review artifact",
  });
  const path = join(
    f.dataDir,
    "agent",
    "worktrees",
    f.project_id,
    s.reviewer.id,
  );
  expect(launched[0]?.cwd).toBe(path);
  expect(git(path, "rev-parse", "HEAD")).toBe(first);
  expect(() => git(path, "symbolic-ref", "HEAD")).toThrow();
  expect(checkouts()).toHaveLength(1);
  expect(checkouts()[0]?.payload).toMatchObject({
    assignment_id: s.reviewer.id,
    work_item_id: s.codeReview.id,
    delivery_id: product.id,
    subject_kind: "artifact_sha256",
    source: "baseline",
    baseline_ref: "origin/main",
    sha: first,
  });
  expect(notes(product).at(-1)?.body).toContain(
    `检出基线 origin/main 的当前 HEAD ${first}`,
  );
  // A later preparation follows the baseline and records only a new commit.
  const result = await prepareReadonlyWorktree(
    placement(),
    f.project_id,
    s.reviewer.id,
  );
  expect(result?.artifact).toEqual({
    delivery_id: product.id,
    source: "baseline",
    sha: first,
  });
  expect(result?.baseline).toEqual({ ref: "origin/main", sha: first });
  expect(result?.build).toBeUndefined();
  expect(existsSync(service.buildPath(f.project_id, s.reviewer.id))).toBe(
    false,
  );
  expect(worktreeBaselinePrompt(result)).toContain(
    `待审的 ${product.id} 是制品交付，没有 Git 提交；只读工作区检出的是基线当前 HEAD ${first}`,
  );
  expect(checkouts()).toHaveLength(1);
  const second = await commit("two");
  const moved = await prepareRoleWorktree(
    placement(),
    f.project_id,
    s.reviewer.id,
  );
  expect(git(path, "rev-parse", "HEAD")).toBe(second);
  expect(moved?.artifact?.sha).toBe(second);
  expect(checkouts().map((e) => (e.payload as { sha: string }).sha)).toEqual([
    first,
    second,
  ]);
});

test("Git then artifact checks out the artifact's recorded source commit", async () => {
  const built = await commit("one");
  await deliver(built, "git");
  const ahead = await commit("two");
  const product = await deliver(artifact, "artifact");
  const result = await prepareRoleWorktree(
    placement(),
    f.project_id,
    s.reviewer.id,
  );
  if (!result?.build) throw new Error("Missing build checkout");
  expect(git(result.path, "rev-parse", "HEAD")).toBe(built);
  expect(git(result.build.path, "rev-parse", "HEAD")).toBe(built);
  expect(git(result.path, "rev-parse", "HEAD")).not.toBe(ahead);
  expect(result.artifact).toEqual({
    delivery_id: product.id,
    source: "source_commit",
    sha: built,
  });
  expect(worktreeBaselinePrompt(result)).toContain(
    `制品记录的源码提交 ${built}`,
  );
  const [event] = checkouts();
  expect(checkouts()).toHaveLength(1);
  expect(event?.payload).toMatchObject({
    delivery_id: product.id,
    source: "source_commit",
    sha: built,
  });
  expect(notes(product).at(-1)?.body).toContain(
    `检出制品记录的源码提交 ${built}`,
  );
  await prepareReadonlyWorktree(placement(), f.project_id, s.reviewer.id);
  expect(checkouts()).toHaveLength(1);
  // The reviewer can still review the artifact delivery itself.
  f.startRun(s.reviewer);
  expect(f.review(s.reviewer, product).target_sha).toBe(artifact);
});

test("a Git delivery after an artifact keeps the ordinary Git checkout", async () => {
  await commit("one");
  await deliver(artifact, "artifact");
  const next = await commit("two");
  await deliver(next, "git");
  const result = await prepareRoleWorktree(
    placement(),
    f.project_id,
    s.reviewer.id,
  );
  expect(git(result?.path ?? "", "rev-parse", "HEAD")).toBe(next);
  expect(result?.artifact).toBeUndefined();
  expect(result?.baseline).toBeUndefined();
  expect(result?.build?.sha).toBe(next);
  expect(worktreeBaselinePrompt(result)).not.toContain("制品交付");
  expect(checkouts()).toHaveLength(0);
});

test("an artifact baseline checkout is only for the assigned readonly verifier", async () => {
  await commit("one");
  const product = await deliver(artifact, "artifact");
  const reviewer = launchEntities(f.store, f.project_id, s.reviewer.id);
  const coder = launchEntities(f.store, f.project_id, s.coder.id);
  const request = (e: typeof reviewer) => ({
    project_id: f.project_id,
    source_repo: source,
    assignment: e.assignment,
    role: e.role,
    ...(e.card ? { card: e.card } : {}),
    ...(e.workItem ? { work_item: e.workItem } : {}),
    artifact_delivery: product.id,
  });
  for (const input of [
    { ...request(reviewer), target_sha: git(source, "rev-parse", "HEAD") },
    { ...request(reviewer), artifact_delivery: "D-x" as Delivery["id"] },
    request(coder),
  ])
    await expect(service.ensureWorktree(input)).rejects.toThrow(
      "Artifact baseline checkout requires the assigned verifier",
    );
  expect(checkouts()).toHaveLength(0);
});
