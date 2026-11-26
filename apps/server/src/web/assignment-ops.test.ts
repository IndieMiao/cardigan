import {
  type Runtime,
  type RuntimeRef,
  stopWorkItemAssignment,
} from "@cardigan/domain";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { dispatchFixture } from "../../test-support/dispatch.js";
import { call, type WebHarness, webHarness } from "../../test-support/web.js";
import { type AssignmentOps, MAX_DIFF_PATCH_BYTES } from "./assignment-ops.js";

// C-703: the Workbench starts, stops and reads the changes of an Assignment
// through the same managed flow as the CLI; an Agent's Bearer gets 403.
const PASSWORD = "assignment-ops-password";
let f: ReturnType<typeof dispatchFixture>,
  web: WebHarness,
  cookie: string,
  runtime: Runtime & {
    release: ReturnType<typeof vi.fn>;
    status: ReturnType<typeof vi.fn>;
  },
  ops: AssignmentOps & {
    snapshot: ReturnType<typeof vi.fn>;
    diff: ReturnType<typeof vi.fn>;
  };
beforeEach(async () => {
  f = dispatchFixture();
  runtime = {
    status: vi.fn(async () => ({
      ok: true,
      value: { process: "alive", agent: "working", observed_seq: 1 },
    })),
    wake: vi.fn(async () => ({ ok: true, value: { sent: true } })),
    provision: async () => {
      throw new Error("the Dispatcher launches");
    },
    release: vi.fn(async () => ({ ok: true, value: undefined })),
    interrupt: async () => ({ ok: true, value: undefined }),
    resume_or_replace: async () => {
      throw new Error("unused");
    },
    human_entry: async () => ({ ok: true, value: "fixture" }),
  } as never;
  ops = {
    runtime,
    snapshot: vi.fn(async () => ({
      model: "web-model",
      agent_cli_version: "web-cli",
      launch_profile_ref: "fixture",
    })),
    diff: vi.fn(async () => ({
      worktree_path: "/work/A-1",
      branch: "agent/C-1/W-1",
      head_sha: "a".repeat(40),
      tracked: ["src/a.ts"],
      untracked: ["notes.md"],
      reachable: true,
      patch: "diff --git a/src/a.ts b/src/a.ts\n+one\n",
    })),
  } as never;
  web = await webHarness({
    store: f.store,
    password: PASSWORD,
    assignmentOps: ops,
  });
  cookie = await web.login(PASSWORD);
});
afterEach(async () => {
  await web.close();
  f.close();
});

const path = (id: string, action: string) =>
  `/api/projects/${f.project}/execution/assignments/${id}/${action}`;
const post = (
  id: string,
  action: "start" | "stop",
  key: string | undefined,
  body: unknown = {},
  extra: Record<string, string> = {},
  session: string | null = cookie,
) =>
  call(web.port, path(id, action), {
    method: "POST",
    ...(session === null ? {} : { cookie: session }),
    headers: {
      origin: `http://${web.hostHeader}`,
      "content-type": "application/json",
      ...(key === undefined ? {} : { "idempotency-key": key }),
      ...extra,
    },
    body: JSON.stringify(body),
  });
const assignmentOf = (id: string) =>
  f.store.uow.read((tx) => tx.assignments.get(f.project, id as never));
const runsOf = (id: string) =>
  f.store.uow
    .read((tx) => tx.runs.list(f.project))
    .filter((r) => r.assignment_id === id);
const message = (json: unknown) =>
  (json as { error?: { message?: string } }).error?.message ?? "";

test("an Agent's Bearer gets 403 on start, stop and diff, logged in or not; nothing runs", async () => {
  const { assignment } = f.create();
  const running = f.session(assignment, false);
  const bearer = { authorization: "Bearer agent-token" };
  for (const session of [null, cookie]) {
    for (const action of ["start", "stop"] as const)
      expect(
        (await post(assignment.id, action, "k-agent", {}, bearer, session))
          .status,
      ).toBe(403);
    expect(
      (
        await call(web.port, path(assignment.id, "diff"), {
          headers: bearer,
          ...(session === null ? {} : { cookie: session }),
        })
      ).status,
    ).toBe(403);
  }
  // Without a session (and without a Bearer) the browser is asked to log in.
  expect(
    (await post(assignment.id, "stop", "k-anon", {}, {}, null)).status,
  ).toBe(401);
  expect(runtime.release).not.toHaveBeenCalled();
  expect(ops.snapshot).not.toHaveBeenCalled();
  expect(ops.diff).not.toHaveBeenCalled();
  expect(runsOf(assignment.id).find((r) => r.id === running.id)?.status).toBe(
    "running",
  );
  expect(assignmentOf(assignment.id)?.runtime_ref).not.toBeNull();
});

