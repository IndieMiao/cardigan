import { postComment } from "@cardigan/domain";
import { RepositoryLockTimeoutError } from "@cardigan/git-service";
import { PreparationError, withPreparationRetry } from "@cardigan/host";
import { PROJECT_EVENT_STREAM, unfinishedBellAttempts } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";
import { Dispatcher, type DispatcherOptions } from "./dispatch.js";

let f: ReturnType<typeof dispatchFixture>,
  target: ReturnType<typeof f.create>,
  options: DispatcherOptions,
  wake: ReturnType<typeof vi.fn>,
  logged: string[];
beforeEach(() => {
  f = dispatchFixture();
  target = f.create();
  f.session(target.assignment);
  const cards = f.store.uow.read((tx) => [
    undefined,
    ...tx.cards.list(f.project).map((card) => card.id),
  ]);
  for (const card_id of cards)
    f.store.advanceRouterCursor(
      f.project,
      card_id ?? PROJECT_EVENT_STREAM,
      f.store.getUpdates({
        project_id: f.project,
        ...(card_id ? { card_id } : {}),
      }).latest_seq,
    );
  wake = vi.fn(async () => ({ ok: true, value: { sent: true } }));
  logged = [];
  options = {
    store: f.store,
    runtime: {
      status: vi.fn(async () => ({
        ok: true,
        value: { process: "alive", agent: "idle", observed_seq: 1 },
      })),
      wake,
      provision: async () => {
        throw new Error("unused");
      },
      release: async () => ({ ok: true, value: undefined }),
      interrupt: async () => ({ ok: true, value: undefined }),
      resume_or_replace: async () => {
        throw new Error("unused");
      },
      human_entry: async () => ({ ok: true, value: "fixture" }),
    } as DispatcherOptions["runtime"],
    clock: f.clock,
    deliveryLeaseMs: 1000,
    snapshot: vi.fn(async () => ({
      model: "m",
      agent_cli_version: "v",
    })),
    startRun: vi.fn(async () => {
      throw new Error("unused");
    }),
    onError: (error) => logged.push((error as Error).message),
  };
});
afterEach(() => f.close());

const comment = () =>
  f.apply((s, a, p) =>
    postComment(
      s,
      a,
      {
        card_id: target.card.id,
        work_item_id: target.item.id,
        body: "Read the card",
      },
      p,
    ),
  );
// C-56 owns a dispatched Run's retries, so a live-session failure is an
// audit-only event with its real cause, not a per-attempt alert.
const failures = () =>
  f.state().events.filter((e) => e.type === "bell_delivery_attempt_failed");
const alerts = () =>
  f.state().events.filter((e) => e.type === "bell_delivery_failed");
afterEach(() => {
  expect(alerts()).toEqual([]);
});

test("a Git lock conflict in beforeWake is recorded as before_wake_failed with its real category", async () => {
  comment();
  const stderr =
    "fatal: Unable to create '/data/agent/repos/p/.git/shallow.lock': File exists.\nAnother git process seems to be running";
  options = {
    ...options,
    beforeWake: () =>
      withPreparationRetry(
        async () => {
          throw Object.assign(
            new Error(
              "Command failed: git -C /data/agent/repos/p fetch https://bot:s3cret@example.invalid/x\n" +
                stderr,
            ),
            { code: 128, stderr },
          );
        },
        { sleep: async () => undefined },
      ),
  };
  await new Dispatcher(options).tick();
  expect(wake).not.toHaveBeenCalled();
  expect(failures()).toHaveLength(1);
  expect(failures()[0]?.payload).toMatchObject({
    reason: "before_wake_failed",
    error: {
      category: "git_lock_conflict",
      exit_code: 128,
      message:
        "fatal: Unable to create '/data/agent/repos/p/.git/shallow.lock': File exists.",
    },
  });
  expect(JSON.stringify(failures()[0]?.payload)).not.toContain("s3cret");
  expect(logged).toHaveLength(1);
  expect(logged[0]).toContain("reason=before_wake_failed");
  expect(logged[0]).toContain("category=git_lock_conflict");
  expect(logged[0]).toContain("exit=128");
  expect(unfinishedBellAttempts(f.store.database, f.project)).toEqual([]);
});

test("a repository lock timeout after retries keeps its category on the failure event", async () => {
  comment();
  const attempts = vi.fn(async () => {
    throw new RepositoryLockTimeoutError(30_000);
  });
  const waits: number[] = [];
  options = {
    ...options,
    beforeWake: () =>
      withPreparationRetry(attempts, {
        sleep: async (ms) => {
          waits.push(ms);
        },
      }),
  };
  await new Dispatcher(options).tick();
  expect(attempts).toHaveBeenCalledTimes(4);
  expect(waits).toEqual([1000, 2000, 4000]);
  expect(failures()[0]?.payload).toMatchObject({
    reason: "before_wake_failed",
    error: { category: "repository_lock_timeout" },
  });
});

test("a transient beforeWake failure recovers inside the same delivery", async () => {
  comment();
  let calls = 0;
  options = {
    ...options,
    beforeWake: () =>
      withPreparationRetry(
        async () => {
          calls += 1;
          if (calls < 3)
            throw Object.assign(new Error("Command failed: git fetch"), {
              code: 128,
              stderr: "fatal: cannot lock ref 'refs/remotes/origin/main'",
            });
          return "当前基线 origin/main：abc（已由主机同步）。";
        },
        { sleep: async () => undefined },
      ),
  };
  await new Dispatcher(options).tick();
  expect(calls).toBe(3);
  expect(wake).toHaveBeenCalledOnce();
  expect(wake.mock.calls[0]?.[1]).toContain("当前基线 origin/main：abc");
  expect(failures()).toEqual([]);
  expect(f.state().runs.at(-1)?.status).toBe("dispatched");
});

test("a failed wake result is wake_failed with the runtime error code", async () => {
  comment();
  wake.mockResolvedValueOnce({
    ok: false,
    error: { code: "runtime_timeout", message: "no reply" },
  });
  await new Dispatcher(options).tick();
  expect(failures()[0]?.payload).toMatchObject({
    reason: "wake_failed",
    error: { category: "runtime_timeout", message: "no reply" },
  });
});

test("a thrown wake is wake_failed, not delivery_call_failed", async () => {
  comment();
  wake.mockRejectedValueOnce(new Error("socket closed"));
  await new Dispatcher(options).tick();
  expect(failures()[0]?.payload).toMatchObject({
    reason: "wake_failed",
    error: { category: "prepare_failed", message: "socket closed" },
  });
});

test("a non-Git beforeWake error is still before_wake_failed, not delivery_call_failed", async () => {
  comment();
  options = {
    ...options,
    beforeWake: async () => {
      throw new PreparationError(
        { category: "prepare_failed", message: "boom", retryable: false },
        1,
      );
    },
  };
  await new Dispatcher(options).tick();
  expect(failures()[0]?.payload).toMatchObject({
    reason: "before_wake_failed",
    error: { category: "prepare_failed", message: "boom" },
  });
  expect(JSON.stringify(failures()[0]?.payload)).not.toContain("retryable");
});
