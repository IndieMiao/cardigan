import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Delivery, Event, MergeCheckView } from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { afterEach, expect, test, vi } from "vitest";
import { fixture, human, id } from "../../domain/src/commands/test-fixtures.js";
import { GithubBranchCleaner } from "./github-branch-cleaner.js";
import type { GithubRun } from "./github-client.js";
import {
  type GithubDispatchIntent,
  GithubDispatchJournal,
} from "./github-dispatch-journal.js";
import type { ProjectMergeGate } from "./merge-gate-config.js";
import type { GithubMergeGateExecutor } from "./merge-gate-executors.js";

const roots: string[] = [],
  stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
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
const settings: ProjectMergeGate = {
  status: "enabled",
  executor: config,
  checks: [],
  env: {},
  totalTimeoutMs: 1000,
};
function setup() {
  const root = mkdtempSync(join(tmpdir(), "dispatch-journal-"));
  roots.push(root);
  const dbPath = join(root, "test.db");
  const store = Store.open({ dbPath });
  stores.push(store);
  const f = fixture(),
    card = f.cards[0],
    item = f.work_items[0];
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
    tx.cards.put(human.project_id, { ...card, status: "awaiting_merge" });
    tx.work_items.put(human.project_id, item);
    tx.deliveries.put(human.project_id, completion);
  });
  const intent = {
    project: human.project_id,
    card: card.id,
    attempt: "old",
    key: "trusted-digest",
    startedAt: "2030-01-01T00:00:00Z",
    executor: config.name,
    phase: "reserved",
    candidate: {
      repo: config.repo,
      ref: `refs/heads/ci/${card.id}/${completion.id}/old`,
      sha: "a".repeat(40),
      delivery: completion.id,
    },
  } satisfies GithubDispatchIntent;
  const check = (overrides: Partial<MergeCheckView> = {}) =>
    store.uow.run((tx) => {
      const value = {
        card_id: card.id,
        completion_id: completion.id,
        attempt_id: intent.attempt,
        candidate_sha: intent.candidate.sha,
        tree_sha: "b".repeat(40),
        executor: { name: config.name, type: "github" },
        status: "queued",
        ...overrides,
      };
      tx.events.append(human.project_id, {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(human.project_id, card.id),
        card_id: card.id,
        actor: { kind: "system", project_id: human.project_id },
        type: "merge_check_queued",
        payload: value,
        created_at: intent.startedAt,
      } as Event);
    });
  check();
  const journal = new GithubDispatchJournal(store);
  const reconcile = (value = settings) =>
    journal.reconcile([human.project_id], () => value);
  const events = () =>
    store.uow.read((tx) => tx.events.listAfter(human.project_id, card.id, 0));
  const remote = {
    provider: "github" as const,
    run_id: 123,
    run_attempt: 1,
    html_url: "https://github.com/fixture/project/actions/runs/123",
    workflow_sha: "c".repeat(40),
  };
  const identity: GithubRun = {
    id: 123,
    run_attempt: 1,
    path: config.workflow,
    event: "workflow_dispatch",
    head_branch: "main",
    head_sha: remote.workflow_sha,
    actor: { login: config.botLogin },
    display_title: `cardigan/${card.id}/${completion.id}/old/merge_check/${intent.candidate.sha}/${"b".repeat(40)}`,
    html_url: remote.html_url,
    created_at: intent.startedAt,
  };
  const remove = vi.fn(async () => true);
  const cleaner = (token = async () => "ghs_synthetic") =>
    new GithubBranchCleaner({
      store,
      config,
      token,
      remove,
      now: () => Date.parse(intent.startedAt),
    });
  return {
    store,
    dbPath,
    card,
    completion,
    intent,
    journal,
    reconcile,
    check,
    events,
    remote,
    identity,
    remove,
    cleaner,
  };
}

test.each([
  "executor",
  "candidate",
  "recheck",
  "interrupted",
  "completion",
] as const)(
  "C-375: %s abandons only the obsolete reservation, frees admission and retains audit",
  async (reason) => {
    const f = setup();
    f.journal.claim(f.intent, 1);
    if (reason === "candidate")
      f.check({ attempt_id: "new", candidate_sha: "c".repeat(40) });
    if (reason === "recheck") f.check({ recheck_requested: true });
    if (reason === "interrupted") f.check({ status: "interrupted" });
    if (reason === "completion")
      f.store.uow.run((tx) =>
        tx.deliveries.put(human.project_id, {
          ...f.completion,
          status: "superseded",
        }),
      );
    const selected: ProjectMergeGate =
      reason === "executor" ? { status: "disabled" } : settings;
    f.reconcile(selected);
    const count = f.events().length;
    f.reconcile(selected);
    expect(f.events()).toHaveLength(count);
    expect(f.journal.unfinished()).toEqual([]);
    expect(f.journal.all()[0]).toMatchObject({
      ...f.intent,
      finished: true,
      abandoned: expect.any(String),
    });
    expect(() => f.journal.beginDispatch(f.intent)).toThrow();
    expect(() => f.journal.claim(f.intent)).toThrow();
    // Same-card and executor capacity both become usable; no history is deleted.
    const next = {
      ...f.intent,
      attempt: "next",
      key: "next",
      candidate: {
        ...f.intent.candidate,
        ref: `refs/heads/ci/${f.card.id}/${f.completion.id}/next`,
      },
    };
    expect(f.journal.claim(next, 1).fresh).toBe(true);
    await f.cleaner().tick([human.project_id]);
    expect(f.remove).toHaveBeenCalledWith(human.project_id, {
      ...f.intent.candidate,
      token: "ghs_synthetic",
    });
    expect(f.journal.all()).toHaveLength(2);
    expect(f.journal.all()[0]).toMatchObject({ deleted: true });
  },
);

