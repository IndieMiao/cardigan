import { mkdir, open, rename, rm, symlink, writeFile } from "node:fs/promises";
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
import {
  acquireMergeCheckCapacity,
  executionOwner,
  type ProjectMergeGate,
} from "@cardigan/host";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import { routeEvent } from "@cardigan/router";
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
async function setup(machine_id = "local") {
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
  seedWebProject(h.store, h.dataDir, machine_id);
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
      id: "Q-2" as DecisionId,
      key: "Q-2",
      card_id: "C-2" as CardId,
      kind: "approve",
      target: { delivery_id: "D-2" as DeliveryId },
      trigger: "merge_confirmation",
      options: [
        { key: "merge", description: "合并", impact: "更新基线" },
        { key: "hold", description: "暂缓", impact: "等待" },
        { key: "request_changes", description: "退回修改", impact: "修改" },
      ],
      raised_by: "system",
    });
  });
  cookie = await h.login("merge-test-password");
}
beforeEach(() => setup());
afterEach(async () => h?.close());

test.each(["failed", "timed_out"] as const)(
  "C-115: sensitive %s routes only authorized rechecks to PM",
  (status) => {
    h.store.uow.run((tx) => {
      const card = tx.cards.get(project_id, "C-2");
      if (!card) throw new Error("Missing card");
      tx.cards.put(project_id, { ...card, sensitive: true });
    });
    record("queued");
    record("running");
    record(status);
    const state = h.store.uow.read((tx) => loadCommandState(tx, project_id));
    const event = state.events.findLast(
      (e) => e.type === "merge_check_finished",
    );
    if (!event) throw new Error("Missing result");
    const notes = routeEvent({ event, snapshot: state }).notifications;
    expect(notes.map((n) => n.recipient.kind)).toEqual(
      status === "timed_out" ? ["pm_ops"] : [],
    );
    const off = {
      ...state,
      project_preferences: [
        {
          id: project_id,
          auto_merge_after_minutes: null,
          pm_merge_confirmation: false,
        },
      ],
    };
    expect(routeEvent({ event, snapshot: off }).notifications).toEqual([]);
  },
);

test("C-264: pending confirmations stay visible, with the same reasons on both pages and the write API", async () => {
  for (const status of [undefined, "queued", "running", "passed"] as const) {
    if (status) record(status);
    const needs = await read("/needs-you");
    const q = (
      needs.json as {
        decisions: { id: string; merge_confirmation: { blockers: string[] } }[];
      }
    ).decisions.find((q) => q.id === "Q-2");
    expect(q).toBeDefined();
    const blockers = q?.merge_confirmation.blockers ?? [];
    expect(blockers.length).toBe(status === "passed" ? 0 : 1);
    expect(needs.json).toMatchObject({
      waiting_merge_checks_count: 0,
      waiting_merge_check_items: [],
    });
    expect((await read("/cards/C-2")).json).toMatchObject({
      merge_confirmations: [
        expect.objectContaining({
          id: "Q-2",
          merge_confirmation: expect.objectContaining({ blockers }),
        }),
      ],
    });
    const response = await call(h.port, path("/decisions/Q-2/resolve"), {
      cookie,
      method: "POST",
      body: JSON.stringify({ option: "merge" }),
      headers: {
        origin: h.server.url,
        "content-type": "application/json",
        "idempotency-key": `confirm-${status}`,
      },
    });
    if (status === "passed") expect(response.status).toBe(200);
    else {
      expect(response.status).toBe(409);
      expect(JSON.stringify(response.json)).toContain(blockers[0]);
      expect(
        h.store.uow.read((tx) => tx.decisions.get(project_id, "Q-2"))?.status,
      ).toBe("open");
    }
  }
});

