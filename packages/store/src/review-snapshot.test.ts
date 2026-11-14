/**
 * C-267: the review snapshot scrubber and its pre-publish scanner.
 *
 * The fixture database carries every class of sensitive data the card names;
 * the scrubbed copy must pass the scan and still open as a normal store, and
 * each class planted back into a scrubbed copy must be caught by the scan
 * without the hit report repeating the value.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  collectSensitiveValues,
  REDACTED,
  REDACTED_PATH,
  type ScanResult,
  type SensitiveValues,
  scanReviewSnapshot,
  scrubReviewSnapshot,
} from "./review-snapshot.js";
import { Store } from "./store.js";

const P = "alpha";
const OTHER = "beta-secret";
const NOW = "2026-11-14T00:00:00.000Z";
const TOKEN = "Abcdefghij0123456789KLMNOPqrstuvwxyz_-01234";
const MEMBER_NAME = "林晓梅";
const HOSTNAME = "lin-workstation";
const SENSITIVE_TITLE = "收购计划草案第二版（内部）";
const SENSITIVE_COMMENT = "这是一条敏感评论内容，绝对不应该泄露出去";
/** Name, title and avatar a member had before being renamed (V-911). */
const OLD_NAME = "邵旧名";
const OLD_TITLE = "前任首席顾问";
const OLD_AVATAR = "upload:0123456789abcdef.png";
const SHORT_TITLE = "并购甲方";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cardigan-review-snapshot-"));
  dbPath = join(dir, "cardigan.db");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const card = (
  project: string,
  id: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  project_id: project,
  title: `${id} 标题`,
  goal: "普通目标",
  acceptance_criteria: ["普通标准"],
  source: { kind: "quote", text: "普通来源" },
  out_of_scope: [],
  related_cards: [],
  priority: 3,
  status: "in_progress",
  template: "dev",
  created_by: "human",
  created_at: NOW,
  ...extra,
});