test.each([
  "current",
  "unknown-config",
  "unknown-project",
  "wrong-sha",
  "wrong-ref",
  "wrong-delivery",
  "wrong-executor",
])(
  "C-375: %s cannot abandon a reservation or authorize deletion",
  async (mode) => {
    const f = setup();
    let intent = f.intent;
    if (mode === "wrong-sha")
      intent = {
        ...intent,
        candidate: { ...intent.candidate, sha: "d".repeat(40) },
      };
    if (mode === "wrong-ref")
      intent = {
        ...intent,
        candidate: {
          ...intent.candidate,
          ref: "refs/heads/ci/other/delivery/attempt",
        },
      };
    if (mode === "wrong-delivery")
      intent = {
        ...intent,
        candidate: { ...intent.candidate, delivery: "D-999" },
      };
    if (mode === "wrong-executor") intent = { ...intent, executor: "other" };
    f.journal.claim(intent);
    if (mode.startsWith("wrong")) f.check({ status: "interrupted" });
    if (mode === "unknown-project")
      f.journal.reconcile(["other"], () => ({ status: "disabled" }));
    else
      f.reconcile(
        mode === "unknown-config"
          ? { status: "invalid", reason: "fixture" }
          : settings,
      );
    expect(f.journal.unfinished()).toEqual([intent]);
    await f.cleaner().tick([human.project_id]);
    expect(f.remove).not.toHaveBeenCalled();
  },
);

test.each([false, true])(
  "C-375: dispatched record (bound=%s) keeps capacity until verified terminal; late binding cannot revive it",
  async (bound) => {
    const f = setup();
    f.journal.claim(f.intent);
    f.journal.beginPublication(f.intent);
    f.journal.beginDispatch(f.intent);
    if (bound) f.journal.bind(f.intent, f.remote, f.identity);
    f.check({ attempt_id: "new" });
    f.reconcile();
    expect(f.journal.unfinished()).toMatchObject([
      { abandoned: "superseded", phase: "dispatching" },
    ]);
    expect(() =>
      f.journal.claim({
        ...f.intent,
        attempt: "new",
        candidate: {
          ...f.intent.candidate,
          ref: `refs/heads/ci/${f.card.id}/${f.completion.id}/new`,
        },
      }),
    ).toThrow();
    await f.cleaner().tick([human.project_id]);
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.journal.bind(f.intent, f.remote, f.identity)).toBe(false);
    expect(() =>
      f.journal.bind(f.intent, { ...f.remote, run_id: 456 }, f.identity),
    ).toThrow();
    f.journal.finish(f.intent);
    f.journal.finish(f.intent);
    expect(f.journal.unfinished()).toEqual([]);
    await f.cleaner().tick([human.project_id]);
    expect(f.remove).toHaveBeenCalledOnce();
  },
);

test("C-375: separate SQLite connections and reopen preserve the abandonment fence and idempotent cleanup", async () => {
  const f = setup();
  f.journal.claim(f.intent);
  const second = Store.open({ dbPath: f.dbPath });
  const competing = new GithubDispatchJournal(second);
  f.check({ attempt_id: "new" });
  f.reconcile();
  expect(() => competing.beginDispatch(f.intent)).toThrow();
  competing.reconcile([human.project_id], () => settings);
  const count = f.events().length;
  second.close();
  const reopened = Store.open({ dbPath: f.dbPath });
  stores.push(reopened);
  const replay = new GithubDispatchJournal(reopened);
  replay.reconcile([human.project_id], () => settings);
  expect(f.events()).toHaveLength(count);
  expect(replay.unfinished()).toEqual([]);
  await f.cleaner().tick([human.project_id]);
  expect(replay.all()[0]).toMatchObject({
    abandoned: "superseded",
    finished: true,
    deleted: true,
  });
});

test("C-375: cleanup preserves a changed SHA lease and retries the original exact ref after restart", async () => {
  const f = setup();
  f.journal.claim(f.intent);
  f.check({ status: "interrupted" });
  f.reconcile();
  f.remove.mockResolvedValueOnce(false); // Fake Git rejects the original SHA lease.
  await f.cleaner().tick([human.project_id]);
  expect(f.journal.all()[0]).toMatchObject({ deleting: true });
  expect(f.journal.all()[0]?.deleted).toBeUndefined();
  await f.cleaner().tick([human.project_id]);
  expect(f.remove).toHaveBeenCalledTimes(2);
  expect(f.remove.mock.calls[0]).toEqual(f.remove.mock.calls[1]);
});
