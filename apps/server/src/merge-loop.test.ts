/**
 * M4.4 merge execution loop (plan §4 M4.4, development plan §12.5).
 *
 * Real Git in temporary repositories, real domain commands in a real Store:
 * `ServerGit` runs the real central repository and the assertions are on refs,
 * commits and events, so nothing about the merge itself is mocked.
 */
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  completeHumanAction,
  heldByMergeWindow,
  latestMergeCheck,
  mergeBatches,
  prepareMergePlan,
  recordDecision,
  recordMergeResult,
  requestHumanAction,
  setCardSensitive,
  setMergeWindow,
  setProjectPreferences,
  updateCard,
} from "@cardigan/domain";
import {
  type CentralProject,
  CentralRepositoryService,
} from "@cardigan/git-service";
import { CentralGitTransport } from "@cardigan/git-transport";
import {
  fenceLongOperations,
  liveLongOperations,
  loadMergeGateConfig,
  releaseLongOperationFence,
  runInTemporaryCheckout,
} from "@cardigan/host";
import {
  authenticate,
  getCardTool,
  loadCommandState,
  persistEffect,
  unwrap,
} from "@cardigan/mcp-server";
import { CheckHandoffs, Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { deploymentMergeSegments } from "../../../packages/host/src/deployment-audit.js";
import { createProcessIo, main } from "../../cli/src/index.js";
import { ServerGit } from "./git.js";
import {
  acceptThroughMergeGate,
  type M4Fixture,
  m4Fixture,
  m4Scenario,
  mergeConfirmation,
} from "./m4-fixtures.js";
import { MergeExecutor, startMergeLoop } from "./merge-loop.js";
import { withPublication } from "./publication-lock.js";
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
}, 30_000);

test("C-799: a card merge registers its running Git step for restarts; under a restart fence it neither starts nor records a failure", async () => {
  const scenario = m4Scenario(f, "auto");
  const sha = agentCommit("agent/C-1/W-1", "feature.txt", "feature\n");
  const { product } = await acceptThroughMergeGate(f, scenario, sha);
  await pin(product.id, sha);
  const serverGit = new ServerGit({ store: f.store, dataDir: f.dataDir });
  const during: unknown[] = [];
  const sync = serverGit.sync.bind(serverGit);
  serverGit.sync = async (p) => {
    during.push(liveLongOperations(f.store));
    return sync(p);
  };
  const loop = new MergeExecutor({ store: f.store, git: serverGit });
  // A restart decision fenced new managed operations first.
  fenceLongOperations(f.store);
  await loop.tick(f.project_id);
  await loop.tick(f.project_id);
  expect(during).toEqual([]);
  expect(await baseline()).toBe(repos.base);
  expect(f.card().status).toBe("awaiting_merge");
  expect(f.state().events.filter((e) => e.type === "merge_failed")).toEqual([]);
  releaseLongOperationFence(f.store);
  await loop.tick(f.project_id);
  // While it synced, the step was registered with its card and stage.
  expect(during).toEqual([
    [
      expect.objectContaining({
        kind: "merge_step",
        project_id: f.project_id,
        card_id: scenario.card.id,
        label: `合并 ${scenario.card.id} 的「同步源仓库」`,
      }),
    ],
  ]);
  expect(f.card().status).toBe("done");
}, 30_000);

test("a persisted handoff cannot be bypassed by restarting without gate configuration", async () => {
  const scenario = m4Scenario(f, "auto");
  const sha = agentCommit("agent/C-1/W-1", "feature.txt", "feature\n");
  const { product } = await acceptThroughMergeGate(f, scenario, sha);
  await pin(product.id, sha);
  const facts = new CheckHandoffs(f.store, "fixture-controller");
  facts.begin(f.project_id, "previous-executor", "fixed");
  await executor().tick(f.project_id);
  expect(await baseline()).toBe(repos.base);
  expect(f.card().status).toBe("awaiting_merge");
  facts.resume(f.project_id, "previous-executor", 1, "fixture exact proof");
  await executor().tick(f.project_id);
  expect(f.card().status).toBe("done");
}, 30_000);

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
}, 30_000);

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
}, 30_000);

test("C-112: skips are logged once per reason, read-only human actions do not hold the merge, merge-blocking ones are named", async () => {
  const scenario = m4Scenario(f, "confirm");
  const sha = agentCommit("agent/C-1/W-1", "feature.txt", "feature\n");
  const { product } = await acceptThroughMergeGate(f, scenario, sha);
  await pin(product.id, sha);
  const notices: string[] = [];
  const loop = new MergeExecutor({
    store: f.store,
    git: new ServerGit({ store: f.store, dataDir: f.dataDir }),
    report: (message) => notices.push(message),
  });
  const skips = () => notices.filter((m) => m.includes("merge loop skipped"));
  await loop.tick(f.project_id);
  await loop.tick(f.project_id);
  expect(skips()).toHaveLength(1);
  expect(skips()[0]).toContain(scenario.card.id);
  expect(skips()[0]).toContain("Merge confirmation has not been granted");

  const ask = (blocks_merge: boolean) =>
    f.apply((s, a, p) =>
      requestHumanAction(
        s,
        a,
        {
          card_id: scenario.card.id,
          instructions: "请查看主机日志",
          why_human: "只有主机能看",
          // C-742: the owner performs these actions.
          executor: "owner",
          expected_return: "日志摘要",
          blocked_work_items: [],
          ...(blocks_merge
            ? { blocks_merge, prerequisite: "credential" as const }
            : {}),
        },
        p,
      ),
    );
  ask(false);
  const confirmation = mergeConfirmation(f, scenario.card.id);
  if (!confirmation) throw new Error("Missing confirmation");
  f.apply((s, a, p) =>
    recordDecision(
      s,
      a,
      {
        decision_id: confirmation.id,
        option: "merge",
        rationale: "已核实",
        raw_quote: "已核实",
      },
      p,
    ),
  );
  // C-760: a hold raised after the confirmation still holds the merge
  // (an override can no longer pass one silently).
  const blocking = ask(true);
  await loop.tick(f.project_id);
  await loop.tick(f.project_id);
  expect(skips()).toHaveLength(2);
  expect(skips()[1]).toContain(blocking.id);
  expect(
    f.state().events.filter((e) => e.type === "merge_check_blocked"),
  ).toHaveLength(1);
  expect(f.card().status).toBe("awaiting_merge");

  // Only the read-only action remains open: the card merges.
  f.apply((s, a, p) =>
    completeHumanAction(
      s,
      a,
      { human_action_id: blocking.id, text: "Done" },
      p,
    ),
  );
  await loop.tick(f.project_id);
  expect(f.card().status).toBe("done");
  expect(
    f.state().human_actions.filter((h) => h.status === "open"),
  ).toHaveLength(1);
  expect(skips()).toHaveLength(2);
  expect(
    f.state().events.filter((e) => e.type === "merge_check_unblocked"),
  ).toHaveLength(1);
}, 30_000);

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
}, 30_000);

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
}, 30_000);

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
}, 30_000);

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
}, 30_000);

