import type { Delivery, Event, MergeCheckView } from "@cardigan/domain";
import type { CandidateDeleteRequest } from "@cardigan/git-transport";
import { Store } from "@cardigan/store";
import { afterEach, expect, test, vi } from "vitest";
import { fixture, human, id } from "../../domain/src/commands/test-fixtures.js";
import { GithubBranchCleaner } from "./github-branch-cleaner.js";
import type { GithubRun } from "./github-client.js";
import {
  type GithubDispatchIntent,
  GithubDispatchJournal,
} from "./github-dispatch-journal.js";
import { GITHUB_POLL_DEFAULTS } from "./github-rate-limit.js";
import type { GithubMergeGateExecutor } from "./merge-gate-executors.js";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
const config: GithubMergeGateExecutor = {
  name: "github",
  type: "github",
  repo: "fixture/project",
  workflow: ".github/workflows/check.yml",
  appId: 1,
  installationId: 2,
  privateKeyFile: "/synthetic/key",
  botLogin: "fixture[bot]",
  maxConcurrent: 1,
};
function setup(overrides: Partial<GithubDispatchIntent> = {}) {
  const store = Store.open({ dbPath: ":memory:" });
  stores.push(store);
  const f = fixture();
  const card = f.cards[0];
  const item = f.work_items[0];
  if (!card || !item) throw new Error("Missing fixture");
  const completion: Delivery = {
    id: id("delivery", 1),
    work_item_id: item.id,
    run_id: id("run", 1),
    kind: "card_completion",
    summary: "fixture",
    subject: { kind: "git_head", value: "a".repeat(40) },
    evidence: [],
    attachments: [],
    known_gaps: [],
    requested_verifiers: [],
    status: "submitted",
  };
  store.createProject({ id: human.project_id });
  store.uow.run((tx) => {
    tx.cards.put(human.project_id, { ...card, status: "done" });
    tx.work_items.put(human.project_id, item);
    tx.deliveries.put(human.project_id, completion);
  });
  const identity = {
    id: 123,
    display_title: `cardigan/${card.id}/${completion.id}/attempt-1/merge_check/${"a".repeat(40)}/${"b".repeat(40)}`,
  } as GithubRun;
  const intent: GithubDispatchIntent = {
    project: human.project_id,
    card: card.id,
    attempt: "attempt-1",
    key: "fixture",
    startedAt: "2030-01-01T00:00:00Z",
    executor: config.name,
    phase: "dispatching",
    identity,
    externalRun: {
      provider: "github",
      run_id: 123,
      run_attempt: 1,
      html_url: "https://github.com/fixture/project/actions/runs/123",
      workflow_sha: "c".repeat(40),
    },
    finished: true,
    candidate: {
      repo: config.repo,
      ref: `refs/heads/ci/${card.id}/${completion.id}/attempt-1`,
      sha: "a".repeat(40),
      delivery: completion.id,
    },
    ...overrides,
  };
  const journal = new GithubDispatchJournal(store);
  journal.claim(intent);
  let now = Date.parse(intent.startedAt);
  const token = vi.fn(async () => "ghs_synthetic");
  const remove = vi.fn(
    async (_project: string, _request: CandidateDeleteRequest) => true,
  );
  const onError = vi.fn();
  const cleaner = (
    extra: Partial<ConstructorParameters<typeof GithubBranchCleaner>[0]> = {},
  ) =>
    new GithubBranchCleaner({
      store,
      config,
      token,
      remove,
      onError,
      now: () => now,
      ...extra,
    });
  const setCard = (status: typeof card.status) =>
    store.uow.run((tx) => tx.cards.put(human.project_id, { ...card, status }));
  const setCompletion = (status: Delivery["status"]) =>
    store.uow.run((tx) =>
      tx.deliveries.put(human.project_id, { ...completion, status }),
    );
  const tick = (c = cleaner()) => c.tick([human.project_id]);
  const newer = (
    attempt = "attempt-2",
    status: MergeCheckView["status"] = "queued",
  ) =>
    store.uow.run((tx) =>
      tx.events.append(human.project_id, {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(human.project_id, card.id),
        card_id: card.id,
        type: "merge_check_queued",
        actor: { kind: "system", project_id: human.project_id },
        payload: { attempt_id: attempt, completion_id: completion.id, status },
        created_at: new Date(now).toISOString(),
      } as Event),
    );
  return {
    store,
    card,
    completion,
    intent,
    journal,
    token,
    remove,
    onError,
    cleaner,
    setCard,
    setCompletion,
    tick,
    newer,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
test.each(["done", "cancelled", "superseded"] as const)(
  "D5: terminal remote attempt cleans %s, fences redispatch and persists successful cleanup",
  async (state) => {
    const f = setup();
    if (state === "superseded") {
      f.setCard("in_progress");
      f.setCompletion("superseded");
    } else f.setCard(state);
    await f.tick();
    await f.tick();
    expect(f.remove).toHaveBeenCalledOnce();
    expect(f.remove).toHaveBeenCalledWith(human.project_id, {
      ...f.intent.candidate,
      token: "ghs_synthetic",
    });
    expect(f.journal.all()[0]).toMatchObject({ deleting: true, deleted: true });
    expect(() => f.journal.claim(f.intent)).toThrow();
  },
);
test.each([
  { finished: false },
  { externalRun: undefined },
  { identity: undefined },
  { candidate: undefined },
  { executor: "other" },
])(
  "D5: retains in-flight or unknown identity %o even when old and cancelled",
  async (override) => {
    const f = setup(override as Partial<GithubDispatchIntent>);
    f.setCard("cancelled");
    f.advance(10 * GITHUB_POLL_DEFAULTS.branchRetentionMs);
    await f.tick();
    expect(f.remove).not.toHaveBeenCalled();
  },
);
test("D5: an active completion's latest attempt survives retention, older completed attempts expire at the configured boundary", async () => {
  const f = setup();
  f.setCard("awaiting_merge");
  f.newer("attempt-1", "passed");
  f.advance(GITHUB_POLL_DEFAULTS.branchRetentionMs);
  await f.tick();
  expect(f.remove).not.toHaveBeenCalled();
  f.newer();
  const cleaner = f.cleaner({
    config: {
      ...config,
      branchRetentionMs: GITHUB_POLL_DEFAULTS.branchRetentionMs + 1,
    },
  });
  await f.tick(cleaner);
  expect(f.remove).not.toHaveBeenCalled();
  f.advance(20_000);
  await f.tick(cleaner);
  expect(f.remove).toHaveBeenCalledOnce();
});
test("D5: failed deletes are sanitized, retried next maintenance cycle and survive cleaner restart", async () => {
  const f = setup();
  f.remove.mockResolvedValueOnce(false);
  const cleaner = f.cleaner();
  await expect(f.tick(cleaner)).resolves.toBeUndefined();
  expect(f.onError).toHaveBeenCalledOnce();
  expect(f.journal.all()[0]?.deleted).toBeUndefined();
  await f.tick(cleaner);
  expect(f.remove).toHaveBeenCalledOnce();
  f.advance(20_000);
  await f.tick(f.cleaner());
  expect(f.remove).toHaveBeenCalledTimes(2);
  expect(f.journal.all()[0]?.deleted).toBe(true);
});
test("D5: rechecks fresh completion state after awaiting credentials", async () => {
  const f = setup();
  f.setCard("awaiting_merge");
  f.setCompletion("superseded");
  f.token.mockImplementationOnce(async () => {
    f.setCompletion("submitted");
    return "ghs_synthetic";
  });
  await f.tick();
  expect(f.remove).not.toHaveBeenCalled();
});

test("idle history is projected once per scan and does not survive a new transaction", async () => {
  const f = setup();
  f.setCard("in_progress");
  const candidate = f.intent.candidate;
  const identity = f.intent.identity;
  if (!candidate || !identity) throw new Error("Missing fixture identity");
  // Current/incomplete checks are retained, so there is no external IO.
  f.store.uow.run((tx) => {
    for (let i = 2; i <= 12; i++)
      tx.events.append(human.project_id, {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(human.project_id, f.card.id),
        card_id: f.card.id,
        actor: { kind: "system", project_id: human.project_id },
        type: "github_check_dispatch",
        created_at: f.intent.startedAt,
        payload: {
          ...f.intent,
          attempt: `retained-${i}`,
          key: `retained-${i}`,
          candidate: {
            ...candidate,
            delivery: `D-${i}`,
            ref: `refs/heads/ci/${f.card.id}/D-${i}/retained-${i}`,
          },
          identity: {
            ...identity,
            display_title: `cardigan/${f.card.id}/D-${i}/retained-${i}/merge_check/${"a".repeat(40)}/${"b".repeat(40)}`,
          },
        } as unknown as Event["payload"],
      });
  });
  const all = vi.spyOn(GithubDispatchJournal.prototype, "allAt");
  try {
    await f.tick();
    expect(all).toHaveBeenCalledTimes(1);
    expect(f.token).not.toHaveBeenCalled();
    f.setCard("done");
    await f.tick();
    expect(f.remove).toHaveBeenCalledTimes(1);
    expect(
      f.journal.all().find((i) => i.attempt === f.intent.attempt)?.deleted,
    ).toBe(true);
  } finally {
    all.mockRestore();
  }
});

test("fresh ownership conflict after credentials prevents a previously selected deletion", async () => {
  const f = setup();
  f.token.mockImplementationOnce(async () => {
    f.store.uow.run((tx) =>
      tx.events.append(human.project_id, {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(human.project_id, f.card.id),
        card_id: f.card.id,
        type: "github_check_dispatch",
        actor: { kind: "system", project_id: human.project_id },
        created_at: f.intent.startedAt,
        payload: {
          ...f.intent,
          attempt: "conflicting-owner",
          key: "other",
        } as unknown as Event["payload"],
      }),
    );
    return "ghs_synthetic";
  });
  await f.tick();
  expect(f.remove).not.toHaveBeenCalled();
  expect(f.journal.all().every((i) => !i.deleting && !i.deleted)).toBe(true);
});
test("D5: same-name reuse or changed remote tip never deletes the replacement", async () => {
  const f = setup();
  let remote = "b".repeat(40);
  f.remove.mockImplementation(async (_project, request) => {
    if (request.sha !== remote) return false;
    remote = "";
    return true;
  });
  await f.tick();
  expect(remote).toBe("b".repeat(40));
  expect(f.onError).toHaveBeenCalledOnce();
  expect(() =>
    f.journal.claim({ ...f.intent, attempt: "attempt-2", key: "replacement" }),
  ).toThrow();
});
test("D5: overlapping maintenance shares one deletion", async () => {
  const f = setup();
  const cleaner = f.cleaner();
  await Promise.all([f.tick(cleaner), f.tick(cleaner)]);
  expect(f.remove).toHaveBeenCalledOnce();
});

test("D5: a candidate with a changed target version or foreign repository is retained", async () => {
  const f = setup({
    candidate: {
      repo: "fixture/project",
      ref: "refs/heads/ci/C-1/D-999/attempt-1",
      delivery: "D-999",
      sha: "a".repeat(40),
    },
  });
  await f.tick();
  expect(f.remove).not.toHaveBeenCalled();
  const g = setup();
  await g.tick(g.cleaner({ config: { ...config, repo: "fixture/other" } }));
  expect(g.remove).not.toHaveBeenCalled();
});

test("D5: an unmatched in-flight intent cannot be expired by retention", async () => {
  const f = setup({ finished: false, phase: "dispatching" });
  f.setCard("awaiting_merge");
  f.newer();
  f.advance(10 * GITHUB_POLL_DEFAULTS.branchRetentionMs);
  await f.tick();
  expect(f.remove).not.toHaveBeenCalled();
});