test.each(
  (["failed", "timed_out"] as const).flatMap((status) =>
    (["open", "human", "pm"] as const).map((source) => ({ status, source })),
  ),
)(
  "$status ($source confirmation) is listed in Needs You and is rechecked once from its card",
  async ({ status, source }) => {
    if (source !== "open") {
      h.store.uow.run((tx) => {
        const q = tx.decisions.get(project_id, "Q-2");
        if (!q) throw new Error("Missing confirmation");
        tx.decisions.put(project_id, {
          ...q,
          status: "resolved",
          decider: source === "pm" ? "role:pm" : "human",
          resolution: {
            option: "merge",
            rationale: "合并",
            raw_quote: "合并",
            via_chain: [],
            resolved_by: source === "pm" ? "assignment:A-9" : "human",
            via: source === "pm" ? "delegated" : "needs_you",
            at: NOW,
          },
        });
      });
      expect(
        (
          await call(h.port, path("/preferences"), {
            cookie,
            method: "POST",
            body: JSON.stringify({ pm_merge_confirmation: false }),
            headers: {
              origin: h.server.url,
              "content-type": "application/json",
              "idempotency-key": "disable-merge-delegation",
            },
          })
        ).status,
      ).toBe(200);
    }
    record("queued");
    record("running");
    record(status);
    // C-171: the check will not pass by itself, so the human sees it listed.
    const needs = await read("/needs-you");
    expect(needs.json).toMatchObject({
      waiting_merge_checks_count: 0,
      waiting_merge_check_items: [],
      decisions: expect.arrayContaining([
        expect.objectContaining({
          id: "Q-2",
          merge_confirmation: expect.objectContaining({
            merge_gate_enabled: true,
            merge_check: expect.objectContaining({ status }),
          }),
        }),
      ]),
    });
    const detail = await read("/cards/C-2");
    expect(detail.json).toMatchObject({
      merge_confirmations: [
        expect.objectContaining({
          id: "Q-2",
          status: source === "open" ? "open" : "resolved",
          merge_confirmation: expect.objectContaining({
            completion: expect.objectContaining({ id: "D-2" }),
            merge_gate_enabled: true,
            merge_check: expect.objectContaining({
              status,
              completion_id: "D-2",
            }),
          }),
        }),
      ],
      decisions: expect.arrayContaining([
        expect.objectContaining({ id: "Q-2" }),
      ]),
      timeline: expect.arrayContaining([
        expect.objectContaining({
          event_type: "merge_check_finished",
          merge_check: expect.objectContaining({ status }),
        }),
      ]),
    });
    expect((await recheck()).status).toBe(200);
    if (source !== "open")
      expect((await read("/cards/C-2")).json).toMatchObject({
        merge_confirmations: [],
      });
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
  const pending = (await read("/needs-you")).json as {
    decisions: { id: string }[];
  };
  expect(pending.decisions.some((q) => q.id === "Q-2")).toBe(false);
  expect((await read("/cards/C-2")).json).toMatchObject({
    merge_confirmations: [],
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

test("disabled gates stay unchanged; invalid gates expose only a safe flag", async () => {
  record("queued");
  record("running");
  record("failed");
  for (const setting of [
    { status: "disabled" },
    { status: "invalid", reason: "private-config-fixture" },
  ] as const) {
    gate = setting;
    const needs = await read("/needs-you");
    expect(needs.body).not.toContain('"merge_check"');
    expect(needs.body).not.toContain('"merge_gate_enabled"');
    expect(needs.body).not.toContain("private-config-fixture");
    if (setting.status === "invalid") {
      // C-171: a failed check is listed (with the invalid-gate flag), not summarized.
      expect(needs.json).toMatchObject({
        waiting_merge_checks_count: 0,
        decisions: expect.arrayContaining([
          expect.objectContaining({
            id: "Q-2",
            merge_confirmation: expect.objectContaining({
              merge_gate_invalid: true,
            }),
          }),
        ]),
      });
      expect((await read("/cards/C-2")).body).not.toContain(
        "private-config-fixture",
      );
    } else {
      expect(needs.body).not.toContain('"merge_gate_invalid"');
      expect(
        (needs.json as { decisions: { id: string }[] }).decisions.some(
          (q) => q.id === "Q-2",
        ),
      ).toBe(true);
    }
    expect((await recheck()).status).toBe(409);
  }
});

test.each([0, 1])(
  "log response stays within 8 MiB (overflow: %i byte)",
  async (overflow) => {
    record("queued");
    const limit = 8 * 1024 * 1024;
    const dir = join(h.dataDir, "merge-gate", "logs", project_id);
    await mkdir(dir, { recursive: true });
    const file = await open(join(dir, `${attempt}.log`), "w", 0o600);
    try {
      // A sparse fixture tests the boundary without producing check output.
      await file.truncate(limit + overflow);
      await file.write("log start", 0);
      await file.write("omitted middle", Math.floor(limit / 2));
      await file.write("log end", limit + overflow - 7);
    } finally {
      await file.close();
    }
    const response = await read(`/merge-checks/${attempt}`);
    expect(response.status).toBe(200);
    expect(Buffer.byteLength(response.body)).toBe(limit);
    expect(response.body.startsWith("log start")).toBe(true);
    expect(response.body.endsWith("log end")).toBe(true);
    if (overflow) {
      expect(response.body).toContain(
        `日志已截断：原大小 ${limit + overflow} 字节`,
      );
      expect(response.body).toContain("已省略中间内容，以下为日志尾部");
      expect(response.body).not.toContain("omitted middle");
    } else {
      expect(response.body).not.toContain("日志已截断");
      expect(response.body).toContain("omitted middle");
    }
  },
);

test.each([
  ["é", 1],
  ["中", 1],
  ["中", 2],
  ["😀", 1],
  ["😀", 2],
  ["😀", 3],
] as const)(
  "log truncation preserves UTF-8 when %s is split after byte %i",
  async (character, split) => {
    record("queued");
    const limit = 8 * 1024 * 1024;
    const size = limit + 1;
    const marker = `\n\n[日志已截断：原大小 ${size} 字节，超过 8 MiB，已省略中间内容，以下为日志尾部]\n\n`;
    const available = limit - Buffer.byteLength(marker);
    const headEnd = Math.floor(available / 2);
    const tailStart = size - (available - headEnd);
    const dir = join(h.dataDir, "merge-gate", "logs", project_id);
    await mkdir(dir, { recursive: true });
    const file = await open(join(dir, `${attempt}.log`), "w", 0o600);
    try {
      await file.truncate(size);
      await file.write("完整开头", 0);
      // Keep complete neighbours as well as a character crossing each cut.
      const bytes = Buffer.from(`界${character}界`);
      await file.write(
        bytes,
        0,
        bytes.length,
        headEnd - split - Buffer.byteLength("界"),
      );
      await file.write(
        bytes,
        0,
        bytes.length,
        tailStart - split - Buffer.byteLength("界"),
      );
      await file.write("完整结尾", size - Buffer.byteLength("完整结尾"));
    } finally {
      await file.close();
    }
    // Do not use call(): it decodes to a string and masks malformed wire bytes.
    const response = await fetch(`${h.server.url}${logPath}`, {
      headers: { cookie },
    });
    expect(response.status).toBe(200);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.byteLength).toBeLessThanOrEqual(limit);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    expect(text.startsWith("完整开头")).toBe(true);
    expect(text.endsWith("完整结尾")).toBe(true);
    expect(text).toContain(`界${marker}界`);
    expect(text).not.toContain("\uFFFD");
  },
);

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

test("C-145 merge capacity is separate from a same-named Agent and survives card cancellation until process exit", async () => {
  // Start with the target identity in a fresh fixture; assignments cannot move machines.
  await h.close();
  await setup("test-ci");
  if (gate.status !== "enabled") throw new Error("fixture gate missing");
  gate = {
    ...gate,
    executor: {
      name: "test-ci",
      host: "private-host",
      user: "agent",
      port: 22,
      hostKeyAlias: "fixture",
      identityFile: "/private/identity",
      knownHostsFile: "/private/hosts",
      agentRoot: "/private/agent",
      maxConcurrent: 3,
    },
  };
  expect(
    h.store.uow.read((tx) => tx.assignments.get(project_id, "A-1")),
  ).toMatchObject({ machine_id: "test-ci" });
  record("queued");
  expect((await read("/execution/capacity")).json).toMatchObject({
    agents: [
      {
        machine_id: "local",
        running: 0,
        limit: 4,
        queued: 0,
        merge_check_slots: 0,
      },
      {
        machine_id: "test-ci",
        running: 1,
        limit: 4,
        queued: 0,
        merge_check_slots: 0,
      },
    ],
    merge_checks: [{ machine_id: "test-ci", running: 0, limit: 3, queued: 1 }],
  });
  record("running");
  const owner = executionOwner(process.pid);
  if (!owner) throw new Error("missing process identity");
  const release = acquireMergeCheckCapacity(
    h.store,
    project_id,
    attempt,
    owner,
    "test-ci",
  );
  try {
    const running = await read("/execution/capacity");
    expect(running.json).toMatchObject({
      agents: [
        { machine_id: "local", running: 0, limit: 4, merge_check_slots: 0 },
        { machine_id: "test-ci", running: 1, limit: 4, merge_check_slots: 0 },
      ],
      merge_checks: [{ running: 1, limit: 3, queued: 0 }],
    });
    expect(JSON.stringify(running.json)).not.toMatch(
      /private|identityFile|knownHosts|agentRoot/,
    );
    h.store.uow.run((tx) => {
      const card = tx.cards.get(project_id, "C-2");
      if (!card) throw new Error("missing card");
      tx.cards.put(project_id, { ...card, status: "cancelled" });
    });
    expect((await read("/execution/capacity")).json).toMatchObject({
      merge_checks: [{ running: 1, queued: 0 }],
    });
  } finally {
    release();
  }
  expect((await read("/execution/capacity")).json).toMatchObject({
    merge_checks: [{ running: 0, queued: 0 }],
  });
});

test("C-160: Needs You and card detail carry the card's pre-merge checks", async () => {
  h.store.uow.run((tx) => {
    const card = tx.cards.get(project_id, "C-2");
    if (!card) throw new Error("Missing card");
    tx.cards.put(project_id, {
      ...card,
      pre_merge_checks: [
        {
          label: "独立安全审核",
          status: "pending",
          updated_by: "human",
          updated_at: NOW,
        },
        {
          label: "截图核对",
          status: "failed",
          note: "颜色不对",
          updated_by: "human",
          updated_at: NOW,
        },
        ...(["a", "b"] as const).map((sha) => ({
          label: `版本 ${sha}`,
          status: "passed" as const,
          checked_versions: [
            {
              work_item_id: "W-2" as WorkItemId,
              delivery_id: "D-1" as DeliveryId,
              subject: sha.repeat(40),
            },
          ],
          updated_by: "human" as const,
          updated_at: NOW,
        })),
      ],
    });
  });
  record("queued");
  record("running");
  record("passed");
  const expected = [
    { label: "独立安全审核", status: "pending", stale: false, note: null },
    // Recorded without a checked version, so it reads as pending (stale).
    { label: "截图核对", status: "pending", stale: true, note: "颜色不对" },
    // Passed on the current delivery (a×40) holds; passed on b×40 is stale.
    { label: "版本 a", status: "passed", stale: false },
    { label: "版本 b", status: "pending", stale: true },
  ];
  const needs = (await read("/needs-you")).json as {
    decisions: {
      id: string;
      merge_confirmation: { pre_merge_checks: unknown[] } | null;
    }[];
  };
  expect(
    needs.decisions.find((q) => q.id === "Q-2")?.merge_confirmation
      ?.pre_merge_checks,
  ).toMatchObject(expected);
  const detail = (await read("/cards/C-2")).json as {
    merge_confirmations: {
      merge_confirmation: { pre_merge_checks: unknown[] };
    }[];
  };
  expect(
    detail.merge_confirmations[0]?.merge_confirmation.pre_merge_checks,
  ).toMatchObject(expected);
});

test("Q-440: API override requires a reason and audits fresh blockers in the write transaction", async () => {
  record("queued");
  record("running");
  record("passed");
  const before = await read("/needs-you");
  expect(JSON.stringify(before.json)).toContain('"blockers":[]');
  // The screen had a pass; a later control-plane update must be read on write.
  h.store.uow.run((tx) => {
    const card = tx.cards.get(project_id, "C-2");
    if (!card) throw new Error("Missing card");
    tx.cards.put(project_id, {
      ...card,
      pre_merge_checks: [
        {
          label: "截图核对",
          status: "pending",
          updated_by: "human",
          updated_at: NOW,
        },
      ],
    });
  });
  const resolve = (body: object, key: string) =>
    call(h.port, path("/decisions/Q-2/resolve"), {
      cookie,
      method: "POST",
      body: JSON.stringify({ option: "merge", ...body }),
      headers: {
        origin: h.server.url,
        "content-type": "application/json",
        "idempotency-key": key,
      },
    });
  expect((await resolve({}, "normal")).status).toBe(409);
  expect((await resolve({ merge_override_reason: " " }, "blank")).status).toBe(
    400,
  );
  const override = { merge_override_reason: "已人工核实" };
  expect((await resolve(override, "override")).status).toBe(200);
  expect((await resolve(override, "override")).status).toBe(200);
  const state = h.store.uow.read((tx) => loadCommandState(tx, project_id));
  expect(
    state.decisions.find((q) => q.id === "Q-2")?.resolution?.merge_override,
  ).toEqual({ reason: "已人工核实", blockers: ["截图核对：待核"] });
  const events = state.events.filter(
    (e) =>
      e.type === "decision_resolved" &&
      (e.payload as { decision_id?: string }).decision_id === "Q-2",
  );
  expect(events).toHaveLength(1);
  expect(
    state.timeline.some(
      (t) =>
        t.body.includes("强行确认合并") && t.body.includes("截图核对：待核"),
    ),
  ).toBe(true);
});

test.each([
  { name: "blank", reason: " \n\t ", valid: false },
  { name: "499", reason: "字".repeat(499), valid: true },
  { name: "500", reason: "字".repeat(500), valid: true },
  { name: "501", reason: "字".repeat(501), valid: false },
  {
    name: "500 astral plus trim",
    reason: ` \n${"😀".repeat(500)}\t `,
    valid: true,
  },
  { name: "501 astral", reason: "😀".repeat(501), valid: false },
  { name: "500 combining", reason: "e\u0301".repeat(250), valid: true },
  { name: "501 combining", reason: `${"e\u0301".repeat(250)}a`, valid: false },
])(
  "Q-458: HTTP writes enforce $name code-point boundary",
  async ({ reason, valid }) => {
    const snapshot = () =>
      h.store.uow.read((tx) => loadCommandState(tx, project_id));
    const before = JSON.stringify(snapshot());
    const result = await call(h.port, path("/decisions/Q-2/resolve"), {
      cookie,
      method: "POST",
      body: JSON.stringify({ option: "merge", merge_override_reason: reason }),
      headers: {
        origin: h.server.url,
        "content-type": "application/json",
        "idempotency-key": "boundary",
      },
    });
    expect(result.status).toBe(valid ? 200 : 400);
    if (valid) {
      expect(
        snapshot().decisions.find((q) => q.id === "Q-2")?.resolution
          ?.merge_override?.reason,
      ).toBe(reason.trim());
      expect(
        snapshot().timeline.some((t) => t.body.includes(reason.trim())),
      ).toBe(true);
    } else {
      expect(JSON.stringify(snapshot())).toBe(before);
      if (reason.trim())
        expect(JSON.stringify(result.json)).toContain(
          "理由最多500个字符，请缩短后再提交。",
        );
    }
  },
);
