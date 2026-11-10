/**
 * M4.4 merge execution loop (plan §4 M4.4, development plan §12.5).
 *
 * Real Git in temporary repositories, real domain commands in a real Store:
 * `ServerGit` runs the real central repository and the assertions are on refs,
 * commits and events, so nothing about the merge itself is mocked.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  completeHumanAction,
  requestHumanAction,
  setProjectPreferences,
} from "@cardigan/domain";
import {
  type CentralProject,
  CentralRepositoryService,
} from "@cardigan/git-service";
import { CentralGitTransport } from "@cardigan/git-transport";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ServerGit } from "./git.js";
import {
  acceptThroughMergeGate,
  type M4Fixture,
  m4Fixture,
  m4Scenario,
  mergeConfirmation,
} from "./m4-fixtures.js";
import { MergeExecutor } from "./merge-loop.js";
import { cardDetail, needsYou } from "./web/read.js";

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
const commit = (cwd: string, name: string, text: string) => {
  writeFileSync(join(cwd, name), text);
  git(cwd, "add", name);
  git(cwd, "commit", "-m", text);
  return git(cwd, "rev-parse", "HEAD");
};

interface Repos {
  readonly root: string;
  readonly source: string;
  readonly agent: string;
  readonly base: string;
  close(): void;
}

/** A registered source, an agent checkout and (later) the central repository. */
function repositories(): Repos {
  const root = mkdtempSync(join(tmpdir(), "cardigan-merge-"));
  const source = join(root, "source");
  git(root, "init", "-q", "-b", "main", source);
  const base = commit(source, "README.md", "fixture\n");
  const agent = join(root, "agent");
  git(root, "clone", "-q", source, agent);
  return {
    root,
    source,
    agent,
    base,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

let f: M4Fixture;
let repos: Repos;
let project: CentralProject;
let central: CentralRepositoryService;

beforeEach(() => {
  f = m4Fixture();
  repos = repositories();
  f.store.setProjectRepo({
    project_id: f.project_id,
    repo_path: repos.source,
    base_branch: "main",
  });
  project = {
    project_id: f.project_id,
    source_repo: repos.source,
    base_branch: "main",
  };
  central = new CentralRepositoryService(
    new CentralGitTransport({ dataDir: f.dataDir }),
    { dataDir: f.dataDir },
  );
});
afterEach(() => {
  f.close();
  repos.close();
});

/** Publish the agent commit into the central repository and pin the delivery. */
async function pin(deliveryId: string, sha: string) {
  const repository = await central.ensureCentral(project);
  await central.git.fetchRefs(repository, repos.agent, [`+${sha}:${sha}`]);
  await central.pinDelivery(project, deliveryId, sha);
}

/** A commit on an agent branch, as a coder would make it. */
function agentCommit(branch: string, name: string, text: string) {
  git(repos.agent, "fetch", "-q", "origin");
  git(repos.agent, "checkout", "-q", "-B", branch, "origin/main");
  const sha = commit(repos.agent, name, text);
  git(repos.agent, "checkout", "-q", "main");
  return sha;
}

const executor = () =>
  new MergeExecutor({
    store: f.store,
    git: new ServerGit({ store: f.store, dataDir: f.dataDir }),
  });

const baseline = async () =>
  central.git.readRef(await central.ensureCentral(project), "refs/heads/main");

test("an auto-policy card merges its pinned delivery into the baseline", async () => {
  const scenario = m4Scenario(f, "auto");
  const sha = agentCommit("agent/C-1/W-1", "feature.txt", "feature\n");
  const { product } = await acceptThroughMergeGate(f, scenario, sha);
  await pin(product.id, sha);
  await executor().tick(f.project_id);

  const repository = await central.ensureCentral(project),
    tip = await baseline();
  expect(tip).not.toBe(repos.base);
  expect(git(repository, "cat-file", "-p", tip as string)).toContain(
    "Merge C-1/W-1 delivery",
  );
  expect(f.card().status).toBe("done");
  const merged = f
    .state()
    .events.filter((event) => event.type === "card_merged");
  expect(merged).toHaveLength(1);
  expect(merged[0]?.actor).toMatchObject({ kind: "system" });
});

test("a confirm-policy card waits for the human, then merges", async () => {
  const scenario = m4Scenario(f, "confirm");
  const sha = agentCommit("agent/C-1/W-1", "feature.txt", "feature\n");
  const { product } = await acceptThroughMergeGate(f, scenario, sha);
  await pin(product.id, sha);

  await executor().tick(f.project_id);
  expect(f.card().status).toBe("awaiting_merge");
  expect(await baseline()).toBe(repos.base);

  const confirmation = mergeConfirmation(f, scenario.card.id);
  expect(confirmation?.status).toBe("open");
  f.decide(confirmation as never, "merge");
  await executor().tick(f.project_id);
  expect(f.card().status).toBe("done");
});

test("an unconfirmed card stays put and is never asked twice", async () => {
  const scenario = m4Scenario(f, "confirm");
  const sha = agentCommit("agent/C-1/W-1", "feature.txt", "feature\n");
  await acceptThroughMergeGate(f, scenario, sha);
  await executor().tick(f.project_id);
  await executor().tick(f.project_id);
  expect(
    f.state().decisions.filter((d) => d.trigger === "merge_confirmation"),
  ).toHaveLength(1);
  expect(f.card().status).toBe("awaiting_merge");
});

test("a conflicting delivery returns the card to in_progress with a fix event", async () => {
  // Two cards whose agent branches both start at the original baseline and
  // both rewrite the same file: the second merge must conflict.
  const first = m4Scenario(f, "auto"),
    second = m4Scenario(f, "auto"),
    firstSha = agentCommit("agent/C-1/W-1", "README.md", "first agent\n"),
    secondSha = agentCommit("agent/C-3/W-4", "README.md", "second agent\n"),
    firstDelivery = await acceptThroughMergeGate(f, first, firstSha);
  await pin(firstDelivery.product.id, firstSha);
  await executor().tick(f.project_id);
  expect(f.card(first.card.id).status).toBe("done");

  const secondDelivery = await acceptThroughMergeGate(f, second, secondSha);
  await pin(secondDelivery.product.id, secondSha);
  await executor().tick(f.project_id);

  expect(f.card(second.card.id).status).toBe("in_progress");
  expect(f.item(second.development.id).status).toBe("changes_requested");
  const conflict = f
    .state()
    .events.find((event) => event.type === "merge_conflicted");
  expect(conflict?.payload).toMatchObject({
    completion_id: secondDelivery.completion.id,
    work_item_id: second.development.id,
    run_kind: "fix",
  });
  expect(
    (conflict?.payload as { result: { files: string[] } } | null)?.result.files,
  ).toEqual(["README.md"]);
  // The baseline is still the first card's merge commit: no ref moved for the
  // conflicting card, and only the first card reports a merge.
  const repository = await central.ensureCentral(project),
    tip = await baseline();
  expect(
    await central.git.readRef(
      repository,
      `refs/cardigan/deliveries/${firstDelivery.product.id}`,
    ),
  ).not.toBe(undefined);
  expect(git(repository, "cat-file", "-p", tip as string)).toContain(
    `Merge ${first.card.id}/${first.development.id} delivery`,
  );
  expect(
    f
      .state()
      .events.filter(
        (event) =>
          event.type === "card_merged" && event.card_id === second.card.id,
      ),
  ).toHaveLength(0);
});

test("a replayed merge is a no-op, not a second merge commit", async () => {
  const scenario = m4Scenario(f, "auto");
  const sha = agentCommit("agent/C-1/W-1", "feature.txt", "feature\n");
  const { product } = await acceptThroughMergeGate(f, scenario, sha);
  await pin(product.id, sha);
  const loop = executor();
  await loop.tick(f.project_id);
  const first = await baseline();
  await loop.tick(f.project_id);
  expect(await baseline()).toBe(first);
  expect(
    f.state().events.filter((event) => event.type === "card_merged"),
  ).toHaveLength(1);
});

test("a baseline advanced behind the loop's back is not overwritten", async () => {
  const scenario = m4Scenario(f, "auto");
  const sha = agentCommit("agent/C-1/W-1", "feature.txt", "feature\n");
  const { product } = await acceptThroughMergeGate(f, scenario, sha);
  await pin(product.id, sha);
  // Another writer moves the central baseline after the delivery branched.
  const competing = commit(repos.source, "other.txt", "other\n");
  const repository = await central.ensureCentral(project);
  await central.git.fetchRefs(repository, repos.source, [
    `+${competing}:refs/cardigan/source/main`,
  ]);
  await central.git.compareAndSwapRef(
    repository,
    "refs/heads/main",
    competing,
    repos.base,
  );
  await executor().tick(f.project_id);
  const tip = await baseline();
  expect(tip).not.toBe(competing);
  // The delivery was merged on top of the moved baseline, keeping both parents.
  expect(git(repository, "cat-file", "-p", tip as string)).toContain(
    `parent ${competing}`,
  );
  expect(f.card().status).toBe("done");
});

test("a broken card does not stop the other cards of the same project", async () => {
  // The first card's delivery is pinned to the wrong SHA; the second is fine.
  const broken = m4Scenario(f, "auto"),
    healthy = m4Scenario(f, "auto"),
    brokenSha = agentCommit("agent/C-1/W-1", "broken.txt", "broken\n"),
    healthySha = agentCommit("agent/C-3/W-4", "healthy.txt", "healthy\n"),
    wrong = agentCommit("agent/C-9/W-9", "other.txt", "other\n");
  const brokenDelivery = await acceptThroughMergeGate(f, broken, brokenSha);
  await pin(brokenDelivery.product.id, wrong);
  const healthyDelivery = await acceptThroughMergeGate(f, healthy, healthySha);
  await pin(healthyDelivery.product.id, healthySha);
  await executor().tick(f.project_id);

  expect(f.card(broken.card.id).status).toBe("awaiting_merge");
  expect(f.card(healthy.card.id).status).toBe("done");
  expect(
    f
      .state()
      .events.filter(
        (event) =>
          event.type === "merge_failed" && event.card_id === broken.card.id,
      ),
  ).toHaveLength(1);
  const repository = await central.ensureCentral(project);
  expect(
    git(repository, "cat-file", "-p", (await baseline()) as string),
  ).toContain(`Merge ${healthy.card.id}/${healthy.development.id} delivery`);
});

test("a delivery whose pinned ref does not match is reported, not merged", async () => {
  const scenario = m4Scenario(f, "auto");
  const sha = agentCommit("agent/C-1/W-1", "feature.txt", "feature\n"),
    other = agentCommit("agent/C-9/W-9", "other.txt", "other\n");
  const { product } = await acceptThroughMergeGate(f, scenario, sha);
  await pin(product.id, other);
  await executor().tick(f.project_id);
  expect(f.card().status).toBe("awaiting_merge");
  expect(await baseline()).toBe(repos.base);
  expect(
    f.state().events.filter((event) => event.type === "merge_failed"),
  ).toHaveLength(1);
  // A broken pin does not spam a second failure event every tick.
  await executor().tick(f.project_id);
  expect(
    f.state().events.filter((event) => event.type === "merge_failed"),
  ).toHaveLength(1);
});

test("timeout preference delegates once then merges through the existing Git executor", async () => {
  const scenario = m4Scenario(f, "confirm");
  const sha = agentCommit("agent/C-1/W-1", "timeout.txt", "timeout feature\n");
  const { product } = await acceptThroughMergeGate(f, scenario, sha);
  await pin(product.id, sha);
  const start = Date.parse(f.clock.now());
  let time = start + 10 * 60_000 - 1;
  const loop = () =>
    new MergeExecutor({
      store: f.store,
      git: new ServerGit({ store: f.store, dataDir: f.dataDir }),
      clock: { now: () => new Date(time).toISOString() },
    });
  await loop().tick();
  expect(f.card().status).toBe("awaiting_merge");
  f.apply((s, a, p) =>
    setProjectPreferences(s, a, { auto_merge_after_minutes: 10 }, p),
  );
  expect(needsYou(f.state(), f.clock.now()).decisions[0]?.auto_merge).toEqual({
    minutes: 10,
    due_at: new Date(start + 10 * 60_000).toISOString(),
  });
  expect(
    cardDetail(f.state(), scenario.card.id)?.decisions[0]?.auto_merge?.minutes,
  ).toBe(10);
  await loop().tick();
  expect(f.card().status).toBe("awaiting_merge");
  const action = f.apply((s, a, p) =>
    requestHumanAction(
      s,
      a,
      {
        card_id: scenario.card.id,
        instructions: "Confirm access",
        why_human: "Manual",
        expected_return: "Done",
        blocked_work_items: [],
      },
      p,
    ),
  );
  time++;
  await loop().tick();
  expect(f.state().decisions[0]?.status).toBe("open");
  expect(
    needsYou(f.state(), f.clock.now()).decisions[0]?.auto_merge,
  ).toBeNull();
  f.apply((s, a, p) =>
    completeHumanAction(s, a, { human_action_id: action.id, text: "Done" }, p),
  );
  await loop().tick();
  expect(f.card().status).toBe("done");
  expect(await baseline()).not.toBe(repos.base);
  expect(f.state().decisions[0]?.resolution).toMatchObject({
    via: "delegated",
    resolved_by: "system",
    option: "merge",
  });
  expect(
    cardDetail(f.state(), scenario.card.id)?.timeline.some(
      (e) =>
        e.decision_via === "delegated" && e.body.includes("自动合并（代批）"),
    ),
  ).toBe(true);
  await loop().tick();
  expect(
    f.state().events.filter((e) => e.type === "decision_resolved"),
  ).toHaveLength(1);
  expect(f.state().events.filter((e) => e.type === "card_merged")).toHaveLength(
    1,
  );
});