test("stop releases the terminal, cancels the running Run as the human and replays by key", async () => {
  const { card, assignment } = f.create();
  const running = f.session(assignment, false);
  expect((await post(assignment.id, "stop", undefined)).status).toBe(400);
  const first = await post(assignment.id, "stop", "stop-1");
  expect(first.status).toBe(200);
  expect(first.json).toEqual({ released: true, aborted: true, held: false });
  expect(runtime.release).toHaveBeenCalledTimes(1);
  const run = runsOf(assignment.id).find((r) => r.id === running.id);
  expect(run).toMatchObject({
    status: "cancelled",
    summary: "由人在 Workbench 停止",
  });
  expect(assignmentOf(assignment.id)?.runtime_ref).toBeNull();
  const stopped = f.store
    .getUpdates({ project_id: f.project, card_id: card.id })
    .events.filter((e) => e.type === "assignment_stopped");
  expect(stopped).toHaveLength(1);
  expect(stopped[0]?.actor.kind).toBe("human");
  // The same key answers from the record: no second release.
  const again = await post(assignment.id, "stop", "stop-1");
  expect(again.status).toBe(200);
  expect(again.json).toEqual(first.json);
  expect(runtime.release).toHaveBeenCalledTimes(1);
  // A new key has nothing left to stop.
  const nothing = await post(assignment.id, "stop", "stop-2");
  expect(nothing.status).toBe(409);
  expect(message(nothing.json)).toContain("没有可停止的内容");
});

test("a failed release keeps the session and the Run, says why, and a retry finishes the stop", async () => {
  const { assignment } = f.create();
  const running = f.session(assignment, false);
  runtime.release.mockResolvedValueOnce({
    ok: false,
    error: { code: "runtime_conflict", message: "终端正忙" },
  });
  const failed = await post(assignment.id, "stop", "stop-fail");
  expect(failed.status).toBe(409);
  expect(failed.json).toMatchObject({ error: { code: "stop_failed" } });
  expect(message(failed.json)).toContain("终端正忙");
  expect(assignmentOf(assignment.id)?.runtime_ref).not.toBeNull();
  expect(runsOf(assignment.id).find((r) => r.id === running.id)?.status).toBe(
    "running",
  );
  const retried = await post(assignment.id, "stop", "stop-retry");
  expect(retried.status).toBe(200);
  expect(assignmentOf(assignment.id)?.runtime_ref).toBeNull();
  expect(runsOf(assignment.id).find((r) => r.id === running.id)?.status).toBe(
    "cancelled",
  );
});

test("start queues one Run with the Dispatcher's snapshot as the human; the key replays it", async () => {
  const { assignment } = f.create();
  f.session(assignment);
  const before = runsOf(assignment.id).length;
  const started = await post(assignment.id, "start", "start-1");
  expect(started.status).toBe(200);
  const { run_id } = started.json as { run_id: string };
  const queued = runsOf(assignment.id).find((r) => r.id === run_id);
  expect(queued).toMatchObject({
    status: "queued",
    model: "web-model",
    agent_cli_version: "web-cli",
  });
  expect(ops.snapshot).toHaveBeenCalledTimes(1);
  const again = await post(assignment.id, "start", "start-1");
  expect(again.json).toEqual(started.json);
  expect(runsOf(assignment.id)).toHaveLength(before + 1);
  // A different body under the same key is a conflict, not a second start.
  expect(
    (await post(assignment.id, "start", "start-1", { restart: true })).status,
  ).toBe(409);
  expect(
    (await post(assignment.id, "start", "start-2", { force: true })).status,
  ).toBe(400);
  expect(runsOf(assignment.id)).toHaveLength(before + 1);
});

test("start refuses while a Run is unfinished; restart stops that session first", async () => {
  const { assignment } = f.create();
  const running = f.session(assignment, false);
  const refused = await post(assignment.id, "start", "start-busy");
  expect(refused.status).toBe(409);
  expect(runtime.release).not.toHaveBeenCalled();
  const restarted = await post(assignment.id, "start", "restart-1", {
    restart: true,
  });
  expect(restarted.status).toBe(200);
  expect(runtime.release).toHaveBeenCalledTimes(1);
  expect(runsOf(assignment.id).find((r) => r.id === running.id)?.status).toBe(
    "cancelled",
  );
  const { run_id } = restarted.json as { run_id: string };
  expect(runsOf(assignment.id).find((r) => r.id === run_id)?.status).toBe(
    "queued",
  );
  expect(assignmentOf(assignment.id)?.runtime_ref).toBeNull();
});