test("C-589: cards on main and on another baseline branch merge into their own branches", async () => {
  const farm = "integration/farm";
  git(repos.source, "checkout", "-q", "-b", farm);
  const farmBase = commit(repos.source, "farm.txt", "farm\n");
  git(repos.source, "checkout", "-q", "main");
  const onMain = m4Scenario(f, "auto"),
    onFarm = m4Scenario(f, "auto", farm);
  const mainSha = agentCommit("agent/C-1/W-1", "main.txt", "main\n");
  git(repos.agent, "fetch", "-q", "origin");
  git(repos.agent, "checkout", "-q", "-B", "agent/C-3/W-4", `origin/${farm}`);
  const farmSha = commit(repos.agent, "feature.txt", "feature\n");
  git(repos.agent, "checkout", "-q", "main");
  const mainDelivery = await acceptThroughMergeGate(f, onMain, mainSha);
  await pin(mainDelivery.product.id, mainSha);
  const farmDelivery = await acceptThroughMergeGate(f, onFarm, farmSha);
  await pin(farmDelivery.product.id, farmSha);
  await executor().tick(f.project_id);

  expect(f.card(onMain.card.id).status).toBe("done");
  expect(f.card(onFarm.card.id).status).toBe("done");
  expect(
    f.state().events.filter((event) => event.type === "merge_failed"),
  ).toEqual([]);
  const repository = await central.ensureCentral(project);
  const farmTip = git(repository, "rev-parse", `refs/heads/${farm}`),
    mainTip = (await baseline()) as string;
  expect(git(repository, "rev-parse", `${farmTip}^1`)).toBe(farmBase);
  expect(git(repository, "rev-parse", `${farmTip}^2`)).toBe(farmSha);
  expect(git(repository, "rev-parse", `${mainTip}^1`)).toBe(repos.base);
  expect(git(repository, "rev-parse", `${mainTip}^2`)).toBe(mainSha);
  const merged = f
    .state()
    .events.filter((event) => event.type === "card_merged")
    .map((event) => [
      event.card_id,
      (event.payload as { result: { previous_sha: string } }).result
        .previous_sha,
    ]);
  expect(merged).toEqual(
    expect.arrayContaining([
      [onMain.card.id, repos.base],
      [onFarm.card.id, farmBase],
    ]),
  );
  // Central-only merges never write the registered source.
  expect(git(repos.source, "rev-parse", farm)).toBe(farmBase);
  expect(git(repos.source, "rev-parse", "main")).toBe(repos.base);
}, 30_000);

test("C-589: a missing card branch records the failing step and a redacted reason", async () => {
  const scenario = m4Scenario(f, "auto", "integration/missing");
  const sha = agentCommit("agent/C-1/W-1", "feature.txt", "feature\n");
  const { product } = await acceptThroughMergeGate(f, scenario, sha);
  await pin(product.id, sha);
  await executor().tick(f.project_id);
  expect(f.card().status).toBe("awaiting_merge");
  const failed = f
    .state()
    .events.filter((event) => event.type === "merge_failed");
  expect(failed).toHaveLength(1);
  const reason = (
    failed[0]?.payload as { result?: { reason?: string } } | undefined
  )?.result?.reason;
  expect(reason).toContain(`合并 ${scenario.card.id} 在「同步源仓库」环节失败`);
  expect(reason).not.toContain(f.dataDir);
  expect(reason).not.toContain(repos.root);
  expect(await baseline()).toBe(repos.base);
}, 30_000);

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
}, 30_000);

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
    remaining_ms: 10 * 60_000,
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
        blocks_merge: true,
        prerequisite: "external_account" as const,
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
}, 30_000);

test("C-69: unmarking restarts the timeout from the unmark, and a restarted server agrees", async () => {
  const scenario = m4Scenario(f, "confirm");
  const sha = agentCommit("agent/C-1/W-1", "c69.txt", "c69 feature\n");
  const { product } = await acceptThroughMergeGate(f, scenario, sha);
  await pin(product.id, sha);
  f.apply((s, a, p) =>
    setProjectPreferences(s, a, { auto_merge_after_minutes: 10 }, p),
  );
  const start = Date.parse(f.clock.now());
  const at = (minutes: number) =>
    new Date(start + minutes * 60_000).toISOString();
  const flag = (sensitive: boolean, minutes: number) =>
    f.store.uow.run((tx) => {
      const effect = unwrap(
        setCardSensitive(
          loadCommandState(tx, f.project_id),
          { kind: "human", project_id: f.project_id },
          { card_id: scenario.card.id, sensitive },
          { clock: { now: () => at(minutes) }, ids: tx.ids },
        ),
      );
      persistEffect(tx, f.project_id, effect);
    });
  const tick = (store: Store, minutes: number) =>
    new MergeExecutor({
      store,
      git: new ServerGit({ store, dataDir: f.dataDir }),
      clock: { now: () => at(minutes) },
    }).tick();
  flag(true, 1);
  await tick(f.store, 20);
  expect(f.card().status).toBe("awaiting_merge");
  // Unmarked at +30, long after the original +10 deadline.
  flag(false, 30);
  await tick(f.store, 30);
  expect(f.card().status).toBe("awaiting_merge");
  expect(needsYou(f.state(), at(30)).decisions[0]?.auto_merge).toEqual({
    minutes: 10,
    due_at: at(40),
    // C-154: the page counts down from the restarted due time.
    remaining_ms: 10 * 60_000,
  });
  // A fresh Store over the same data directory computes the same due time.
  const restarted = Store.open({ dataDir: f.dataDir, clock: f.clock });
  try {
    await tick(restarted, 39.99);
    expect(f.card().status).toBe("awaiting_merge");
    await tick(restarted, 40);
  } finally {
    restarted.close();
  }
  expect(f.card().status).toBe("done");
  expect(
    JSON.parse(f.state().decisions[0]?.resolution?.proxy_authority ?? ""),
  ).toMatchObject({ waiting_since: at(30), due_at: at(40) });
}, 30_000);

