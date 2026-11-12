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
  latestMergeCheck,
  prepareMergePlan,
  recordMergeResult,
  requestHumanAction,
  setCardSensitive,
  setProjectPreferences,
} from "@cardigan/domain";

import {
  type CentralProject,
  CentralRepositoryService,
} from "@cardigan/git-service";
import { CentralGitTransport } from "@cardigan/git-transport";
import { loadMergeGateConfig, runInTemporaryCheckout } from "@cardigan/host";
import {
  authenticate,
  getCardTool,
  loadCommandState,
  persistEffect,
  unwrap,
} from "@cardigan/mcp-server";
import { Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
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

async function gated(run = "true") {
  writeFileSync(
    join(repos.root, "merge-gate.yaml"),
    JSON.stringify({
      projects: { [f.project_id]: { checks: [{ name: "test", run }] } },
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
