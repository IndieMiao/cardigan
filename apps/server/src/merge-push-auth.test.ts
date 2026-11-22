import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acceptMergePushHold,
  completeHumanAction,
  type ProjectId,
} from "@cardigan/domain";
import { CentralRepositoryService } from "@cardigan/git-service";
import { CentralGitTransport, type PushResult } from "@cardigan/git-transport";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import { Store } from "@cardigan/store";
import { afterEach, expect, test, vi } from "vitest";
import { ServerGit } from "./git.js";
import { MergePushExecutor, type MergePushOptions } from "./merge-push-loop.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0)) close();
});

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "cg-push-auth-"));
  const project_id = "push-auth" as ProjectId;
  const project = { project_id, source_repo: "/unused", base_branch: "main" };
  const config = {
    target: "f".repeat(64),
    branch: "main",
    baseBranch: "main",
    registered: true,
    remote: "file:///unused",
  };
  let time = Date.parse("2035-01-01T00:00:00.000Z");
  const clock = { now: () => new Date(time).toISOString() };
  let store = Store.open({ dataDir, clock });
  store.createProject({ id: project_id, name: "Push auth fixture" });
  cleanup.push(() => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const A = "a".repeat(40),
    B = "b".repeat(40),
    C = "c".repeat(40);
  // Persisted history: one trusted boundary and two subsequent recorded merges.
  store.uow.run((tx) => {
    const append = (type: string, payload: Record<string, unknown>) => {
      const id = tx.ids.nextEventId();
      tx.events.append(project_id, {
        id,
        seq: tx.ids.nextEventSequence(project_id),
        type,
        actor: { kind: "system", project_id },
        payload,
        created_at: clock.now(),
      });
      return id;
    };
    append("merge_pushed", {
      target: config.target,
      branch: config.branch,
      sha: A,
      queue_ids: [],
      status: "pushed",
      failure_count: 0,
    });
    for (const [previous_sha, sha] of [
      [A, B],
      [B, C],
    ]) {
      const merge_event_id = append("card_merged", {
        result: { kind: "merged", previous_sha, merge_sha: sha },
      });
      append("merge_push_queued", {
        target: config.target,
        branch: config.branch,
        sha,
        merge_event_id,
      });
    }
  });
  const push = vi
    .fn<NonNullable<MergePushOptions["git"]["push"]>>()
    .mockResolvedValue({ status: "pushed" });
  const git: MergePushOptions["git"] = {
    projectOf: () => project,
    push,
    pushRange: async (_project, base) => ({
      head: C,
      chain: [
        {
          sha: C,
          parent: B,
          author: "Fixture",
          committer: "Fixture",
          subject: "second",
        },
        {
          sha: B,
          parent: A,
          author: "Fixture",
          committer: "Fixture",
          subject: "first",
        },
      ].filter((c) => base === A || c.sha !== B),
      truncated: false,
    }),
  };
  const errors: unknown[] = [];
  const executor = () =>
    new MergePushExecutor({
      store,
      git,
      clock,
      onError: (e) => errors.push(e),
      configuration: {
        errors: [],
        forProject: () => ({
          status: "enabled",
          checks: [],
          env: {},
          totalTimeoutMs: 1000,
          push: [config],
        }),
      },
    });
  const state = () => store.uow.read((tx) => loadCommandState(tx, project_id));
  const failures = () =>
    state().events.filter((e) => e.type === "merge_push_failed");
  return {
    push,
    store,
    git,
    dataDir,
    project,
    config,
    executor,
    state,
    failures,
    errors,
    B,
    C,
    advance: (ms: number) => {
      time += ms;
    },
    reopen: () => {
      store.close();
      store = Store.open({ dataDir, clock });
    },
    repair: (acceptHold = false) =>
      store.uow.run((tx) => {
        const s = loadCommandState(tx, project_id);
        const action = s.human_actions.find((a) => a.status === "open");
        if (!action) throw new Error("Missing action");
        const effect = unwrap(
          (acceptHold ? acceptMergePushHold : completeHumanAction)(
            s,
            { kind: "human", project_id },
            { human_action_id: action.id, text: "已修复测试故障" },
            { clock, ids: tx.ids },
          ),
        );
        persistEffect(tx, project_id, effect);
      }),
  };
}
const auth: PushResult = { status: "failed", reason: "auth", exit_code: 128 };

