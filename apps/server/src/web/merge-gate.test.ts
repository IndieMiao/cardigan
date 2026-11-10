import { mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type CardId,
  type DecisionId,
  type Delivery,
  type DeliveryId,
  type MergeCheckView,
  type ProjectId,
  type RunId,
  recordMergeCheck,
  type WorkItemId,
} from "@cardigan/domain";
import type { ProjectMergeGate } from "@cardigan/host";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import { afterEach, beforeEach, expect, test } from "vitest";
import { call, type WebHarness, webHarness } from "../../test-support/web.js";
import {
  NOW,
  project_id,
  seedWebProject,
} from "../../test-support/web-data.js";

let h: WebHarness, cookie: string;
let gate: ProjectMergeGate;
const attempt = "e42de008-2c67-49e2-a59d-077a0f7936de";
const path = (suffix: string) => `/api/projects/${project_id}${suffix}`;
const logPath = path(`/merge-checks/${attempt}`);
const identity = {
  card_id: "C-2" as CardId,
  completion_id: "D-2" as DeliveryId,
  attempt_id: attempt,
  candidate_sha: "a".repeat(40),
  tree_sha: "b".repeat(40),
};
function record(status: MergeCheckView["status"]) {
  h.store.uow.run((tx) => {
    const effect = unwrap(
      recordMergeCheck(
        {
          ...loadCommandState(tx, project_id),
          project_settings: { merge_gate_enabled: true },
        },
        { kind: "system", project_id },
        status === "queued" || status === "running"
          ? { ...identity, status }
          : {
              ...identity,
              status,
              checks: [
                {
                  name: "test",
                  status,
                  duration_ms: 1400,
                  exit_code: status === "passed" ? 0 : 1,
                },
              ],
              summary: "Error: fixture failed",
              log_ref: `${attempt}.log`,
            },
        { ids: tx.ids, clock: { now: () => NOW } },
      ),
    );
    persistEffect(tx, project_id, effect);
  });
}
const read = (suffix: string) => call(h.port, path(suffix), { cookie });
const recheck = (completion_id = "D-2", key = "retry") =>
  call(h.port, path("/cards/C-2/recheck-merge"), {
    cookie,
    method: "POST",
    body: JSON.stringify({ completion_id }),
    headers: {
      origin: h.server.url,
      "content-type": "application/json",
      "idempotency-key": key,
    },
  });
beforeEach(async () => {
  gate = {
    status: "enabled",
    checks: [{ name: "test", run: "true", timeoutMs: 1000 }],
    env: {},
    totalTimeoutMs: 1000,
  };
  h = await webHarness({
    password: "merge-test-password",
    mergeGate: { errors: [], forProject: () => gate },
  });
  seedWebProject(h.store, h.dataDir);
  h.store.uow.run((tx) => {
    const card = tx.cards.get(project_id, "C-2");
    const item = tx.work_items.get(project_id, "W-2");
    const decision = tx.decisions.get(project_id, "D-1");
    if (!card || !item || !decision) throw new Error("Missing fixture");
    tx.cards.put(project_id, { ...card, status: "awaiting_merge" });
    tx.work_items.put(project_id, { ...item, status: "accepted" });
    for (const [id, kind] of [
      ["D-1", "code"],
      ["D-2", "card_completion"],
    ] as const) {
      const delivery: Delivery = {
        id: id as DeliveryId,
        kind,
        work_item_id: "W-2" as WorkItemId,
        run_id: "R-1" as RunId,
        summary: "Ready",
        subject: { kind: "git_head", value: "a".repeat(40) },
        status: "accepted",
        evidence: [],
        attachments: [],
        known_gaps: [],
        requested_verifiers: [],
      };
      tx.deliveries.put(project_id, delivery);
    }
    tx.decisions.put(project_id, {
      ...decision,
      id: "q(2)" as DecisionId,
      key: "q(2)",
      card_id: "C-2" as CardId,
      kind: "approve",
      target: { delivery_id: "D-2" as DeliveryId },
      trigger: "merge_confirmation",
      raised_by: "system",
    });
  });
  cookie = await h.login("merge-test-password");
});
afterEach(async () => h?.close());

test.each(["failed", "timed_out"] as const)(
  "%s is displayed and rechecked once as human with a fresh snapshot",
  async (status) => {
    record("queued");
    record("running");
    record(status);
    const needs = await read("/needs-you");
    expect(needs.json).toMatchObject({
      decisions: expect.arrayContaining([
        expect.objectContaining({
          id: "q(2)",
          merge_confirmation: expect.objectContaining({
            merge_gate_enabled: true,
            merge_check: expect.objectContaining({
              status,
              attempt_id: attempt,
              completion_id: "D-2",
            }),
          }),
        }),
      ]),
    });
    const detail = await read("/cards/C-2");
    expect(detail.json).toMatchObject({
      timeline: expect.arrayContaining([
        expect.objectContaining({
          event_type: "merge_check_finished",
          merge_check: expect.objectContaining({ status }),
        }),
      ]),
    });
    expect((await recheck()).status).toBe(200);
    expect((await recheck()).status).toBe(200);
    const again = await recheck("D-2", "another");
    expect(again.status).toBe(409);
    expect(again.body).toContain("没有失败或超时");
    const events = h.store.uow.read((tx) =>
      loadCommandState(tx, project_id).events.filter(
        (e) => e.type === "merge_check_requeued",
      ),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.actor).toEqual({ kind: "human", project_id });
  },
);