/** A production-like database with every class of sensitive data. */
function buildFixture(): void {
  const store = Store.open({ dbPath });
  store.createProject({ id: P });
  store.createProject({ id: OTHER });
  store.setProjectRepo({ project_id: P, repo_path: "/home/lin/code/alpha" });
  store.setWebPassword("correct horse battery staple");
  store.createWebSession();
  store.issueToken({
    project_id: P,
    assignment_id: "A-1",
    role: { role_version: 1, allowed_tools: ["get_card"] },
    token: TOKEN,
  });
  store.close();

  const db = new DatabaseSync(dbPath);
  const insert = (sql: string, ...values: (string | number | null)[]) =>
    db.prepare(sql).run(...values);
  const doc = (value: unknown) => JSON.stringify(value);

  insert(
    "INSERT INTO members (id, role, status, doc) VALUES (?, 'approver', 'active', ?)",
    "M-9",
    doc({
      id: "M-9",
      name: MEMBER_NAME,
      title: "财务总监",
      avatar: "custom:lin.png",
      role: "approver",
      status: "active",
      created_at: NOW,
      updated_at: NOW,
    }),
  );
  insert(
    "INSERT INTO global_events (id, seq, type, doc) VALUES ('GE-x', 9999, 'member_created', ?)",
    doc({
      type: "member_created",
      payload: { member: { id: "M-9", name: MEMBER_NAME } },
    }),
  );
  // M-8 was renamed: the old identity survives only in global_events.
  const m8 = (name: string, title: string, avatar: string | null) => ({
    id: "M-8",
    name,
    title,
    avatar,
    role: "observer",
    status: "active",
    created_at: NOW,
    updated_at: NOW,
  });
  insert(
    "INSERT INTO members (id, role, status, doc) VALUES ('M-8', 'observer', 'active', ?)",
    doc(m8("邵新名", "顾问", null)),
  );
  insert(
    "INSERT INTO global_events (id, seq, type, doc) VALUES ('GE-a', 9997, 'member_created', ?)",
    doc({
      type: "member_created",
      actor: { kind: "human" },
      payload: { member: m8(OLD_NAME, OLD_TITLE, OLD_AVATAR) },
    }),
  );
  insert(
    "INSERT INTO global_events (id, seq, type, doc) VALUES ('GE-b', 9998, 'member_updated', ?)",
    doc({
      type: "member_updated",
      actor: { kind: "human" },
      payload: { member: m8("邵新名", "顾问", null) },
    }),
  );

  // Ordinary card: free text with paths, IPs, e-mail, a pasted Token, the
  // other project's id and a reference to the sensitive card.
  insert(
    "INSERT INTO cards (project_id, id, doc) VALUES (?, 'C-1', ?)",
    P,
    doc(
      card(P, "C-1", {
        goal: `见 /home/lin/notes.txt 和 10.0.0.12、fe80:0:0:0:1:2:3:4，联系 lin@example.org，参考项目 ${OTHER}`,
        related_cards: ["C-2"],
      }),
    ),
  );
  insert(
    "INSERT INTO timeline (project_id, id, card_id, event_seq, doc) VALUES (?, 'C-1#1', 'C-1', 1, ?)",
    P,
    doc({
      id: "C-1#1",
      card_id: "C-1",
      type: "comment",
      body: `${MEMBER_NAME} 说可以；token=${TOKEN}；hash scrypt$16384$8$1$abc$def；主机 ${HOSTNAME} 上 C:\\Users\\lin\\x`,
      created_at: NOW,
    }),
  );

  // Sensitive card and everything tied to it.
  insert(
    "INSERT INTO cards (project_id, id, doc) VALUES (?, 'C-2', ?)",
    P,
    doc(
      card(P, "C-2", {
        title: SENSITIVE_TITLE,
        goal: "敏感目标内容的详细描述文字",
        sensitive: true,
      }),
    ),
  );
  insert(
    "INSERT INTO timeline (project_id, id, card_id, event_seq, doc) VALUES (?, 'C-2#1', 'C-2', 1, ?)",
    P,
    doc({
      id: "C-2#1",
      card_id: "C-2",
      type: "comment",
      body: SENSITIVE_COMMENT,
      created_at: NOW,
    }),
  );
  insert(
    "INSERT INTO events (project_id, id, card_id, stream, seq, type, doc) VALUES (?, 'E-1', 'C-2', 'C-2', 1, 'card_created', ?)",
    P,
    doc({
      id: "E-1",
      card_id: "C-2",
      type: "card_created",
      payload: { title: SENSITIVE_TITLE },
    }),
  );
  insert(
    "INSERT INTO events (project_id, id, card_id, stream, seq, type, doc) VALUES (?, 'E-2', NULL, 'project', 1, 'decision_requested', ?)",
    P,
    doc({
      id: "E-2",
      type: "decision_requested",
      payload: {
        affected_cards: ["C-2"],
        question: "关于敏感卡片的问题正文内容",
      },
    }),
  );
  insert(
    "INSERT INTO work_items (project_id, id, card_id, doc) VALUES (?, 'W-1', 'C-2', ?)",
    P,
    doc({
      id: "W-1",
      card_id: "C-2",
      title: "敏感工作项的标题文字",
      status: "todo",
      completion_criteria: ["敏感完成标准的详细内容"],
    }),
  );
  insert(
    "INSERT INTO deliveries (project_id, id, work_item_id, doc) VALUES (?, 'D-1', 'W-1', ?)",
    P,
    doc({
      id: "D-1",
      work_item_id: "W-1",
      summary: "敏感交付摘要的详细内容",
      created_at: NOW,
    }),
  );
  insert(
    "INSERT INTO attachments (project_id, id, sha256, doc) VALUES (?, 'AT-1', ?, ?)",
    P,
    "a".repeat(64),
    doc({
      id: "AT-1",
      card_id: "C-2",
      original_filename: "收购尽调报告最终版.pdf",
      storage_path: "/srv/cardigan/data/attachments/aa",
      sha256: "a".repeat(64),
    }),
  );
  insert(
    "INSERT INTO machines (project_id, id, doc) VALUES (?, 'MC-1', ?)",
    P,
    doc({
      id: "MC-1",
      label: HOSTNAME,
      herdr_machine: `${HOSTNAME}.local`,
      os: "linux",
      status: "online",
    }),
  );
  insert(
    "INSERT INTO idempotency (project_id, assignment_id, key, request_hash, response, created_at) VALUES (?, 'A-1', 'k', 'h', ?, ?)",
    P,
    doc({ body: SENSITIVE_COMMENT }),
    NOW,
  );

  // A sensitive card with a short title, quoted by number-less text elsewhere.
  insert(
    "INSERT INTO cards (project_id, id, doc) VALUES (?, 'C-3', ?)",
    P,
    doc(card(P, "C-3", { title: SHORT_TITLE, sensitive: true })),
  );
  insert(
    "INSERT INTO timeline (project_id, id, card_id, event_seq, doc) VALUES (?, 'C-1#2', 'C-1', 2, ?)",
    P,
    doc({
      id: "C-1#2",
      card_id: "C-1",
      type: "comment",
      body: `关于${SHORT_TITLE}的进展`,
      created_at: NOW,
    }),
  );

  // Another project's data.
  insert(
    "INSERT INTO cards (project_id, id, doc) VALUES (?, 'C-1', ?)",
    OTHER,
    doc(card(OTHER, "C-1", { title: "beta 项目的机密卡片" })),
  );
  insert(
    "INSERT INTO events (project_id, id, card_id, stream, seq, type, doc) VALUES (?, 'E-9', 'C-1', 'C-1', 1, 'card_created', ?)",
    OTHER,
    doc({ id: "E-9", type: "card_created" }),
  );
  db.close();
}

