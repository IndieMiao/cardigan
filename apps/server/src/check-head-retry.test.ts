import { join } from "node:path";
import { CheckHeadFailure, prechecks } from "@cardigan/domain";
import { RepositoryLockTimeoutError } from "@cardigan/git-service";
import { authenticate, serverTools } from "@cardigan/mcp-server";
import { afterEach, expect, test, vi } from "vitest";
import { value } from "../../../packages/domain/src/commands/test-fixtures.js";
import {
  type CheckHeadRetryOptions,
  DEFAULT_CHECK_HEAD_RETRY,
  readCheckHeadWithRetry,
  retryingCheckHeadReader,
} from "./check-head-retry.js";
import { type M4Fixture, m4Fixture, m4Scenario } from "./m4-fixtures.js";

const head = "a".repeat(40);
const fixtures: M4Fixture[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});

/** A virtual clock: every lock attempt waits its full 30s before timing out. */
function virtualTime() {
  let ms = 0;
  const sleeps: number[] = [];
  return {
    io: {
      now: () => ms,
      sleep: async (wait: number) => {
        sleeps.push(wait);
        ms += wait;
      },
    },
    busy: () => {
      ms += 30_000;
      return new RepositoryLockTimeoutError(30_000);
    },
    sleeps,
    elapsed: () => ms,
  };
}

function setup(
  checkHead: (...args: unknown[]) => Promise<string>,
  options: CheckHeadRetryOptions,
  io: ReturnType<typeof virtualTime>["io"],
) {
  const f = m4Fixture();
  fixtures.push(f);
  const s = m4Scenario(f);
  f.store.uow.run((tx) => {
    tx.cards.put(f.project_id, { ...s.card, flow_version: 5 });
    tx.assignments.put(f.project_id, {
      ...s.coder,
      branch: "agent/c632",
      worktree_path: join(f.dataDir, "worktree"),
    });
    const role = tx.roles.get(f.project_id, {
      role_id: "coder",
      role_version: 1,
    });
    if (!role) throw new Error("Missing coder role");
    tx.roles.put(f.project_id, {
      ...role,
      allowed_tools: [...role.allowed_tools, "request_check"],
    });
  });
  const token = f.store.issueToken({
    project_id: f.project_id,
    assignment_id: s.coder.id,
    role: { role_version: 1, allowed_tools: ["request_check"] },
  });
  const context = {
    store: f.store,
    identity: value(authenticate(f.store, token.token)),
  };
  const git = { checkHead: vi.fn(checkHead) };
  const request = serverTools({
    deliveryVerifier: () => ({
      verify: async () => ({ ok: true as const, value: [] }),
    }),
    // Same production wiring as server.ts, with virtual time.
    checkHead: (project) => retryingCheckHeadReader(git, project, options, io),
    clock: f.clock,
  }).find((t) => t.name === "request_check");
  if (!request) throw new Error("Missing request_check");
  const call = (key: string) =>
    request.handler(
      { idempotency_key: key, work_item_id: s.development.id },
      context,
    );
  const queued = () => prechecks(f.state().events);
  return { call, git, queued };
}

test.each([1, 2])(
  "request_check is accepted after the repository lock times out %i time(s) and is released",
  async (busyTimes) => {
    const t = virtualTime();
    let failures = 0;
    const x = setup(
      async () => {
        if (failures < busyTimes) {
          failures++;
          throw t.busy();
        }
        return head;
      },
      DEFAULT_CHECK_HEAD_RETRY,
      t.io,
    );
    expect(await x.call("busy-then-free")).toMatchObject({
      head_sha: head,
      status: "queued",
    });
    expect(x.git.checkHead).toHaveBeenCalledTimes(busyTimes + 1);
    expect(t.sleeps).toEqual([1_000, 2_000].slice(0, busyTimes));
    expect(x.queued()).toHaveLength(1);
  },
);

test("a persistently busy repository fails after the total limit with the busy reason", async () => {
  const t = virtualTime();
  const x = setup(
    async () => {
      throw t.busy();
    },
    { attempts: 10, totalMs: 90_000, backoffMs: 1_000 },
    t.io,
  );
  const error = await x.call("always-busy").catch((e: unknown) => e);
  expect(error).toMatchObject({
    code: "validation_failed",
    message: expect.stringContaining("主机仓库忙"),
    details: { reason: "repository_busy", retryable: true },
  });
  // 30s + 1s + 30s + 2s + 30s = 93s: a fourth attempt (4s later) is past 90s.
  expect(x.git.checkHead).toHaveBeenCalledTimes(3);
  expect(t.elapsed()).toBe(93_000);
  expect(x.queued()).toEqual([]);
});

test("the attempt count also bounds retries", async () => {
  const t = virtualTime();
  const x = setup(
    async () => {
      throw t.busy();
    },
    { attempts: 2, totalMs: 600_000, backoffMs: 1_000 },
    t.io,
  );
  await expect(x.call("two-attempts")).rejects.toMatchObject({
    details: { reason: "repository_busy" },
  });
  expect(x.git.checkHead).toHaveBeenCalledTimes(2);
});

test.each([
  ["branch_missing", "登记分支在工作机上不存在", false],
  ["object_mismatch", "不是提交对象", false],
  ["ownership_mismatch", "与当前负责人不符", false],
  ["fetch_failed", "拉取登记分支失败", true],
  ["repository_failed", "中央仓库", false],
  ["environment_unavailable", "Git检查环境", false],
] as const)(
  "%s is rejected at once without retrying, with its own reason",
  async (reason, text, retryable) => {
    const t = virtualTime();
    const x = setup(
      async () => {
        throw new CheckHeadFailure(reason, {
          cause: new Error("fatal: /private/secret token=ghs_synthetic"),
        });
      },
      DEFAULT_CHECK_HEAD_RETRY,
      t.io,
    );
    const error = await x.call(`reason-${reason}`).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "validation_failed",
      message: expect.stringContaining(text),
      details: { reason, retryable },
    });
    expect(JSON.stringify(error)).not.toMatch(/private|ghs_|fatal/u);
    expect(x.git.checkHead).toHaveBeenCalledTimes(1);
    expect(t.sleeps).toEqual([]);
    expect(x.queued()).toEqual([]);
  },
);

test("an unclassified error is not retried and never echoes its raw text", async () => {
  const t = virtualTime();
  const x = setup(
    async () => {
      throw new Error("fatal: https://user:secret@example.invalid/repo");
    },
    DEFAULT_CHECK_HEAD_RETRY,
    t.io,
  );
  const error = await x.call("unknown").catch((e: unknown) => e);
  expect(error).toMatchObject({
    code: "validation_failed",
    details: { reason: "unknown", retryable: true },
  });
  expect(JSON.stringify(error)).not.toMatch(/secret|example\.invalid/u);
  expect(x.git.checkHead).toHaveBeenCalledTimes(1);
});

test("a missing Git reader is an unavailable environment", async () => {
  await expect(
    retryingCheckHeadReader({}, "P" as never).head({} as never),
  ).rejects.toMatchObject({ reason: "environment_unavailable" });
});

test("the retry helper uses real timers by default", async () => {
  vi.useFakeTimers();
  try {
    let calls = 0;
    const read = readCheckHeadWithRetry(async () => {
      if (++calls === 1) throw new RepositoryLockTimeoutError(1);
      return head;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await read).toBe(head);
    expect(calls).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});