test("only the current completion is shown and a stale request is rejected", async () => {
  record("queued");
  record("running");
  record("failed");
  expect((await recheck("D-99")).body).toContain("完成申请已更新");
  h.store.uow.run((tx) => {
    const old = tx.deliveries.get(project_id, "D-2");
    if (!old) throw new Error("Missing completion");
    tx.deliveries.put(project_id, { ...old, status: "superseded" });
    tx.deliveries.put(project_id, { ...old, id: "D-3" as DeliveryId });
  });
  expect((await read("/needs-you")).json).toMatchObject({
    decisions: expect.arrayContaining([
      expect.objectContaining({
        id: "q(2)",
        merge_confirmation: expect.objectContaining({ merge_check: null }),
      }),
    ]),
  });
  expect((await recheck()).status).toBe(409);
});

test.each(["queued", "running", "passed", "interrupted"] as const)(
  "%s cannot be rechecked",
  async (status) => {
    record("queued");
    if (status !== "queued") record("running");
    if (status !== "queued" && status !== "running") record(status);
    expect((await recheck()).body).toContain("没有失败或超时");
  },
);

test("disabled/invalid gates refuse rechecks and leave Needs You unchanged", async () => {
  record("queued");
  record("running");
  record("failed");
  for (const setting of [
    { status: "disabled" },
    { status: "invalid", reason: "合并闸门配置无效" },
  ] as const) {
    gate = setting;
    const needs = await read("/needs-you");
    expect(needs.body).not.toContain('"merge_check"');
    expect(needs.body).not.toContain('"merge_gate_enabled"');
    expect((await recheck()).status).toBe(409);
  }
});

test("logs require a session, are plain text, read only and isolated to the project", async () => {
  record("queued");
  const dir = join(h.dataDir, "merge-gate", "logs", project_id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${attempt}.log`),
    "<script>fixture</script>\nError: test",
    { mode: 0o600 },
  );
  expect((await call(h.port, logPath)).status).toBe(401);
  expect(
    (
      await call(h.port, logPath, {
        headers: { authorization: "Bearer fixture" },
      })
    ).status,
  ).toBe(401);
  const response = await call(h.port, logPath, { cookie });
  expect(response.status).toBe(200);
  expect(response.headers).toMatchObject({
    "content-type": "text/plain; charset=utf-8",
    "x-content-type-options": "nosniff",
    "cache-control": "private, no-store",
  });
  expect(response.body).toBe("<script>fixture</script>\nError: test");
  h.store.createProject({ id: "other", name: "Other" });
  expect(
    (
      await call(h.port, `/api/projects/other/merge-checks/${attempt}`, {
        cookie,
      })
    ).status,
  ).toBe(404);
  const otherProject = "_other.project" as ProjectId;
  h.store.createProject({ id: otherProject, name: "Named project" });
  const otherDir = join(h.dataDir, "merge-gate", "logs", otherProject);
  await mkdir(otherDir, { recursive: true });
  await writeFile(join(otherDir, `${attempt}.log`), "Other project log");
  // Even a copied log must not make an attempt readable in another project.
  const otherPath = `/api/projects/${otherProject}/merge-checks/${attempt}`;
  expect((await call(h.port, otherPath, { cookie })).status).toBe(404);
  h.store.uow.run((tx) => {
    const source = tx.cards.get(project_id, identity.card_id);
    if (!source) throw new Error("Missing fixture card");
    tx.cards.put(otherProject, { ...source, project_id: otherProject });
    tx.events.append(otherProject, {
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence(otherProject, identity.card_id),
      card_id: identity.card_id,
      type: "merge_check_queued",
      actor: { kind: "system", project_id: otherProject },
      payload: { ...identity, status: "queued" },
      created_at: NOW,
    });
  });
  const other = await call(h.port, otherPath, { cookie });
  expect(other.status).toBe(200);
  expect(other.body).toBe("Other project log");
  expect(
    (
      await call(h.port, logPath, {
        cookie,
        method: "POST",
        headers: { origin: h.server.url },
      })
    ).status,
  ).toBe(405);
  expect(
    (
      await call(h.port, path("/cards/C-2/recheck-merge"), {
        method: "POST",
        headers: { origin: h.server.url },
      })
    ).status,
  ).toBe(401);
  h.store.setWebPassword("replacement-password");
  expect((await call(h.port, logPath, { cookie })).status).toBe(401);
});

test("logs reject traversal, non-UUID names, symlinks and directories", async () => {
  record("queued");
  expect((await read(`/merge-checks/${attempt.toUpperCase()}`)).status).toBe(
    400,
  );
  expect((await read(`/merge-checks/${attempt}`)).status).toBe(404);
  for (const value of [
    "",
    "not-a-uuid",
    `${attempt}.log`,
    "../secret",
    "%2e%2e%2fsecret",
    "..%5csecret",
    "%00",
    "%2Fetc%2Fpasswd",
    `${attempt}/../../secret`,
  ]) {
    const result = await read(`/merge-checks/${value}`);
    expect([400, 404], value).toContain(result.status);
  }
  const dir = join(h.dataDir, "merge-gate", "logs", project_id);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${attempt}.log`),
    secret = join(h.dataDir, "secret");
  await writeFile(secret, "private fixture");
  await symlink(secret, file);
  expect((await read(`/merge-checks/${attempt}`)).status).toBe(404);
  await rm(file);
  await mkdir(file);
  expect((await read(`/merge-checks/${attempt}`)).status).toBe(404);
  await rm(file, { recursive: true });
  await writeFile(file, "private fixture");
  await rename(dir, `${dir}-moved`);
  await symlink(`${dir}-moved`, dir);
  expect((await read(`/merge-checks/${attempt}`)).status).toBe(404);
});