function prepare(): { db: DatabaseSync; values: SensitiveValues } {
  buildFixture();
  const db = new DatabaseSync(dbPath);
  const values = collectSensitiveValues(db, P, { hostnames: [HOSTNAME] });
  return { db, values };
}

const docOf = (db: DatabaseSync, sql: string, ...args: string[]) =>
  JSON.parse(String(db.prepare(sql).get(...args)?.doc)) as Record<
    string,
    unknown
  >;

function addNotification(
  db: DatabaseSync,
  id: string,
  cardId: string,
  recipient: { kind: string; assignment_id?: string },
): void {
  const eventId = `E-${cardId}`;
  if (!db.prepare("SELECT 1 FROM events WHERE id = ?").get(eventId))
    db.prepare(
      "INSERT INTO events (project_id, id, card_id, stream, seq, type, doc) VALUES (?, ?, ?, ?, 10, 'comment_posted', ?)",
    ).run(
      P,
      eventId,
      cardId,
      cardId,
      JSON.stringify({ id: eventId, card_id: cardId }),
    );
  const doc = {
    id,
    project_id: P,
    event_id: eventId,
    card_id: cardId,
    recipient,
    seq: 10,
    kind: "comment",
    status: "pending",
    attempts: 0,
    bell: SENSITIVE_COMMENT,
    created_at: NOW,
    updated_at: NOW,
  };
  db.prepare(
    "INSERT INTO notifications (project_id, id, event_id, recipient_kind, assignment_id, card_id, seq, kind, status, doc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    P,
    id,
    eventId,
    recipient.kind,
    recipient.assignment_id ?? "",
    cardId,
    doc.seq,
    doc.kind,
    doc.status,
    JSON.stringify(doc),
  );
}

const notificationRows = (db: DatabaseSync) =>
  db
    .prepare("SELECT * FROM notifications ORDER BY id")
    .all()
    .map((row) => ({
      ...row,
      doc: JSON.parse(String(row.doc)),
    }));

