import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  buildExtMessage,
  type Decision,
  extMessageItems,
  type HumanAction,
} from "@cardigan/domain";
import { loadCommandState } from "@cardigan/mcp-server";
import {
  feishuBinding,
  feishuStatus,
  manageFeishuBinding,
  Store,
} from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { card, project_id } from "../../store/src/test-support.js";
import { FeishuApp } from "./feishu-app.js";
import { appScope, type FeishuJob, feishuInbox } from "./feishu-inbox.js";

const c = {
    app_id: "fixture-app",
    app_secret: "fixture-secret",
    tenant_key: "tenant",
  },
  scope = appScope(c);
const h: HumanAction = {
  id: "H-1",
  key: "H-1",
  card_id: "C-1",
  requested_by: "human",
  instructions: "PRIVATE",
  why_human: "private",
  expected_return: "test",
  blocked_work_items: [],
  status: "open",
};
const q: Decision = {
  id: "Q-1",
  key: "Q-1",
  card_id: "C-1",
  kind: "choose",
  raised_by: "human",
  question: "选择",
  context: "private",
  options: [{ key: "ok", description: "同意", impact: "无" }],
  recommended: "ok",
  affected_cards: [],
  affected_work_items: [],
  blocking: false,
  decider: "human",
  doc_refs: [],
  status: "open",
};
let store: Store,
  dir: string,
  now: number,
  db: DatabaseSync,
  app: FeishuApp,
  job: FeishuJob | undefined,
  member: string;