test("restart without proof that the old session exited starts nothing", async () => {
  const { assignment } = f.create();
  f.session(assignment, false);
  // The terminal was already gone: its release proves nothing about the process.
  runtime.status.mockResolvedValue({
    ok: false,
    error: { code: "runtime_not_found", message: "gone" },
  });
  const ref = assignmentOf(assignment.id)?.runtime_ref as RuntimeRef;
  const failed = await post(assignment.id, "start", "restart-unproven", {
    restart: true,
  });
  expect(failed.status).toBe(409);
  expect(message(failed.json)).toContain("不会另起会话");
  expect(assignmentOf(assignment.id)?.runtime_ref).toEqual(ref);
  // The snapshot comes first; nothing is queued without the proof.
  expect(ops.snapshot).toHaveBeenCalledTimes(1);
  expect(
    runsOf(assignment.id).filter((r) => r.status === "queued"),
  ).toHaveLength(0);
});

test("after a pause whose release failed, start is refused and restart still needs a proven exit", async () => {
  const { assignment } = f.create();
  f.session(assignment, false);
  const ref = assignmentOf(assignment.id)?.runtime_ref as RuntimeRef;
  // `assignment stop --hold` recorded, terminal not released yet.
  f.apply((s, a, p) =>
    stopWorkItemAssignment(
      s,
      a,
      { assignment_id: assignment.id, reason: "paused", hold: true },
      p,
    ),
  );
  const refused = await post(assignment.id, "start", "start-paused");
  expect(refused.status).toBe(409);
  expect(message(refused.json)).toContain("重启会话");
  // The terminal is gone from the list, but nothing proves the process exited.
  runtime.status.mockResolvedValue({
    ok: false,
    error: { code: "runtime_not_found", message: "gone" },
  });
  const restart = await post(assignment.id, "start", "restart-paused", {
    restart: true,
  });
  expect(restart.status).toBe(409);
  expect(message(restart.json)).toContain("不会另起会话");
  expect(assignmentOf(assignment.id)?.runtime_ref).toEqual(ref);
  expect(
    runsOf(assignment.id).filter((r) => r.status === "queued"),
  ).toHaveLength(0);
});

test("a restart whose snapshot fails leaves the running session alone", async () => {
  const { assignment } = f.create();
  const running = f.session(assignment, false);
  ops.snapshot.mockRejectedValueOnce(
    new Error("The launch profile has no model"),
  );
  const failed = await post(assignment.id, "start", "restart-no-model", {
    restart: true,
  });
  expect(failed.status).toBe(409);
  expect(message(failed.json)).toContain("The launch profile has no model");
  expect(runtime.release).not.toHaveBeenCalled();
  expect(runsOf(assignment.id).find((r) => r.id === running.id)?.status).toBe(
    "running",
  );
});

test("diff reads the worktree changes and cuts an oversized patch at a line end", async () => {
  const { assignment } = f.create();
  const stored = assignmentOf(assignment.id);
  f.store.uow.run((tx) =>
    tx.assignments.put(f.project, {
      ...(stored as never),
      worktree_path: "/work/A-1",
    }),
  );
  const read = await call(web.port, path(assignment.id, "diff"), { cookie });
  expect(read.status).toBe(200);
  expect(read.json).toMatchObject({
    tracked: ["src/a.ts"],
    untracked: ["notes.md"],
    truncated: false,
  });
  ops.diff.mockResolvedValueOnce({
    worktree_path: "/work/A-1",
    head_sha: "b".repeat(40),
    tracked: [],
    untracked: [],
    reachable: false,
    patch: `${"x".repeat(1023)}\n`.repeat(MAX_DIFF_PATCH_BYTES / 1024 + 4),
  });
  const big = (await call(web.port, path(assignment.id, "diff"), { cookie }))
    .json as { patch: string; truncated: boolean };
  expect(big.truncated).toBe(true);
  expect(big.patch.length).toBe(MAX_DIFF_PATCH_BYTES);
  expect(big.patch.endsWith("\n")).toBe(true);
  ops.diff.mockRejectedValueOnce(new Error("worker 暂时无法连接"));
  const failed = await call(web.port, path(assignment.id, "diff"), { cookie });
  expect(failed.status).toBe(409);
  expect(message(failed.json)).toContain("worker 暂时无法连接");
  expect(
    (
      await call(web.port, path(assignment.id, "diff"), {
        method: "POST",
        cookie,
        headers: { origin: `http://${web.hostHeader}` },
      })
    ).status,
  ).toBe(405);
});
