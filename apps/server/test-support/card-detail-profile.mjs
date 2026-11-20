// After tsc -b apps/server: node apps/server/test-support/card-detail-profile.mjs <cards-fixture-dir>
// Never open the supplied database for writing. Each run modifies only a fresh copy.
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "@cardigan/store";
import { getCardTool } from "../../../packages/mcp-server/dist/tools/get-card.js";
import { cardSectionPayload } from "../dist/web/card-sections.js";
import { readPagedCard } from "../dist/web/timeline-state.js";

const fixture = process.argv[2];
const manifest = JSON.parse(
  readFileSync(join(fixture, "manifest.json"), "utf8"),
);
if (manifest.format !== "cardigan-synthetic-v1" || manifest.profile !== "cards")
  throw new Error("cards fixture required");
const dir = mkdtempSync(join(tmpdir(), "card-detail-profile-"));
const project = "synthetic";
const stats = (xs) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return {
    p50: +sorted[9].toFixed(2),
    p95: +sorted[18].toFixed(2),
    first: +xs[0].toFixed(2),
  };
};
try {
  const dbPath = join(dir, "copy.db");
  copyFileSync(join(fixture, "cardigan.db"), dbPath);
  const setup = Store.open({ dbPath });
  setup.uow.run((tx) => {
    tx.events.append(project, {
      id: "synthetic-queue",
      seq: tx.ids.nextEventSequence(project, undefined),
      type: "merge_queue_configured",
      actor: { kind: "system", project_id: project },
      payload: { max_batch_size: 3 },
      created_at: manifest.now,
    });
    const peer = tx.cards.get(project, "C-50");
    tx.cards.put(project, { ...peer, depends_on_cards: ["C-51"] });
    // Match the reported order of magnitude without copying real reviews/logs.
    for (const id of ["C-100", "C-103"]) {
      const works = tx.work_items.list(project).filter((w) => w.card_id === id);
      for (const d of tx.deliveries
        .list(project)
        .filter((d) => works.some((w) => w.id === d.work_item_id)))
        tx.deliveries.put(project, {
          ...d,
          test_results: [
            { command: "synthetic", result: "合成测试记录。".repeat(8000) },
          ],
        });
    }
  });
  setup.close();
  for (const path of ["web", "mcp"])
    for (const id of ["C-103", "C-100"]) {
      const store = Store.open({ dbPath });
      const assignment = store.uow.read((tx) =>
        tx.assignments.get(project, "A-2"),
      );
      const identity = {
        actor: {
          project_id: project,
          assignment_id: assignment.id,
          role_id: assignment.role_id,
        },
        token: { role_version: assignment.role_version },
      };
      const samples = {},
        elapsed = [];
      let size;
      for (let i = 0; i < 20; i++) {
        const recordTiming = (key, ms) => {
          samples[key] ??= [];
          samples[key].push(ms);
        };
        const start = performance.now();
        const detail =
          path === "web"
            ? readPagedCard(
                store,
                project,
                id,
                new URL("http://fixture/?limit=20&section=overview"),
                { now: manifest.now, recordTiming },
              )
            : getCardTool.handler(
                { card_id: id },
                { store, identity, recordTiming },
              );
        size = Buffer.byteLength(
          JSON.stringify(
            path === "web" ? cardSectionPayload(detail, "overview") : detail,
          ),
        );
        elapsed.push(performance.now() - start);
      }
      console.log(
        JSON.stringify({
          path,
          id,
          bytes: size,
          ms: stats(elapsed),
          phases_ms: Object.fromEntries(
            Object.entries(samples).map(([k, v]) => [k, stats(v)]),
          ),
        }),
      );
      store.close();
    }
  // Acquire the writer slot on a second connection; no spin, CPU load or production DB.
  const reader = Store.open({ dbPath });
  const writer = new DatabaseSync(dbPath);
  try {
    writer.exec("BEGIN IMMEDIATE");
    const start = performance.now();
    const result = readPagedCard(
      reader,
      project,
      "C-103",
      new URL("http://fixture/?limit=20&section=overview"),
      { now: manifest.now },
    );
    console.log(
      JSON.stringify({
        writer_held: true,
        journal: writer.prepare("PRAGMA journal_mode").get().journal_mode,
        card: result.card.id,
        read_ms: +(performance.now() - start).toFixed(2),
      }),
    );
  } finally {
    writer.exec("ROLLBACK");
    writer.close();
    reader.close();
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
