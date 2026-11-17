import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { fileAvatarStore, newUlid, Store } from "@cardigan/store";
import { seedScenarios } from "./synthetic-scenarios.mjs";

export const FIXTURE_NOW = "2026-06-15T12:00:00.000Z";
export const FIXTURE_PROJECT = "synthetic";
export const PROFILES = {
  // C-352: above the published C-399 counts; no production data is read.
  cards: {
    cards: 420,
    work_items: 1500,
    timeline: 27000,
    events: 110000,
    runs: 7000,
    attachments: 4200,
    decisions: 800,
  },
  diagnostics: {
    cards: 337,
    work_items: 1138,
    timeline: 18075,
    events: 55015,
    runs: 5556,
    attachments: 920,
    decisions: 590,
  },
  "needs-you": {
    cards: 318,
    work_items: 1068,
    timeline: 18075,
    events: 42347,
    runs: 5261,
    attachments: 920,
    decisions: 590,
  },
  small: {
    cards: 48,
    work_items: 144,
    timeline: 650,
    events: 1400,
    runs: 220,
    attachments: 48,
    decisions: 56,
  },
  "production-like": {
    cards: 286,
    work_items: 916,
    timeline: 12500,
    events: 32750,
    runs: 4390,
    attachments: 920,
    decisions: 464,
  },
};
// A code-owned, one-pixel PNG; no source files or external assets are read.
export const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMIazoBAALSAaHs/3FDAAAAAElFTkSuQmCC",
  "base64",
);
function recordFixtureNotification(store, input) {
  const doc = {
    ...input,
    recipient: { kind: "needs_you" },
    status: "acked",
    attempts: 0,
    created_at: FIXTURE_NOW,
    updated_at: FIXTURE_NOW,
  };
  store.database
    .prepare(`INSERT INTO notifications
    (project_id,id,event_id,recipient_kind,card_id,seq,kind,status,doc)
    VALUES (?,?,?,'needs_you',?,?,'synthetic','acked',?)`)
    .run(
      input.project_id,
      input.id,
      input.event_id,
      input.card_id ?? null,
      input.seq,
      JSON.stringify(doc),
    );
}
export const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function randomSource(seed) {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value;
  };
}