async function gated(run = "true", queue = false) {
  writeFileSync(
    join(repos.root, "merge-gate.yaml"),
    JSON.stringify({
      projects: {
        [f.project_id]: {
          checks: [{ name: "test", run }],
          ...(queue ? { queue: { enabled: true } } : {}),
        },
      },
    }),
    { mode: 0o600 },
  );
  const configuration = await loadMergeGateConfig({
    configDir: repos.root,
    projectIds: [f.project_id],
  });
  const errors: unknown[] = [];
  const binding = new ServerGit({ store: f.store, dataDir: f.dataDir });
  const options = {
    store: f.store,
    git: binding,
    gate: {
      configuration,
      execution: { mode: "local" as const, dataDir: f.dataDir },
    },
    onError: (error: unknown) => errors.push(error),
  };
  const cli = (...args: string[]) =>
    main(args, {
      ...createProcessIo(),
      env: { CARDIGAN_DATA_DIR: f.dataDir, CARDIGAN_CONFIG_DIR: repos.root },
      stdout: () => {},
      stderr: () => {},
    });
  return { options, errors, binding, cli };
}

test("a conflict before confirmation atomically supersedes the old question and permits a new completion", async () => {
  const scenario = m4Scenario(f, "confirm");
  const sha = agentCommit("agent/C-1/W-1", "README.md", "agent change\n");
  const { product, completion } = await acceptThroughMergeGate(
    f,
    scenario,
    sha,
  );
  await pin(product.id, sha);
  commit(repos.source, "README.md", "baseline change\n");
  const decision = mergeConfirmation(f, scenario.card.id);
  if (!decision) throw new Error("Missing confirmation");
  expect(
    needsYou(f.state(), f.clock.now()).decisions.map((q) => q.id),
  ).toContain(decision.id);

  const before = f.state();
  expect(() =>
    f.store.uow.run((tx) => {
      const effect = unwrap(
        recordMergeResult(
          loadCommandState(tx, f.project_id, { merge_gate_enabled: true }),
          { kind: "system", project_id: f.project_id },
          {
            card_id: scenario.card.id,
            completion_id: completion.id,
            result: {
              kind: "conflicted",
              delivery_id: product.id,
              files: ["README.md"],
            },
          },
          { clock: f.clock, ids: tx.ids },
        ),
      );
      persistEffect(tx, f.project_id, effect);
      throw new Error("Abort invalidation transaction");
    }),
  ).toThrow("Abort invalidation transaction");
  expect(f.state()).toEqual(before);

  const c = await gated();
  const loop = new MergeExecutor(c.options);
  await loop.tick();
  expect(c.errors).toEqual([]);
  expect(f.card(scenario.card.id).status).toBe("in_progress");
  expect(f.state().deliveries.find((v) => v.id === completion.id)?.status).toBe(
    "superseded",
  );
  expect(mergeConfirmation(f, scenario.card.id)).toEqual({
    ...decision,
    status: "superseded",
  });
  expect(
    needsYou(f.state(), f.clock.now()).decisions.map((q) => q.id),
  ).not.toContain(decision.id);
  expect(f.state().timeline).toContainEqual(
    expect.objectContaining({
      type: "system",
      author: "system",
      decision_id: decision.id,
      delivery_id: completion.id,
      body: expect.stringContaining("自动标记为已被取代"),
    }),
  );
  await loop.tick();
  expect(
    f.state().events.filter((e) => e.type === "decision_superseded"),
  ).toHaveLength(1);

  const repaired = agentCommit("agent/C-1/W-1", "feature.txt", "repaired\n");
  const next = await acceptThroughMergeGate(f, scenario, repaired);
  expect(mergeConfirmation(f, scenario.card.id)).toMatchObject({
    status: "open",
    target: { delivery_id: next.completion.id },
  });
  expect(needsYou(f.state(), f.clock.now()).decisions).toHaveLength(1);
}, 30_000);

test("real checks fail, CLI requeues, and a restart publishes the checked tree after human confirmation", async () => {
  const scenario = m4Scenario(f, "confirm");
  const sha = agentCommit("agent/C-1/W-1", "feature.txt", "checked feature\n");
  const { product, completion } = await acceptThroughMergeGate(
    f,
    scenario,
    sha,
  );
  await pin(product.id, sha);
  const marker = join(repos.root, "allow-check");
  const c = await gated(
    `test -f '${marker}' && test "$(cat feature.txt)" = 'checked feature'`,
  );
  const check = () =>
    latestMergeCheck(f.state().events, scenario.card.id, completion.id);
  const loop = new MergeExecutor(c.options);
  await loop.tick();
  expect(check()?.status).toBe("failed");
  const token = f.store.issueToken({
    project_id: f.project_id,
    assignment_id: scenario.coder.id,
    role: {
      role_version: scenario.coder.role_version,
      allowed_tools: ["get_card"],
    },
  });
  const view = await getCardTool.handler(
    { card_id: scenario.card.id },
    { store: f.store, identity: unwrap(authenticate(f.store, token.token)) },
  );
  expect(view).toMatchObject({
    card: { merge_check: { status: "failed", completion_id: completion.id } },
  });
  expect(await baseline()).toBe(repos.base);
  const failedAttempt = check()?.attempt_id;
  await loop.tick();
  expect(check()?.attempt_id).toBe(failedAttempt);
  writeFileSync(marker, "ready");
  expect(await c.cli("merge", "recheck", scenario.card.id)).toBe(0);
  await loop.tick();
  expect(check()?.status).toBe("passed");
  expect(check()?.attempt_id).not.toBe(failedAttempt);
  expect(await baseline()).toBe(repos.base);
  expect(
    readFileSync(
      join(
        f.dataDir,
        "merge-gate",
        "logs",
        f.project_id,
        `${check()?.attempt_id}.log`,
      ),
      "utf8",
    ),
  ).toContain("没有 Agent 账号隔离");
  expect(readdirSync(join(f.dataDir, "agent", "checks", f.project_id))).toEqual(
    [],
  );
  expect(await c.cli("merge", "confirm", scenario.card.id)).toBe(0);
  await new MergeExecutor(c.options).tick();
  expect(f.card().status).toBe("done");
  const merged = await baseline();
  expect(
    git(await central.ensureCentral(project), "rev-parse", `${merged}^{tree}`),
  ).toBe(check()?.tree_sha);
  await new MergeExecutor(c.options).tick();
  expect(await baseline()).toBe(merged);
  expect(f.state().events.filter((e) => e.type === "card_merged")).toHaveLength(
    1,
  );
  expect(c.errors).toEqual([]);
}, 30_000);