describe("scrub", () => {
  test("preserves all recipients of the same sensitive event without unique-key collisions", () => {
    buildFixture();
    const db = new DatabaseSync(dbPath);
    try {
      const recipients = [
        { kind: "needs_you" },
        { kind: "pm_office" },
        { kind: "pm_ops" },
        { kind: "assignment", assignment_id: "A-1" },
        { kind: "assignment", assignment_id: "A-2" },
      ];
      recipients.forEach((recipient, i) => {
        addNotification(db, `N-${i}`, "C-2", recipient);
      });
      const before = notificationRows(db);
      const values = collectSensitiveValues(db, P);
      expect(() => scrubReviewSnapshot(db, values)).not.toThrow();
      expect(notificationRows(db)).toEqual(
        before.map((row) => ({
          ...row,
          doc: { ...row.doc, bell: REDACTED },
        })),
      );
      expect(notificationRows(db)).toHaveLength(5);
      expect(scanReviewSnapshot(db, values).hits).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("a single sensitive notification does not contaminate ordinary recipient enums", () => {
    buildFixture();
    const db = new DatabaseSync(dbPath);
    try {
      addNotification(db, "N-sensitive", "C-2", { kind: "needs_you" });
      addNotification(db, "N-ordinary", "C-1", { kind: "needs_you" });
      // Only recipient_kind is exempted, not arbitrary *_kind text fields.
      db.prepare(
        "UPDATE cards SET doc = json_set(doc, '$.private_kind', ?) WHERE id = 'C-2'",
      ).run("敏感自定义分类的正文内容");
      const before = notificationRows(db);
      const values = collectSensitiveValues(db, P);
      const collected = [...values.words, ...values.literals].map(
        (v) => v.value,
      );
      for (const kind of ["needs_you", "pm_office", "pm_ops", "assignment"])
        expect(collected).not.toContain(kind);
      expect(collected).toContain("敏感自定义分类的正文内容");
      scrubReviewSnapshot(db, values);
      expect(notificationRows(db)).toEqual(
        before.map((row) => ({
          ...row,
          doc: { ...row.doc, bell: REDACTED },
        })),
      );
      expect(
        docOf(db, "SELECT doc FROM cards WHERE id = 'C-2'").private_kind,
      ).toBe(REDACTED);
      expect(scanReviewSnapshot(db, values).hits).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("a scrubbed fixture passes the scan and keeps the project usable", () => {
    const { db, values } = prepare();
    const triggers = Number(
      db
        .prepare(
          "SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger'",
        )
        .get()?.n,
    );
    const before = scanReviewSnapshot(db, values);
    expect(before.passed).toBe(false);

    scrubReviewSnapshot(db, values);
    const result = scanReviewSnapshot(db, values);
    expect(result.hits).toEqual([]);
    expect(result.passed).toBe(true);

    // ① credentials gone.
    for (const table of [
      "tokens",
      "web_credential",
      "web_sessions",
      "idempotency",
    ])
      expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n).toBe(0);
    // ② only the project remains.
    expect(
      db
        .prepare("SELECT id FROM projects")
        .all()
        .map((r) => r.id),
    ).toEqual([P]);
    expect(
      db.prepare("SELECT count(*) AS n FROM cards WHERE project_id <> ?").get(P)
        ?.n,
    ).toBe(0);
    // ③ the sensitive card is a numbered skeleton.
    const c2 = docOf(db, "SELECT doc FROM cards WHERE id = 'C-2'");
    expect(c2).toMatchObject({
      id: "C-2",
      status: "in_progress",
      title: REDACTED,
      sensitive: true,
    });
    expect(
      docOf(db, "SELECT doc FROM work_items WHERE id = 'W-1'"),
    ).toMatchObject({
      id: "W-1",
      card_id: "C-2",
      status: "todo",
      title: REDACTED,
    });
    expect(docOf(db, "SELECT doc FROM events WHERE id = 'E-2'")).toMatchObject({
      payload: { affected_cards: ["C-2"], question: REDACTED },
    });
    const attachment = docOf(
      db,
      "SELECT doc FROM attachments WHERE id = 'AT-1'",
    );
    expect(attachment).toMatchObject({
      id: "AT-1",
      card_id: "C-2",
      original_filename: REDACTED,
      sha256: REDACTED,
    });
    // An ordinary card that only links to it keeps its own text.
    const c1 = docOf(db, "SELECT doc FROM cards WHERE id = 'C-1'");
    expect(c1.title).toBe("C-1 标题");
    expect(c1.related_cards).toEqual(["C-2"]);
    // ④ people, hosts, paths, IPs, e-mail.
    expect(String(c1.goal)).toBe(
      `见 ${REDACTED_PATH} 和 [IP]、[IP]，联系 [邮箱]，参考项目 [其它项目]`,
    );
    const comment = String(
      docOf(db, "SELECT doc FROM timeline WHERE id = 'C-1#1'").body,
    );
    expect(comment).not.toContain(MEMBER_NAME);
    expect(comment).not.toContain(TOKEN);
    expect(comment).not.toContain(HOSTNAME);
    expect(comment).not.toContain("scrypt$");
    expect(docOf(db, "SELECT doc FROM members WHERE id = 'M-9'")).toMatchObject(
      { name: "成员 M-9", title: "成员", avatar: null },
    );
    // Historical member snapshots (renames) are masked too.
    for (const id of ["GE-a", "GE-b"])
      expect(
        (
          docOf(db, "SELECT doc FROM global_events WHERE id = ?", id)
            .payload as {
            member: unknown;
          }
        ).member,
      ).toMatchObject({
        id: "M-8",
        name: "成员 M-8",
        title: "成员",
        avatar: null,
      });
    const allText = db
      .prepare(
        "SELECT doc FROM global_events UNION ALL SELECT doc FROM members",
      )
      .all()
      .map((r) => String(r.doc))
      .join("\n");
    for (const old of [OLD_NAME, OLD_TITLE, OLD_AVATAR, "邵新名"])
      expect(allText).not.toContain(old);
    expect(
      String(docOf(db, "SELECT doc FROM timeline WHERE id = 'C-1#2'").body),
    ).not.toContain(SHORT_TITLE);
    expect(
      docOf(db, "SELECT doc FROM machines WHERE id = 'MC-1'"),
    ).toMatchObject({ label: "机器 MC-1", os: "linux" });
    expect(db.prepare("SELECT repo_path FROM projects").get()?.repo_path).toBe(
      REDACTED_PATH,
    );

    // Triggers are restored unchanged.
    expect(
      Number(
        db
          .prepare(
            "SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger'",
          )
          .get()?.n,
      ),
    ).toBe(triggers);
    db.close();

    // The copy still opens as a store (migrations run on open).
    const store = Store.open({ dbPath });
    expect(store.getProject(P)?.id).toBe(P);
    store.close();
  });

  test("VACUUM INTO leaves no deleted value in the file bytes", () => {
    const { db, values } = prepare();
    scrubReviewSnapshot(db, values);
    const out = join(dir, "out.db");
    db.exec(`VACUUM INTO '${out}'`);
    db.close();
    const copy = new DatabaseSync(out);
    const result = scanReviewSnapshot(copy, values, readFileSync(out));
    copy.close();
    expect(result.passed).toBe(true);
    const bytes = readFileSync(out).toString("utf8");
    for (const value of [
      SENSITIVE_TITLE,
      SENSITIVE_COMMENT,
      MEMBER_NAME,
      "beta 项目的机密卡片",
    ])
      expect(bytes).not.toContain(value);
  });
});

describe("scan blocks every class", () => {
  test.each([
    {
      name: "a placeholder in both representations",
      kind: REDACTED,
      assignment: "",
      recipient: { kind: REDACTED },
      rule: "notification_recipient_kind",
      column: "recipient_kind",
    },
    {
      name: "an unknown kind",
      kind: "unknown_recipient",
      assignment: "",
      recipient: { kind: "unknown_recipient" },
      rule: "notification_recipient_kind",
      column: "recipient_kind",
    },
    {
      name: "a different JSON kind",
      kind: "needs_you",
      assignment: "",
      recipient: { kind: "pm_office" },
    },
    {
      name: "a placeholder JSON kind",
      kind: "needs_you",
      assignment: "",
      recipient: { kind: REDACTED },
    },
    {
      name: "a different assignment",
      kind: "assignment",
      assignment: "A-1",
      recipient: { kind: "assignment", assignment_id: "A-2" },
    },
    {
      name: "a missing JSON assignment",
      kind: "assignment",
      assignment: "A-1",
      recipient: { kind: "assignment" },
    },
    {
      name: "an empty assignment",
      kind: "assignment",
      assignment: "",
      recipient: { kind: "assignment", assignment_id: "" },
    },
    {
      name: "an assignment on a logical recipient column",
      kind: "pm_ops",
      assignment: "A-1",
      recipient: { kind: "pm_ops" },
    },
    {
      name: "an assignment on a logical JSON recipient",
      kind: "pm_office",
      assignment: "",
      recipient: { kind: "pm_office", assignment_id: "A-1" },
    },
    {
      name: "a missing recipient",
      kind: "needs_you",
      assignment: "",
      recipient: undefined,
    },
    {
      name: "a null recipient",
      kind: "needs_you",
      assignment: "",
      recipient: null,
    },
    {
      name: "a non-object recipient",
      kind: "needs_you",
      assignment: "",
      recipient: REDACTED,
    },
  ])(
    "rejects $name independently of sensitive-card skeleton checks",
    ({ kind, assignment, recipient, rule, column }) => {
      const { db, values } = prepare();
      try {
        addNotification(db, "N-ordinary", "C-1", { kind: "needs_you" });
        scrubReviewSnapshot(db, values);
        const doc = docOf(
          db,
          "SELECT doc FROM notifications WHERE id = 'N-ordinary'",
        );
        db.prepare(
          "UPDATE notifications SET recipient_kind = ?, assignment_id = ?, doc = ? WHERE id = 'N-ordinary'",
        ).run(kind, assignment, JSON.stringify({ ...doc, recipient }));
        const rowid = Number(
          db
            .prepare(
              "SELECT rowid AS r FROM notifications WHERE id = 'N-ordinary'",
            )
            .get()?.r,
        );
        const result = scanReviewSnapshot(db, values);
        expect(result.passed).toBe(false);
        expect(result.hits).toContainEqual({
          rule: rule ?? "notification_recipient_consistency",
          category: "sensitive_card",
          table: "notifications",
          rowid,
          column: column ?? "doc",
          where: "table",
        });
        expect(
          result.hits.some((hit) => hit.rule === "sensitive_card_skeleton"),
        ).toBe(false);
        expect(JSON.stringify(result)).not.toContain("unknown_recipient");
        expect(JSON.stringify(result)).not.toContain(REDACTED);
      } finally {
        db.close();
      }
    },
  );

  const leaks: ReadonlyArray<{
    name: string;
    category: string;
    plant: (db: DatabaseSync) => void;
    secret?: string;
  }> = [
    {
      name: "a token row",
      category: "credential",
      plant: (db) =>
        db.exec(
          "INSERT INTO tokens VALUES ('tok_x', 'alpha', 'A-1', 1, '[]', 'h', 'now', NULL)",
        ),
    },
    {
      name: "a pasted Assignment Token",
      category: "credential",
      secret: TOKEN,
      plant: (db) => comment(db, `token ${TOKEN}`),
    },
    {
      name: "a password hash",
      category: "credential",
      plant: (db) => comment(db, "scrypt$16384$8$1$c2FsdA$ZGVyaXZlZA"),
    },
    {
      name: "a private key",
      category: "credential",
      plant: (db) =>
        comment(
          db,
          "-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbg==\n-----END OPENSSH PRIVATE KEY-----",
        ),
    },
    {
      name: "another project's row",
      category: "other_project",
      plant: (db) =>
        db.exec(`INSERT INTO cards VALUES ('${OTHER}', 'C-7', '{"id":"C-7"}')`),
    },
    {
      name: "another project's id in text",
      category: "other_project",
      secret: OTHER,
      plant: (db) => comment(db, `参见 ${OTHER} 项目`),
    },
    {
      name: "a sensitive card's title restored",
      category: "sensitive_card",
      secret: SENSITIVE_TITLE,
      plant: (db) =>
        db
          .prepare(
            "UPDATE cards SET doc = json_set(doc, '$.title', ?) WHERE id = 'C-2'",
          )
          .run(SENSITIVE_TITLE),
    },
    {
      name: "a sensitive comment quoted on another card",
      category: "sensitive_card",
      secret: SENSITIVE_COMMENT,
      plant: (db) => comment(db, `转述：${SENSITIVE_COMMENT}`),
    },
    {
      name: "a renamed member's old name in a global event",
      category: "personal",
      secret: OLD_NAME,
      plant: (db) =>
        db
          .prepare(
            "UPDATE global_events SET doc = json_set(doc, '$.payload.member.name', ?) WHERE id = 'GE-a'",
          )
          .run(OLD_NAME),
    },
    {
      name: "a member's custom avatar in a global event",
      category: "personal",
      secret: OLD_AVATAR,
      plant: (db) =>
        db
          .prepare(
            "UPDATE global_events SET doc = json_set(doc, '$.payload.member.avatar', ?) WHERE id = 'GE-a'",
          )
          .run(OLD_AVATAR),
    },
    {
      name: "a short sensitive title quoted without its number",
      category: "sensitive_card",
      secret: SHORT_TITLE,
      plant: (db) => comment(db, `关于${SHORT_TITLE}`),
    },
    {
      name: "a member's name",
      category: "personal",
      secret: MEMBER_NAME,
      plant: (db) => comment(db, `${MEMBER_NAME} 同意`),
    },
    {
      name: "an e-mail address",
      category: "personal",
      secret: "lin@example.org",
      plant: (db) => comment(db, "mail lin@example.org"),
    },
    {
      name: "a home path",
      category: "host",
      secret: "/home/lin",
      plant: (db) => comment(db, "日志在 /home/lin/.cache/x.log"),
    },
    {
      name: "an IP address",
      category: "host",
      secret: "192.168.3.7",
      plant: (db) => comment(db, "连 192.168.3.7"),
    },
    {
      name: "the machine name",
      category: "host",
      secret: HOSTNAME,
      plant: (db) => comment(db, `在 ${HOSTNAME} 上跑`),
    },
    {
      name: "a deploy key path",
      category: "credential",
      plant: (db) => comment(db, "key ~/.ssh/cardigan_deploy"),
    },
  ];

  function comment(db: DatabaseSync, body: string): void {
    db.prepare(
      "UPDATE timeline SET doc = json_set(doc, '$.body', ?) WHERE id = 'C-1#1'",
    ).run(body);
  }

  test.each(leaks)("$name", ({ category, plant, secret }) => {
    const { db, values } = prepare();
    scrubReviewSnapshot(db, values);
    plant(db);
    const result: ScanResult = scanReviewSnapshot(db, values);
    db.close();
    expect(result.passed).toBe(false);
    expect(result.hits.map((h) => h.category)).toContain(category);
    // Hits name a location, never the value.
    if (secret !== undefined)
      expect(JSON.stringify(result)).not.toContain(secret);
    for (const h of result.hits)
      expect(h.table === undefined || typeof h.table === "string").toBe(true);
  });

  test("a deleted value left in free pages is found in the file bytes", () => {
    const { db, values } = prepare();
    scrubReviewSnapshot(db, values);
    db.close();
    // Plant directly in the file without VACUUM: the scan must look at bytes.
    const raw = new DatabaseSync(dbPath);
    raw.exec("PRAGMA secure_delete = OFF");
    raw.exec("CREATE TABLE leak (v TEXT)");
    raw
      .prepare("INSERT INTO leak VALUES (?)")
      .run(SENSITIVE_COMMENT.repeat(50));
    raw.exec("DROP TABLE leak");
    raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const result = scanReviewSnapshot(raw, values, readFileSync(dbPath));
    raw.close();
    expect(result.passed).toBe(false);
    expect(result.hits).toContainEqual(
      expect.objectContaining({ where: "file", category: "sensitive_card" }),
    );
    expect(JSON.stringify(result)).not.toContain(SENSITIVE_COMMENT);
  });

  test("the unscrubbed fixture hits all four row-level classes", () => {
    const { db, values } = prepare();
    const result = scanReviewSnapshot(db, values);
    db.close();
    const categories = new Set(result.hits.map((h) => h.category));
    for (const c of [
      "credential",
      "other_project",
      "sensitive_card",
      "personal",
      "host",
    ])
      expect(categories).toContain(c);
  });
});