test("accepting a hold across database reopen cannot renew a pending range's auth retry", async () => {
  const f = fixture();
  f.push.mockResolvedValue(auth);
  await f.executor().tick();
  const readRange = f.git.pushRange;
  if (!readRange) throw new Error("Missing range reader");
  vi.spyOn(f.git, "pushRange").mockImplementation(async (...args) => {
    const range = await readRange(...args);
    const head = "d".repeat(40);
    return {
      ...range,
      head,
      chain: [
        {
          sha: head,
          parent: range.head,
          author: "Fixture",
          committer: "Fixture",
          subject: "foreign",
        },
        ...range.chain,
      ],
    };
  });
  f.advance(60_000);
  await f.executor().tick();
  expect(f.push).toHaveBeenCalledTimes(1);
  expect(f.state().events.at(-1)?.type).toBe("merge_push_held");
  f.reopen();
  f.repair(true);
  f.reopen();
  const resumed = f.executor();
  await Promise.all([resumed.tick(), resumed.tick()]);
  expect(f.push).toHaveBeenCalledTimes(2);
  expect(f.push.mock.calls[1]?.[1]).toEqual({ sha: f.C, included: [f.B, f.C] });
  expect(f.failures().at(-1)?.payload).toMatchObject({
    reason: "auth",
    auth_retry_used: true,
  });
  expect(f.failures().at(-1)?.payload).not.toHaveProperty("next_retry_at");
  expect(
    f.state().human_actions.filter((a) => a.status === "open"),
  ).toHaveLength(1);
  f.reopen();
  f.advance(60_000);
  await f.executor().tick();
  expect(f.push).toHaveBeenCalledTimes(2);
  expect(f.errors).toEqual([]);
});

test("auth retry survives a database reopen, waits a minute, and succeeds without a human action", async () => {
  const f = fixture();
  f.push.mockResolvedValueOnce(auth);
  await f.executor().tick();
  expect(f.failures()[0]?.payload).toMatchObject({
    reason: "auth",
    exit_code: 128,
    failure_count: 1,
  });
  expect(f.state().human_actions).toEqual([]);
  f.reopen();
  f.advance(59_999);
  await f.executor().tick();
  expect(f.push).toHaveBeenCalledTimes(1);
  f.advance(1);
  await f.executor().tick();
  expect(f.push).toHaveBeenCalledTimes(2);
  expect(f.push.mock.calls.map((c) => c[1].sha)).toEqual([f.B, f.B]);
  expect(f.state().human_actions).toEqual([]);
  await f.executor().tick();
  expect(f.push.mock.calls[2]?.[1].sha).toBe(f.C);
  expect(f.errors).toEqual([]);
});

test("server Git forwards the numeric failure but does not invent an exit code for credential validation", async () => {
  const f = fixture();
  vi.spyOn(
    CentralRepositoryService.prototype,
    "ensureCentral",
  ).mockResolvedValue("/fixture/central.git");
  vi.spyOn(CentralGitTransport.prototype, "objectType").mockResolvedValue(
    "commit",
  );
  vi.spyOn(CentralGitTransport.prototype, "isAncestor").mockResolvedValue(true);
  const send = vi
    .spyOn(CentralGitTransport.prototype, "pushMergedCommit")
    .mockResolvedValue(auth);
  const git = new ServerGit({ store: f.store, dataDir: f.dataDir });
  const input = { sha: f.B, included: [f.B] };
  expect(await git.push(f.project, input, f.config)).toEqual(auth);
  expect(
    await git.push(f.project, input, {
      ...f.config,
      remote: "git@example.invalid:team/repo.git",
    }),
  ).toEqual({ status: "failed", reason: "auth" });
  expect(send).toHaveBeenCalledTimes(1);
});

test("unknown failures still pause immediately without leaking exception diagnostics", async () => {
  const f = fixture();
  const secret =
    "synthetic-key https://user:fixture-password@example.invalid/repo";
  f.push.mockRejectedValue(new Error(secret));
  await f.executor().tick();
  expect(f.failures()[0]?.payload).toMatchObject({ reason: "other" });
  expect(f.state().human_actions).toHaveLength(1);
  expect(JSON.stringify(f.state())).not.toContain(secret);
  expect(f.errors).toEqual([]);
});

test("concurrent ticks cannot replenish auth retries; human repair permits only one coalesced retry", async () => {
  const f = fixture();
  f.push.mockResolvedValue(auth);
  const loop = f.executor();
  await Promise.all([loop.tick(), loop.tick()]);
  expect(f.push).toHaveBeenCalledTimes(1);
  f.reopen();
  f.advance(60_000);
  const resumed = f.executor();
  await Promise.all([resumed.tick(), resumed.tick()]);
  expect(f.push).toHaveBeenCalledTimes(2);
  expect(f.failures()).toHaveLength(2);
  expect(
    f.state().human_actions.filter((a) => a.status === "open"),
  ).toHaveLength(1);
  f.reopen();
  f.advance(3_600_000);
  await f.executor().tick();
  expect(f.push).toHaveBeenCalledTimes(2);
  f.repair();
  await f.executor().tick();
  expect(f.push.mock.calls[2]?.[1]).toEqual({ sha: f.C, included: [f.B, f.C] });
  f.advance(60_000);
  await f.executor().tick();
  expect(f.push).toHaveBeenCalledTimes(3);
  expect(
    f.state().human_actions.filter((a) => a.status === "open"),
  ).toHaveLength(1);
  f.repair();
  f.push.mockResolvedValue({ status: "pushed" });
  await f.executor().tick();
  await f.executor().tick();
  expect(f.push).toHaveBeenCalledTimes(4);
  expect(f.state().human_actions.filter((a) => a.status === "open")).toEqual(
    [],
  );
  expect(f.errors).toEqual([]);
});