test("C-589: the merge gate checks and publishes a card on another baseline branch", async () => {
  const farm = "integration/farm";
  git(repos.source, "checkout", "-q", "-b", farm);
  const farmBase = commit(repos.source, "farm.txt", "farm\n");
  git(repos.source, "checkout", "-q", "main");
  const scenario = m4Scenario(f, "auto", farm);
  git(repos.agent, "fetch", "-q", "origin");
  git(repos.agent, "checkout", "-q", "-B", "agent/C-1/W-1", `origin/${farm}`);
  const sha = commit(repos.agent, "feature.txt", "checked feature\n");
  git(repos.agent, "checkout", "-q", "main");
  const { product, completion } = await acceptThroughMergeGate(
    f,
    scenario,
    sha,
  );
  await pin(product.id, sha);
  // The checked tree contains the farm baseline, not only main.
  const c = await gated(
    `test "$(cat farm.txt)" = 'farm' && test "$(cat feature.txt)" = 'checked feature'`,
  );
  await new MergeExecutor(c.options).tick();
  const check = latestMergeCheck(
    f.state().events,
    scenario.card.id,
    completion.id,
  );
  expect(check).toMatchObject({ status: "passed", base_sha: farmBase });
  await new MergeExecutor(c.options).tick();
  expect(f.card().status).toBe("done");
  const repository = await central.ensureCentral(project);
  const tip = git(repository, "rev-parse", `refs/heads/${farm}`);
  expect(git(repository, "rev-parse", `${tip}^{tree}`)).toBe(check?.tree_sha);
  expect(git(repository, "rev-parse", `${tip}^1`)).toBe(farmBase);
  expect(await baseline()).toBe(repos.base);
  expect(f.state().events.filter((e) => e.type === "merge_failed")).toEqual([]);
  expect(c.errors).toEqual([]);
}, 30_000);

test("C-589: a gated publication error is attributed to publication, not to checks", async () => {
  const scenario = m4Scenario(f, "auto");
  const sha = agentCommit("agent/C-1/W-1", "feature.txt", "feature\n");
  const { product, completion } = await acceptThroughMergeGate(
    f,
    scenario,
    sha,
  );
  await pin(product.id, sha);
  const c = await gated();
  vi.spyOn(c.binding, "publish").mockRejectedValue(
    new Error(`fixture publish I/O error in ${f.dataDir}/central`),
  );
  await new MergeExecutor(c.options).tick();
  await new MergeExecutor(c.options).tick();
  expect(
    latestMergeCheck(f.state().events, scenario.card.id, completion.id)?.status,
  ).toBe("passed");
  const reasons = f
    .state()
    .events.filter((e) => e.type === "merge_failed")
    .map((e) => (e.payload as { result?: { reason?: string } }).result?.reason);
  expect(reasons).toEqual([
    `合并 ${scenario.card.id} 在「发布合并」环节失败：fixture publish I/O error in <路径>。未发布未经检查的代码`,
  ]);
  expect(f.card().status).toBe("awaiting_merge");
  expect(await baseline()).toBe(repos.base);
}, 30_000);

test("an invalid configured gate blocks both execution and CLI recheck", async () => {
  const scenario = m4Scenario(f, "auto");
  const sha = agentCommit("agent/C-1/W-1", "feature.txt", "feature\n");
  const { product } = await acceptThroughMergeGate(f, scenario, sha);
  await pin(product.id, sha);
  const c = await gated();
  writeFileSync(join(repos.root, "merge-gate.yaml"), "projects: [invalid]");
  const configuration = await loadMergeGateConfig({
    configDir: repos.root,
    projectIds: [f.project_id],
  });
  await new MergeExecutor({
    ...c.options,
    gate: { ...c.options.gate, configuration },
  }).tick();
  expect(f.card().status).toBe("awaiting_merge");
  expect(await baseline()).toBe(repos.base);
  expect(await c.cli("merge", "recheck", scenario.card.id)).not.toBe(0);
  rmSync(join(repos.root, "merge-gate.yaml"));
  expect(await c.cli("merge", "recheck", scenario.card.id)).not.toBe(0);
}, 30_000);

test("stopping the long-lived loop cancels a real check and records interruption before returning", async () => {
  const scenario = m4Scenario(f, "auto");
  const sha = agentCommit("agent/C-1/W-1", "feature.txt", "feature\n");
  const { product, completion } = await acceptThroughMergeGate(
    f,
    scenario,
    sha,
  );
  await pin(product.id, sha);
  // The check's fixed PATH need not contain the Node running this test.
  const node = `'${process.execPath.replaceAll("'", "'\\''")}'`;
  const c = await gated(
    `exec ${node} -e 'console.log("check-ready"); setInterval(()=>{},1000)'`,
  );
  let output = "";
  const loop = startMergeLoop({
    ...c.options,
    intervalMs: 60_000,
    gate: {
      ...c.options.gate,
      run: (input) =>
        runInTemporaryCheckout({
          ...input,
          onOutput: (name, text) => {
            input.onOutput?.(name, text);
            if (name === "test") output += text;
          },
        }),
    },
  });
  try {
    // `running` means the supervisor is ready, before checkout or command startup.
    // Wait for the real check's output so shutdown must cancel a live command.
    await vi.waitFor(() => expect(output).toBe("check-ready\n"), {
      timeout: 5000,
    });
    expect(
      latestMergeCheck(f.state().events, scenario.card.id, completion.id)
        ?.status,
    ).toBe("running");
  } finally {
    await loop.loop.stop();
  }
  await loop.loop.done;
  expect(
    latestMergeCheck(f.state().events, scenario.card.id, completion.id),
  ).toMatchObject({
    status: "interrupted",
    checks: [{ name: "test", status: "interrupted", exit_code: null }],
  });
  expect(await baseline()).toBe(repos.base);
  expect(readdirSync(join(f.dataDir, "agent", "checks", f.project_id))).toEqual(
    [],
  );
  expect(c.errors).toEqual([]);
}, 30_000);