/** Every table, including migration metadata and indexes, compared as sorted rows. */
export function tableDigests(db) {
  return Object.fromEntries(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map(({ name }) => {
        const rows = db
          .prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`)
          .all();
        return [
          name,
          {
            count: rows.length,
            sha256: hash(
              JSON.stringify(rows.map((row) => JSON.stringify(row)).sort()),
            ),
          },
        ];
      }),
  );
}

/** Only creates a new output directory. Never discovers configuration or an existing DB. */
export async function generateFixture({
  out,
  seed = 287,
  profile = "production-like",
  sensitiveNeeds = false,
} = {}) {
  if (typeof out !== "string" || !out.trim())
    throw new Error("必须指定新的输出目录 --out");
  if (!Object.hasOwn(PROFILES, profile)) throw new Error("未知数据档位");
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
    throw new Error("seed 必须是 0 到 4294967295 的整数");
  const directory = resolve(out);
  await mkdir(directory, { mode: 0o700 }); // EEXIST rejects files, symlinks and nonempty/empty directories alike.
  let store;
  try {
    store = Store.open({
      dbPath: join(directory, "cardigan.db"),
      clock: { now: () => FIXTURE_NOW },
    });
    const random = randomSource(seed);
    let serial = 0;
    const eventId = () =>
      newUlid(
        Date.parse(FIXTURE_NOW) + serial++,
        Uint8Array.from({ length: 10 }, () => random() >>> 24),
      );
    // The empty-store migration creates one owner audit event with a random ULID.
    // Normalize that bootstrap identity too; do not discard its audit record.
    for (const row of store.database
      .prepare("SELECT id, doc FROM global_events ORDER BY seq")
      .all()) {
      const doc = { ...JSON.parse(row.doc), id: eventId() };
      store.database
        .prepare("UPDATE global_events SET id = ?, doc = ? WHERE id = ?")
        .run(doc.id, JSON.stringify(doc), row.id);
    }
    for (const [id, name] of [
      [FIXTURE_PROJECT, "合成星云工坊"],
      ["synthetic-empty", "合成空项目"],
      ["synthetic-single", "合成单卡项目"],
    ]) {
      const created = store.createProject({ id, name });
      if (!created.ok) throw new Error(created.error.message);
    }
    const avatar = await fileAvatarStore(directory).put(PIXEL);
    const blobs = [
      PIXEL,
      Buffer.from("合成附件 · Synthetic 🧶\n仅用于界面占位。\n"),
      Buffer.from('{"synthetic":true,"items":[]}\n'),
    ];
    await mkdir(join(directory, "attachments"), { mode: 0o700 });
    for (const blob of blobs)
      await writeFile(join(directory, "attachments", hash(blob)), blob, {
        mode: 0o600,
        flag: "wx",
      });
    store.uow.run((tx) =>
      seedScenarios(tx, {
        size: PROFILES[profile],
        project: FIXTURE_PROJECT,
        now: FIXTURE_NOW,
        random,
        eventId,
        avatar,
        blobs: blobs.map((b) => ({ sha256: hash(b), size: b.length })),
      }),
    );
    if (profile === "diagnostics") {
      // Fixed C-338 workload: a long closed history and exactly 40 live sessions.
      store.uow.run((tx) => {
        const cards = tx.cards.list(FIXTURE_PROJECT);
        const closed = new Set(cards.slice(0, 313).map((c) => c.id));
        for (const card of cards)
          tx.cards.put(FIXTURE_PROJECT, {
            ...card,
            status: closed.has(card.id) ? "done" : "in_progress",
          });
        const items = new Map(
          tx.work_items.list(FIXTURE_PROJECT).map((w) => [w.id, w]),
        );
        let active = 0;
        for (const a of tx.assignments.list(FIXTURE_PROJECT)) {
          const live =
            a.scope === "standing" ||
            (!closed.has(items.get(a.work_item_id)?.card_id) && active < 40);
          if (live) active++;
          tx.assignments.put(FIXTURE_PROJECT, {
            ...a,
            status: live ? "active" : "released",
            runtime_state: live ? "idle" : "released",
            runtime_ref: live
              ? {
                  machine_id: "synthetic-machine",
                  runtime_machine: "local",
                  terminal_ref: `fixture-${a.id}`,
                  agent_name: `fixture-${a.id}`,
                }
              : null,
          });
        }
        if (active !== 40)
          throw new Error("Diagnostic fixture must have 40 active sessions");
      });
    }
    if (profile === "needs-you") {
      store.uow.run(() => {
        const events = store.database
          .prepare(
            "SELECT id, card_id, seq FROM events WHERE project_id = ? LIMIT 8729",
          )
          .all(FIXTURE_PROJECT);
        for (const [i, event] of events.entries())
          recordFixtureNotification(store, {
            project_id: FIXTURE_PROJECT,
            id: `synthetic-notification-${i}`,
            event_id: event.id,
            card_id: event.card_id ?? undefined,
            seq: event.seq,
            recipient: { kind: "needs_you" },
            kind: "synthetic",
            at: FIXTURE_NOW,
          });
      });
    }
    if (sensitiveNeeds) {
      store.uow.run((tx) => {
        const original = tx.decisions.get(FIXTURE_PROJECT, "Q-2");
        const card = tx.cards.get(FIXTURE_PROJECT, "C-14");
        if (!original || !card?.sensitive)
          throw new Error("Missing synthetic sensitive scenario");
        const decision = {
          ...original,
          id: "Q-90002",
          key: "Q-90002",
          card_id: "C-14",
          affected_cards: ["C-14"],
          affected_work_items: [],
          attachment_ids: [],
          category: "permission",
          decider: "human",
          status: "open",
          question: "合成敏感卡待拍板（仅界面验收）",
          context: "合成敏感内容；不得用于生产。",
        };
        tx.decisions.put(FIXTURE_PROJECT, decision);
        tx.events.append(FIXTURE_PROJECT, {
          id: eventId(),
          card_id: "C-14",
          seq: tx.ids.nextEventSequence(FIXTURE_PROJECT, "C-14"),
          type: "decision_requested",
          actor: { kind: "human", project_id: FIXTURE_PROJECT },
          payload: { decision_id: decision.id },
          created_at: FIXTURE_NOW,
        });
      });
    }
    const tables = tableDigests(store.database);
    const manifest = {
      format: "cardigan-synthetic-v1",
      seed,
      profile,
      now: FIXTURE_NOW,
      projects: [FIXTURE_PROJECT, "synthetic-empty", "synthetic-single"],
      counts: Object.fromEntries(
        Object.keys(PROFILES[profile]).map((table) => [
          table,
          tables[table].count,
        ]),
      ),
      tables,
      scenarios: {
        empty: "C-1",
        single: "C-2",
        long_and_many: "C-3",
        parent: "C-4",
        child: "C-5",
        risk_combinations: "C-6..C-13",
        sensitive: "C-14",
        ...(sensitiveNeeds ? { sensitive_needs: "Q-90002" } : {}),
        merge_checks: "C-20..C-26",
        resolutions: "C-27..C-30",
        due_soon: "Q-2",
        overdue: "Q-3",
      },
    };
    store.close();
    store = undefined;
    await writeFile(
      join(directory, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    return manifest;
  } catch (error) {
    store?.close();
    // This invocation exclusively created this directory; pre-existing outputs never reach here.
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2).filter((arg) => arg !== "--"),
      options: {
        out: { type: "string" },
        seed: { type: "string" },
        profile: { type: "string" },
        "sensitive-needs": { type: "boolean" },
      },
    });
    const started = performance.now();
    const manifest = await generateFixture({
      out: values.out,
      sensitiveNeeds: values["sensitive-needs"] ?? false,
      ...(values.seed !== undefined ? { seed: Number(values.seed) } : {}),
      ...(values.profile ? { profile: values.profile } : {}),
    });
    process.stdout.write(
      `${JSON.stringify({ profile: manifest.profile, seed: manifest.seed, counts: manifest.counts, duration_ms: Math.round(performance.now() - started) })}\n`,
    );
  } catch {
    process.stderr.write("合成数据生成失败：请核对参数、构建和新输出目录。\n");
    process.exitCode = 1;
  }
}