const remote = {
  create: vi.fn(async () => `m-${randomUUID()}`),
  patch: vi.fn(async () => true),
};
let receive: ReturnType<typeof feishuInbox>;
const binding = () => feishuBinding(db, scope);
function issue() {
  return store.uow.run(() => manageFeishuBinding(db, member, "code", now))
    .code!;
}
function redeem(code: string, chat_type = "p2p", open_id = "owner") {
  receive("binding", {
    event_id: randomUUID(),
    app_id: c.app_id,
    tenant_key: c.tenant_key,
    sender: {
      tenant_key: c.tenant_key,
      sender_type: "user",
      sender_id: { open_id },
    },
    message: {
      chat_id: "dm",
      chat_type,
      message_type: "text",
      content: JSON.stringify({ text: code }),
    },
  });
}
async function send(id: string) {
  const s = store.uow.read((tx) => loadCommandState(tx, project_id));
  const i = extMessageItems(s, project_id).find((i) => i.item_id === id)!;
  const port = store.uow.run(() => app.prepare(s, i, null));
  expect(
    await port!.send(
      buildExtMessage(i, "https://workbench.invalid"),
      new AbortController().signal,
    ),
  ).toBe("sent");
  return db
    .prepare(
      "SELECT ref,message FROM feishu_cards WHERE item=? ORDER BY rowid DESC LIMIT 1",
    )
    .get(id)!;
}
const click = (r: Record<string, unknown>, key = "complete", extra = {}) => ({
  app_id: c.app_id,
  tenant_key: c.tenant_key,
  event_id: randomUUID(),
  operator: { tenant_key: c.tenant_key, open_id: "owner" },
  context: { open_chat_id: "dm", open_message_id: r.message },
  action: {
    value: { ref: r.ref, key, operator: "attacker" },
    form_value: { note: "PRIVATE result", member: "intruder" },
  },
  ...extra,
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "feishu-"));
  store = Store.open({ dataDir: dir });
  db = store.database;
  now = Date.now();
  job = undefined;
  remote.create.mockClear();
  remote.patch.mockClear();
  db.prepare(
    "INSERT INTO feishu_runtime(id,scope,state,heartbeat) VALUES(1,?,'connected',?)",
  ).run(scope, now);
  member = String(
    db.prepare("SELECT id FROM members WHERE role='owner'").get()?.id,
  );
  store.createProject({ id: project_id, name: "Fixture" });
  store.uow.run((tx) => {
    tx.cards.put(project_id, card());
    tx.human_actions.put(project_id, h);
    tx.decisions.put(project_id, q);
    for (const [type, payload] of [
      ["human_action_requested", { human_action_id: h.id }],
      ["decision_requested", { decision_id: q.id }],
    ] as const)
      tx.events.append(project_id, {
        id: tx.ids.nextEventId(),
        card_id: "C-1",
        seq: tx.ids.nextEventSequence(project_id, "C-1"),
        type,
        actor: { kind: "human", project_id },
        payload,
        created_at: new Date(now).toISOString(),
      });
  });
  app = new FeishuApp(
    store,
    scope,
    "https://workbench.invalid",
    remote,
    undefined,
    () => now,
  );
  receive = feishuInbox(
    db,
    c,
    (j) => {
      job = j;
    },
    () => now,
  );
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
test("only an active owner can issue a one-time code; no group, expired, superseded, replay or rebind", () => {
  expect(() => manageFeishuBinding(db, "not-an-owner", "code")).toThrow();
  const old = issue(),
    code = issue();
  redeem(old);
  redeem(code, "group");
  expect(binding()).toBeUndefined();
  now += 300000;
  redeem(code);
  expect(binding()).toBeUndefined();
  now -= 300000;
  const valid = issue();
  expect(
    JSON.stringify(db.prepare("SELECT * FROM feishu_codes").all()),
  ).not.toContain(valid);
  redeem(valid);
  const before = binding();
  redeem(valid, "p2p", "other");
  expect(binding()).toEqual(before);
  expect(() => issue()).toThrow();
  expect(feishuStatus(db, now)).toMatchObject({
    state: "connected",
    bound: true,
  });
  expect(feishuStatus(db, now + 61000).state).toBe("offline");
});
test.each(["H-1", "Q-1"])(
  "submit %s only once; receipt retry does not repeat business; audit excludes text",
  async (id) => {
    redeem(issue());
    const r = await send(id),
      key = id === "Q-1" ? "ok" : "complete";
    const ev = click(r, key);
    for (const override of [
      { app_id: "other" },
      { tenant_key: "other" },
      { operator: { open_id: "other", tenant_key: "tenant" } },
      { context: { open_chat_id: "group", open_message_id: r.message } },
      { context: { open_chat_id: "dm", open_message_id: "other" } },
    ])
      receive("action", { ...ev, ...override });
    expect(job).toBeUndefined();
    expect(receive("action", ev)).toMatchObject({
      toast: { content: "处理中" },
    });
    const first = job!;
    job = undefined;
    receive("action", ev);
    expect(job).toBeUndefined();
    app.execute(first);
    app.execute(first);
    expect(
      db
        .prepare("SELECT state FROM feishu_cards WHERE ref=?")
        .get(String(r.ref))?.state,
    ).toBe("done");
    const s = store.uow.read((tx) => loadCommandState(tx, project_id));
    expect(
      s.events.filter((e) => e.type === "ext_message_interaction"),
    ).toHaveLength(1);
    expect(s.timeline.some((t) => t.body.includes("来自飞书"))).toBe(true);
    expect(
      id === "H-1"
        ? s.human_actions[0]?.result?.text
        : s.decisions[0]?.resolution?.rationale,
    ).toBe("PRIVATE result");
    expect(
      JSON.stringify(db.prepare("SELECT * FROM feishu_audit").all()),
    ).not.toContain("PRIVATE");
    remote.patch.mockResolvedValueOnce(false);
    await app.receipts();
    now += 61_000;
    await app.receipts();
    await app.receipts();
    expect(remote.patch).toHaveBeenCalledTimes(2);
  },
);
test.each([
  "version",
  "publish",
  "sensitive",
  "revoked",
  "invalid_member",
  "expired",
  "crash",
])("claim then %s does not write business", async (change) => {
  redeem(issue());
  const r = await send("H-1");
  receive("action", click(r));
  expect(job).toBeDefined();
  if (change === "version" || change === "publish")
    store.uow.run((tx) =>
      tx.human_actions.put(project_id, {
        ...h,
        ...(change === "publish"
          ? { category: "publish" }
          : { expected_return: "changed" }),
      }),
    );
  if (change === "sensitive")
    store.uow.run((tx) => tx.cards.put(project_id, card({ sensitive: true })));
  if (change === "revoked") {
    manageFeishuBinding(db, member, "unbind", now);
    redeem(issue());
  }
  if (change === "invalid_member")
    db.prepare(
      "UPDATE feishu_bindings SET member='unknown' WHERE member=?",
    ).run(member);
  if (change === "expired") now += 86_400_000;
  if (change === "crash") app.recover();
  app.execute(job!);
  expect(
    store.uow.read((tx) => tx.human_actions.get(project_id, h.id)?.status),
  ).toBe("open");
  expect(
    db.prepare("SELECT state FROM feishu_cards WHERE ref=?").get(String(r.ref))
      ?.state,
  ).toBe(change === "crash" ? "failed" : "stale");
});
test("a busy writer cannot delay the SDK acknowledgement by 3 seconds", () => {
  const intake = new DatabaseSync(db.location()!);
  intake.exec("PRAGMA busy_timeout=100");
  try {
    db.exec("BEGIN IMMEDIATE");
    const receive = feishuInbox(intake, c, () => {
      throw Error("not executed");
    });
    const time = performance.now();
    expect(receive("action", {})).toMatchObject({
      toast: { content: expect.stringContaining("未完成") },
    });
    expect(performance.now() - time).toBeLessThan(3000);
  } finally {
    db.exec("ROLLBACK");
    intake.close();
  }
});