test("the host refuses a forged checked tree before publishing any candidate", async () => {
  const scenario = m4Scenario(f, "auto");
  const sha = agentCommit("agent/C-1/W-1", "feature.txt", "new tree\n");
  const { product } = await acceptThroughMergeGate(f, scenario, sha);
  await pin(product.id, sha);
  const c = await gated(),
    plan = unwrap(prepareMergePlan(f.state(), scenario.card.id));
  const candidate = await c.binding.prepare(project, plan);
  if (candidate.status !== "candidate") throw new Error("Missing candidate");
  const repository = await central.ensureCentral(project);
  const realTree = git(
    repository,
    "rev-parse",
    `${candidate.candidate_sha}^{tree}`,
  );
  expect(candidate.tree_sha).toBe(realTree);
  const forgedTree = git(repository, "rev-parse", `${repos.base}^{tree}`);
  expect(forgedTree).not.toBe(realTree);
  await expect(
    c.binding.publish(project, plan.completion_id, {
      ...candidate,
      tree_sha: forgedTree,
    }),
  ).rejects.toThrow(/tree does not match/);
  expect(await baseline()).toBe(repos.base);
  await expect(
    c.binding.publish(project, plan.completion_id, candidate),
  ).resolves.toMatchObject({ status: "merged", tree_sha: realTree });
}, 30_000);

test("a real Git-verified noop skips checks but still waits for the completion's human confirmation", async () => {
  const scenario = m4Scenario(f, "confirm");
  const sha = agentCommit(
    "agent/C-1/W-1",
    "feature.txt",
    "already incorporated\n",
  );
  const { product, completion } = await acceptThroughMergeGate(
    f,
    scenario,
    sha,
  );
  await pin(product.id, sha);
  const plan = unwrap(prepareMergePlan(f.state(), scenario.card.id));
  // Simulate the central publication surviving a controller crash before its
  // domain result. No domain rows or flags are patched to manufacture noop.
  const incorporated = await central.mergeIntoBase(project, plan);
  if (incorporated.status !== "merged") throw new Error("Missing merge");
  const c = await gated("exit 99");
  const prepared = await c.binding.prepare(project, plan);
  expect(prepared).toEqual({
    status: "noop",
    branch_sha: incorporated.merge_sha,
  });
  const repository = await central.ensureCentral(project);
  for (const delivery of plan.deliveries)
    expect(
      git(
        repository,
        "merge-base",
        "--is-ancestor",
        delivery.sha,
        incorporated.merge_sha,
      ),
    ).toBe("");
  await new MergeExecutor(c.options).tick();
  expect(f.card().status).toBe("awaiting_merge");
  expect(await c.cli("merge", "confirm", scenario.card.id)).toBe(0);
  await new MergeExecutor(c.options).tick();
  expect(f.card().status).toBe("done");
  expect(await baseline()).toBe(incorporated.merge_sha);
  expect(
    latestMergeCheck(f.state().events, scenario.card.id, completion.id),
  ).toBeUndefined();
  expect(
    f.state().events.find((e) => e.type === "card_merged")?.payload,
  ).toMatchObject({
    completion_id: completion.id,
    result: {
      kind: "merged",
      noop: true,
      merge_sha: incorporated.merge_sha,
      previous_sha: incorporated.merge_sha,
    },
  });
  expect(c.errors).toEqual([]);
}, 30_000);

test("a due delegated confirmation cannot publish a failed gate; rechecking can complete without another approval", async () => {
  const scenario = m4Scenario(f, "confirm");
  const sha = agentCommit(
    "agent/C-1/W-1",
    "timeout-gate.txt",
    "checked after delegation\n",
  );
  const { product, completion } = await acceptThroughMergeGate(
    f,
    scenario,
    sha,
  );
  await pin(product.id, sha);
  f.apply((s, a, p) =>
    setProjectPreferences(s, a, { auto_merge_after_minutes: 1 }, p),
  );
  const marker = join(repos.root, "pass-delegated-check");
  const c = await gated(`test -f '${marker}'`);
  const loop = new MergeExecutor({
    ...c.options,
    clock: {
      now: () => new Date(Date.parse(f.clock.now()) + 60_000).toISOString(),
    },
  });
  const check = () =>
    latestMergeCheck(f.state().events, scenario.card.id, completion.id);
  await loop.tick();
  expect(mergeConfirmation(f, scenario.card.id)?.resolution).toMatchObject({
    via: "delegated",
    resolved_by: "system",
    option: "merge",
  });
  expect(check()?.status).toBe("failed");
  expect(f.card().status).toBe("awaiting_merge");
  expect(await baseline()).toBe(repos.base);
  expect(f.state().events.filter((e) => e.type === "card_merged")).toHaveLength(
    0,
  );
  await loop.tick();
  expect(
    f.state().events.filter((e) => e.type === "merge_check_queued"),
  ).toHaveLength(1);
  writeFileSync(marker, "ready");
  expect(await c.cli("merge", "recheck", scenario.card.id)).toBe(0);
  await loop.tick();
  expect(check()?.status).toBe("passed");
  expect(f.card().status).toBe("done");
  expect(await baseline()).not.toBe(repos.base);
  expect(
    f.state().events.filter((e) => e.type === "decision_resolved"),
  ).toHaveLength(1);
  expect(f.state().events.filter((e) => e.type === "card_merged")).toHaveLength(
    1,
  );
  expect(c.errors).toEqual([]);
}, 30_000);

test("delegation while a check is running leaves the baseline untouched until its passed result", async () => {
  const scenario = m4Scenario(f, "confirm");
  const sha = agentCommit(
    "agent/C-1/W-1",
    "running-gate.txt",
    "wait for checks\n",
  );
  const { product, completion } = await acceptThroughMergeGate(
    f,
    scenario,
    sha,
  );
  await pin(product.id, sha);
  f.apply((s, a, p) =>
    setProjectPreferences(s, a, { auto_merge_after_minutes: 1 }, p),
  );
  const c = await gated(),
    ready = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>();
  const loop = new MergeExecutor({
    ...c.options,
    clock: {
      now: () => new Date(Date.parse(f.clock.now()) + 60_000).toISOString(),
    },
    gate: {
      ...c.options.gate,
      run: async (input) => {
        input.onReady?.();
        ready.resolve();
        await finish.promise;
        return {
          status: "passed",
          checks: [{ name: "test", status: "passed", exit_code: 0 }],
          cleanup_errors: [],
        };
      },
    },
  });
  const pending = loop.tick();
  try {
    await ready.promise;
    expect(mergeConfirmation(f, scenario.card.id)?.resolution?.via).toBe(
      "delegated",
    );
    expect(
      latestMergeCheck(f.state().events, scenario.card.id, completion.id)
        ?.status,
    ).toBe("running");
    expect(await baseline()).toBe(repos.base);
    expect(f.card().status).toBe("awaiting_merge");
  } finally {
    finish.resolve();
    await pending;
  }
  expect(f.card().status).toBe("done");
  expect(c.errors).toEqual([]);
}, 30_000);

test("publication rechecks the human sensitive flag after sync before touching the baseline", async () => {
  const scenario = m4Scenario(f, "confirm");
  const sha = agentCommit("agent/C-1/W-1", "role-check.txt", "feature\n");
  const { product } = await acceptThroughMergeGate(f, scenario, sha);
  await pin(product.id, sha);
  const q = mergeConfirmation(f, scenario.card.id)!;
  f.decide(q as never, "merge");
  // Synthetic proxy consent isolates the host's async publication boundary;
  // real Git refs remain the observable publication result.
  f.store.uow.run((tx) => {
    const current = tx.decisions.get(f.project_id, q.id)!;
    tx.decisions.put(f.project_id, {
      ...current,
      resolution: {
        ...current.resolution!,
        resolved_by: "assignment:A-999",
        via: "delegated",
      },
    });
  });
  const serverGit = new ServerGit({ store: f.store, dataDir: f.dataDir });
  const sync = serverGit.sync.bind(serverGit);
  vi.spyOn(serverGit, "sync").mockImplementation(async (p) => {
    const result = await sync(p);
    f.store.uow.run((tx) => {
      const card = tx.cards.list(f.project_id)[0];
      if (!card) throw new Error("Missing card");
      tx.cards.put(f.project_id, { ...card, sensitive: true });
      const v = tx.deliveries.get(f.project_id, product.id)!;
      tx.deliveries.put(f.project_id, {
        ...v,
        evidence: [
          {
            kind: "diff",
            details: {
              role_rule_inventory: {
                version: 1,
                base_sha: repos.base,
                sha,
                tree_sha: "e".repeat(40),
                complete: false,
                changes: [],
              },
            },
          },
        ],
      });
    });
    return result;
  });
  await new MergeExecutor({ store: f.store, git: serverGit }).tick(
    f.project_id,
  );
  expect(await baseline()).toBe(repos.base);
  expect(f.card().status).toBe("awaiting_merge");
  expect(f.state().events.some((e) => e.type === "card_merged")).toBe(false);
}, 30_000);

async function queuedCards(count: number, bad = 0) {
  const cards = [];
  for (let i = 1; i <= count; i++) {
    const scenario = m4Scenario(f, "auto");
    const sha = agentCommit(
      `batch-${i}`,
      i === bad ? "bad.txt" : `card-${i}.txt`,
      `card ${i}\n`,
    );
    const { product } = await acceptThroughMergeGate(f, scenario, sha);
    await pin(product.id, sha);
    cards.push(scenario.card.id);
  }
  return cards;
}

test("C-391: three approved cards share one final-tree check, one CAS and auditable per-card merges", async () => {
  const cards = await queuedCards(3),
    { options, errors, binding } = await gated("true", true);
  const run = vi.fn(runInTemporaryCheckout),
    publish = vi.spyOn(binding, "publishBatch");
  const cas = vi.spyOn(CentralGitTransport.prototype, "compareAndSwapRef");
  const executor = new MergeExecutor({
    ...options,
    gate: { ...options.gate, run },
  });
  await executor.tick(); // Three independent card checks.
  expect(run).toHaveBeenCalledTimes(3);
  await executor.tick(); // One batch check.
  expect(run).toHaveBeenCalledTimes(4);
  await executor.tick(); // Atomic publication.
  expect(errors).toEqual([]);
  expect(publish).toHaveBeenCalledTimes(1);
  expect(cas.mock.calls.filter((c) => c[1] === "refs/heads/main")).toHaveLength(
    1,
  );
  expect(
    cards.every(
      (id) => f.state().cards.find((c) => c.id === id)?.status === "done",
    ),
  ).toBe(true);
  const batch = mergeBatches(f.state().events)[0];
  expect(batch?.status).toBe("published");
  if (!batch) throw new Error("Missing batch");
  expect(
    git(
      central.repositoryPath(project),
      "rev-list",
      "--first-parent",
      "--count",
      `${repos.base}..main`,
    ),
  ).toBe("3");
  expect(
    await deploymentMergeSegments(
      f.store,
      f.project_id,
      repos.base,
      batch.final_sha,
    ),
  ).toEqual([
    { sha: batch.final_sha, previous: repos.base, tree: batch.final_tree_sha },
  ]);
}, 20_000);

test("C-589: a queue branch that cannot sync records its step; other branches still batch and publish", async () => {
  const farm = "integration/farm";
  git(repos.source, "checkout", "-q", "-b", farm);
  const farmBase = commit(repos.source, "farm.txt", "farm\n");
  git(repos.source, "checkout", "-q", "main");
  const [onMain] = await queuedCards(1);
  const onFarm = m4Scenario(f, "auto", farm);
  git(repos.agent, "fetch", "-q", "origin");
  git(repos.agent, "checkout", "-q", "-B", "batch-farm", `origin/${farm}`);
  const farmSha = commit(repos.agent, "farm-card.txt", "farm card\n");
  git(repos.agent, "checkout", "-q", "main");
  const delivered = await acceptThroughMergeGate(f, onFarm, farmSha);
  await pin(delivered.product.id, farmSha);
  const { options, binding } = await gated("true", true);
  let broken = false;
  const sync = binding.sync.bind(binding);
  vi.spyOn(binding, "sync").mockImplementation(async (view) => {
    if (broken && view.base_branch === "main")
      throw new Error(`fixture outage at ${repos.root}/central`);
    return sync(view);
  });
  const executor = new MergeExecutor(options);
  await executor.tick(); // Independent card checks on both branches.
  broken = true;
  await executor.tick(); // main cannot sync; the farm card still forms a batch.
  await executor.tick(); // Batch check and publication.
  await executor.tick();
  const card = (id: string | undefined) =>
    f.state().cards.find((c) => c.id === id);
  expect(card(onFarm.card.id)?.status).toBe("done");
  expect(card(onMain)?.status).toBe("awaiting_merge");
  const failed = f
    .state()
    .events.filter((e) => e.type === "merge_failed")
    .map((e) => [
      e.card_id,
      (e.payload as { result?: { reason?: string } }).result?.reason,
    ]);
  expect(failed).toEqual([
    [
      onMain,
      expect.stringContaining(`合并 ${onMain} 在「同步源仓库」环节失败`),
    ],
  ]);
  expect(JSON.stringify(failed)).not.toContain(repos.root);
  const repository = await central.ensureCentral(project);
  expect(git(repository, "rev-parse", `refs/heads/${farm}^1`)).toBe(farmBase);
  expect(await baseline()).toBe(repos.base);
}, 30_000);

test("C-589: a passed batch stuck on an unreadable branch blocks only that branch", async () => {
  const farm = "integration/farm";
  git(repos.source, "checkout", "-q", "-b", farm);
  const farmBase = commit(repos.source, "farm.txt", "farm\n");
  git(repos.source, "checkout", "-q", "main");
  const [onMain] = await queuedCards(1);
  const { options, binding } = await gated("true", true);
  let broken = false;
  const sync = binding.sync.bind(binding);
  vi.spyOn(binding, "sync").mockImplementation(async (view) => {
    if (broken && view.base_branch === "main")
      throw new Error("fixture outage");
    return sync(view);
  });
  const executor = new MergeExecutor(options);
  await executor.tick(); // Card check.
  await executor.tick(); // Batch check; publication would follow next tick.
  const mainBatch = mergeBatches(f.state().events).find((b) =>
    b.members.some((m) => m.card_id === onMain),
  );
  expect(mainBatch?.status).toBe("passed");
  broken = true;
  const onFarm = m4Scenario(f, "auto", farm);
  git(repos.agent, "fetch", "-q", "origin");
  git(repos.agent, "checkout", "-q", "-B", "batch-farm", `origin/${farm}`);
  const farmSha = commit(repos.agent, "farm-card.txt", "farm card\n");
  git(repos.agent, "checkout", "-q", "main");
  const delivered = await acceptThroughMergeGate(f, onFarm, farmSha);
  await pin(delivered.product.id, farmSha);
  for (let i = 0; i < 5; i++) await executor.tick();
  const card = (id: string | undefined) =>
    f.state().cards.find((c) => c.id === id);
  expect(card(onFarm.card.id)?.status).toBe("done");
  expect(card(onMain)?.status).toBe("awaiting_merge");
  // The stuck family keeps its evidence for re-verification after recovery.
  expect(
    mergeBatches(f.state().events).find((b) => b.id === mainBatch?.id)?.status,
  ).toBe("passed");
  expect(
    f
      .state()
      .events.filter((e) => e.type === "merge_failed")
      .map((e) => [
        e.card_id,
        (e.payload as { result?: { reason?: string } }).result?.reason,
      ]),
  ).toEqual([
    [onMain, expect.stringContaining("「同步源仓库」环节失败：fixture outage")],
  ]);
  const repository = await central.ensureCentral(project);
  expect(git(repository, "rev-parse", `refs/heads/${farm}^1`)).toBe(farmBase);
  expect(await baseline()).toBe(repos.base);
  // After recovery the main batch is re-checked against the baseline and publishes.
  broken = false;
  for (let i = 0; i < 3; i++) await executor.tick();
  expect(card(onMain)?.status).toBe("done");
}, 40_000);

test("C-391: recovery records all cards after CAS succeeded but recording crashed", async () => {
  await queuedCards(3);
  const { options, binding, errors } = await gated("true", true);
  const executor = new MergeExecutor(options);
  await executor.tick();
  await executor.tick();
  const publish = binding.publishBatch.bind(binding);
  vi.spyOn(binding, "publishBatch").mockImplementationOnce(
    async (project, batch) => {
      await publish(project, batch);
      throw new Error("simulated crash after CAS");
    },
  );
  await executor.tick();
  expect(errors.map(String)).toContain("Error: simulated crash after CAS");
  errors.length = 0;
  expect(f.state().events.filter((e) => e.type === "card_merged")).toHaveLength(
    0,
  );
  expect(mergeBatches(f.state().events)[0]?.status).toBe("publishing");
  // C-466: recovery cannot proceed (or abort the publishing family as stale)
  // while a push is checking the publication record. Retry after it releases.
  const held = Promise.withResolvers<void>();
  const lock = withPublication(f.project_id, () => held.promise);
  try {
    await new MergeExecutor(options).tick();
    expect(mergeBatches(f.state().events)[0]?.status).toBe("publishing");
    expect(errors).toEqual([]);
  } finally {
    held.resolve();
    await lock;
  }
  await new MergeExecutor(options).tick();
  expect(errors).toEqual([]);
  expect(f.state().events.filter((e) => e.type === "card_merged")).toHaveLength(
    3,
  );
  expect(f.state().events.some((e) => e.type === "merge_batch_aborted")).toBe(
    false,
  );
}, 20_000);

test.each(
  [1, 2].flatMap((flow) => [1, 2, 3, 4].map((bad) => [flow, bad] as const)),
)(
  "C-391: flow %i batch-only failure at position %i publishes healthy cards",
  async (flow, bad) => {
    const cards = await queuedCards(4, bad);
    f.store.uow.run((tx) => {
      for (const card of tx.cards.list(f.project_id))
        tx.cards.put(f.project_id, { ...card, flow_version: flow });
    });
    const { options, errors } = await gated("test ! -f bad.txt", true);
    const run: typeof runInTemporaryCheckout = async (input) => {
      input.onReady?.();
      const failed =
        (input as typeof input & { mergeTier?: string }).mergeTier !== "card" &&
        git(
          central.repositoryPath(project),
          "ls-tree",
          "--name-only",
          input.sha,
        )
          .split("\n")
          .includes("bad.txt");
      const status = failed ? ("failed" as const) : ("passed" as const);
      return {
        status,
        checks: input.checks.map((check) => ({
          name: check.name,
          status,
          exit_code: failed ? 1 : 0,
        })),
        cleanup_errors: [],
      };
    };
    const executor = new MergeExecutor({
      ...options,
      gate: { ...options.gate, run },
    });
    for (let tick = 0; tick < 16; tick++) {
      await executor.tick();
      if (f.state().cards.filter((c) => c.status === "done").length === 3)
        break;
    }
    expect(errors).toEqual([]);
    expect(
      f
        .state()
        .cards.filter((c) => c.status === "done")
        .map((c) => c.id),
    ).toEqual(cards.filter((_, i) => i !== bad - 1));
    expect(f.state().cards.find((c) => c.id === cards[bad - 1])?.status).toBe(
      flow >= 2 ? "in_progress" : "awaiting_merge",
    );
    expect(
      f.state().events.filter((e) => e.type === "merge_changes_requested"),
    ).toHaveLength(flow >= 2 ? 1 : 0);
    expect(
      f
        .state()
        .events.filter((e) => e.type === "merge_batch_culprit_identified"),
    ).toHaveLength(1);
  },
  20_000,
);

test("C-391: disabling the queue interrupts its batch and reruns single-card checks", async () => {
  await queuedCards(3);
  const { options, errors } = await gated("true", true);
  const initial = options.gate.configuration.forProject(f.project_id);
  if (initial.status !== "enabled") throw new Error("Missing configuration");
  let current = initial;
  const run = vi.fn(runInTemporaryCheckout);
  const executor = new MergeExecutor({
    ...options,
    gate: {
      ...options.gate,
      run,
      configuration: { errors: [], forProject: () => current },
    },
  });
  await executor.tick();
  await executor.tick();
  const { queue: _queue, ...single } = initial;
  current = single;
  for (let tick = 0; tick < 4; tick++) await executor.tick();
  expect(errors).toEqual([]);
  expect(mergeBatches(f.state().events)[0]?.status).toBe("aborted");
  expect(f.state().cards.every((c) => c.status === "done")).toBe(true);
  expect(run.mock.calls.length).toBeGreaterThan(4);
}, 20_000);

test.each(["baseline", "member"] as const)(
  "C-391: %s changes abort the checked batch and requeue remaining members",
  async (change) => {
    const cards = await queuedCards(3),
      { options, errors, binding } = await gated("true", true);
    const run: typeof runInTemporaryCheckout = async (input) => {
      input.onReady?.();
      return {
        status: "passed",
        checks: [{ name: "test", status: "passed", exit_code: 0 }],
        cleanup_errors: [],
      };
    };
    const executor = new MergeExecutor({
      ...options,
      gate: { ...options.gate, run },
    });
    await executor.tick();
    await executor.tick();
    const batch = mergeBatches(f.state().events)[0];
    if (!batch) throw new Error("Missing batch");
    if (change === "baseline") {
      commit(repos.source, "advance.txt", "baseline advanced\n");
      await binding.sync(project);
    } else {
      f.apply((s, a, p) =>
        updateCard(
          s,
          a,
          { card_id: requiredCard(cards[1]), status: "cancelled" },
          p,
        ),
      );
    }
    await executor.tick();
    await executor.tick();
    expect(errors).toEqual([]);
    expect(
      mergeBatches(f.state().events).find((b) => b.id === batch.id)?.status,
    ).toBe("aborted");
    expect(f.state().cards.filter((c) => c.status === "done")).toHaveLength(
      change === "baseline" ? 3 : 2,
    );
  },
  20_000,
);
function requiredCard(value: import("@cardigan/domain").CardId | undefined) {
  if (!value) throw new Error("Missing card");
  return value;
}

test("C-391: baseline-only files do not intersect unrelated delivery windows", async () => {
  const cards = await queuedCards(2);
  commit(repos.source, "unrelated.txt", "baseline advanced independently");
  f.store.uow.run((tx) =>
    persistEffect(
      tx,
      f.project_id,
      unwrap(
        setMergeWindow(
          loadCommandState(tx, f.project_id),
          { kind: "human", project_id: f.project_id },
          { card_id: cards[0]!, open: true, reason: "Protect first delivery" },
          { ids: tx.ids, clock: { now: () => new Date().toISOString() } },
        ),
      ),
    ),
  );
  const { options, errors } = await gated("true", true);
  const executor = new MergeExecutor(options);
  await executor.tick();
  await executor.tick();
  expect(errors).toEqual([]);
  const state = f.state();
  const paths = cards.map(
    (id) =>
      state.events.findLast(
        (e) => e.card_id === id && e.type === "merge_queue_paths",
      )?.payload,
  );
  expect(paths).toMatchObject([
    { files: ["card-1.txt"] },
    { files: ["card-2.txt"] },
  ]);
  expect(heldByMergeWindow(state, cards[1]!)).toBeUndefined();
  expect(
    mergeBatches(state.events)
      .at(-1)
      ?.members.map((m) => m.card_id),
  ).toEqual(cards);
}, 20_000);
