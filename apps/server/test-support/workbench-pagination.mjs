/** C-243: serial HTTP measurements against a disposable synthetic database. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Store } from "../../../packages/store/dist/index.js";
import { resolveWebConfig } from "../dist/web/config.js";
import { startWebServer } from "../dist/web/server.js";

const project = "pagination-fixture";
const cardCount = 241;
const eventsPerCard = 120;
const samples = 20;
const start = Date.parse("2026-01-01T00:00:00.000Z");
const time = (n) => new Date(start + n * 1000).toISOString();
const root = mkdtempSync(join(tmpdir(), "cardigan-pagination-"));
const dbPath = join(root, "fixture.db");
const password = randomBytes(24).toString("hex");
const endpoints = [
  "/cards?view=summary",
  "/cards?view=summary&mode=board&sort=updated",
  "/needs-you",
  "/activity",
  "/decision-history",
  "/cards/C-1?limit=20",
  "/execution",
];

function seed(store) {
  store.createProject({ id: project, name: "分页合成夹具" });
  store.setWebPassword(password);
  store.uow.run((tx) => {
    for (let c = 1; c <= cardCount; c++) {
      const card = `C-${c}`;
      const item = `W-${c}`;
      const assignment = `A-${c}`;
      const active = c <= 20;
      tx.cards.put(project, {
        id: card,
        project_id: project,
        title: `分页测量卡片 ${c}`,
        goal: "固定合成正文，用于复现读取行为。".repeat(10),
        acceptance_criteria: ["分页结果正确", "项目隔离"],
        source: { kind: "quote", text: "合成数据" },
        out_of_scope: [],
        related_cards: [],
        priority: c % 5,
        status: active ? "in_progress" : "done",
        ...(active ? {} : { resolution: "done" }),
        template: "dev",
        template_version: 1,
        repo: "fixture",
        base_branch: "main",
        created_by: "human",
        created_at: time(c),
      });
      tx.work_items.put(project, {
        id: item,
        card_id: card,
        title: "开发",
        kind: "produce",
        role_id: "coder",
        required: true,
        depends_on: [],
        completion_criteria: [],
        status: active ? "in_progress" : "accepted",
        assignment_id: assignment,
      });
      tx.assignments.put(project, {
        id: assignment,
        scope: "work_item",
        work_item_id: item,
        role_id: "coder",
        role_version: 1,
        machine_id: "fixture",
        status: active ? "active" : "released",
        runtime_state: "idle",
        runtime_ref: null,
        mcp_token_id: "fixture-only",
        created_at: time(c),
      });
      for (let r = 0; r < 4; r++) {
        const n = (c - 1) * 4 + r + 1;
        tx.runs.put(project, {
          id: `R-${n}`,
          assignment_id: assignment,
          trigger_event_id: `fixture-${String((c - 1) * eventsPerCard + r + 1).padStart(8, "0")}`,
          kind: "initial",
          status: "completed",
          role_version: 1,
          model: "fixture",
          agent_cli_version: "fixture",
          started_at: time(n),
          finished_at: time(n + 1),
          outcome: "completed",
          summary: "合成执行记录",
        });
      }
      tx.decisions.put(project, {
        id: `Q-${c}`,
        key: `Q-${c}`,
        card_id: card,
        raised_by: `assignment:${assignment}`,
        kind: "choose",
        category: "general",
        question: `合成待办 ${c}`,
        context: "固定合成背景",
        options: [{ key: "continue", description: "继续", impact: "继续执行" }],
        recommended: "continue",
        affected_cards: [],
        affected_work_items: [],
        blocking: active,
        decider: "human",
        doc_refs: [],
        status: active ? "open" : "resolved",
        ...(active
          ? {}
          : {
              resolution: {
                option: "continue",
                resolved_by: "human",
                at: time(c),
                via: "needs_you",
                raw_quote: "继续",
              },
            }),
      });
      for (let seq = 1; seq <= eventsPerCard; seq++) {
        const n = (c - 1) * eventsPerCard + seq;
        const body = "可重复的事件正文，不含生产数据。".repeat(8);
        tx.events.append(project, {
          id: `fixture-${String(n).padStart(8, "0")}`,
          card_id: card,
          seq,
          type: seq === 1 ? "decision_requested" : "comment_posted",
          actor: { kind: "human", project_id: project },
          payload: seq === 1 ? { decision_id: `Q-${c}` } : { body },
          created_at: time(n),
        });
        tx.timeline.put(project, {
          id: `${card}#${seq}`,
          short_id: `${card}#${seq}`,
          card_id: card,
          event_seq: seq,
          type: seq === 1 ? "decision_requested" : "comment",
          ...(seq === 1 ? { decision_id: `Q-${c}` } : {}),
          author: "human",
          body,
          refs: [],
          mentions: [],
          retracted: false,
          created_at: time(n),
        });
      }
    }
  });
  for (const [table, count] of Object.entries({
    cards: cardCount,
    events: cardCount * eventsPerCard,
    timeline: cardCount * eventsPerCard,
    runs: cardCount * 4,
  }))
    assert.equal(
      store.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,
      count,
    );
}

// Count rows actually transferred from SQLite to JS, not SQLite VM row visits.
// Aggregates and cached domain arrays require the separate query-plan evidence.
function instrument(db) {
  const prepare = db.prepare.bind(db);
  let current;
  db.prepare = (sql) => {
    const statement = prepare(sql);
    return new Proxy(statement, {
      get(target, key) {
        const member = Reflect.get(target, key, target);
        if (typeof member !== "function") return member;
        return (...args) => {
          const started = performance.now();
          const result = Reflect.apply(member, target, args);
          const elapsed = performance.now() - started;
          if (current && (key === "all" || key === "get")) {
            const rows =
              key === "all" ? result : result === undefined ? [] : [result];
            current.rows += rows.length;
            current.documents += rows.filter((row) =>
              Object.hasOwn(row, "doc"),
            ).length;
            const normalized = sql.replace(/\s+/gu, " ").trim();
            current.sql_ms[normalized] =
              (current.sql_ms[normalized] ?? 0) + elapsed;
            current.queries[normalized] =
              (current.queries[normalized] ?? 0) + rows.length;
          }
          return result;
        };
      },
    });
  };
  return {
    start() {
      current = { rows: 0, documents: 0, queries: {}, sql_ms: {} };
    },
    stop() {
      const result = current;
      current = undefined;
      return result;
    },
  };
}

async function measure(path, firstOnly = false) {
  // A new Store for each endpoint avoids inherited command-snapshot caches.
  const store = Store.open({ dbPath });
  const probe = instrument(store.database);
  let server;
  try {
    server = await startWebServer({
      store,
      dataDir: root,
      log: () => {},
      config: resolveWebConfig({}, { port: 0, staticDir: root }),
    });
    const login = await fetch(`${server.url}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: server.url },
      body: JSON.stringify({ password }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const observations = [];
    for (let i = 0; i <= (firstOnly ? 0 : samples); i++) {
      probe.start();
      const started = performance.now();
      const response = await fetch(
        `${server.url}/api/projects/${project}${path}`,
        {
          headers: { cookie },
        },
      );
      const body = await response.text();
      const elapsed_ms = performance.now() - started;
      const reads = probe.stop();
      assert.equal(response.status, 200, path);
      assert.doesNotThrow(() => JSON.parse(body));
      observations.push({
        elapsed_ms,
        bytes: Buffer.byteLength(body),
        ...reads,
      });
    }
    const warm = observations.slice(1);
    const sorted = warm.map((o) => o.elapsed_ms).sort((a, b) => a - b);
    return {
      path,
      first: observations[0],
      warm: firstOnly
        ? null
        : {
            p50_ms: sorted[9],
            p95_ms: sorted[18],
            min_rows: Math.min(...warm.map((o) => o.rows)),
            max_rows: Math.max(...warm.map((o) => o.rows)),
            bytes: warm[0].bytes,
          },
      samples: warm,
    };
  } finally {
    try {
      await server?.close();
    } finally {
      store.close();
    }
  }
}

function queryPlans() {
  const store = Store.open({ dbPath });
  const db = store.database;
  const probes = [
    {
      name: "current_card_update_aggregate",
      sql: "SELECT card_id, MAX(json_extract(doc, '$.created_at')) AS updated_at FROM events WHERE project_id = ? AND card_id IS NOT NULL GROUP BY card_id",
      args: [project],
    },
    {
      name: "activity_page_candidate",
      sql: "SELECT doc FROM events WHERE project_id = ? ORDER BY json_extract(doc, '$.created_at') DESC, id DESC LIMIT ?",
      args: [project, 51],
    },
    {
      name: "cards_status_candidate",
      sql: "SELECT doc FROM cards WHERE project_id = ? AND json_extract(doc, '$.status') = ? ORDER BY id LIMIT ?",
      args: [project, "done", 11],
    },
    {
      name: "work_items_for_card",
      sql: "SELECT doc FROM work_items WHERE project_id = ? AND card_id = ?",
      args: [project, "C-1"],
    },
    {
      name: "timeline_page_candidate",
      sql: "SELECT doc FROM timeline WHERE project_id = ? AND card_id = ? AND event_seq < ? ORDER BY event_seq DESC LIMIT ?",
      args: [project, "C-1", 100, 21],
    },
    {
      name: "active_assignments_candidate",
      sql: "SELECT doc FROM assignments WHERE project_id = ? AND json_extract(doc, '$.status') = ? ORDER BY id",
      args: [project, "active"],
    },
    {
      name: "decision_history_candidate",
      sql: "SELECT doc FROM decisions WHERE project_id = ? AND json_extract(doc, '$.resolution.at') IS NOT NULL ORDER BY json_extract(doc, '$.resolution.at') DESC, id DESC LIMIT ?",
      args: [project, 11],
    },
    {
      name: "notifications_recipient",
      sql: "SELECT doc FROM notifications WHERE project_id = ? AND recipient_kind = ? AND assignment_id = ? AND status = ?",
      args: [project, "assignment", "A-1", "pending"],
    },
  ];
  const explain = () =>
    probes.map((probe) => ({
      name: probe.name,
      sql: probe.sql,
      plan: db
        .prepare(`EXPLAIN QUERY PLAN ${probe.sql}`)
        .all(...probe.args)
        .map((row) => row.detail),
      result_rows: db.prepare(probe.sql).all(...probe.args).length,
    }));
  try {
    const before = explain();
    db.exec("BEGIN");
    try {
      // Experimental indexes only, rolled back; these are not a product migration.
      db.exec(`
        CREATE INDEX experiment_events_time ON events (project_id, json_extract(doc, '$.created_at') DESC, id DESC);
        CREATE INDEX experiment_cards_status ON cards (project_id, json_extract(doc, '$.status'), id);
        CREATE INDEX experiment_work_items_card ON work_items (project_id, card_id);
        CREATE INDEX experiment_assignments_status ON assignments (project_id, json_extract(doc, '$.status'), id);
        CREATE INDEX experiment_decisions_resolution ON decisions (project_id, json_extract(doc, '$.resolution.at') DESC, id DESC);
      `);
      return { before, after: explain() };
    } finally {
      db.exec("ROLLBACK");
      assert.equal(
        db
          .prepare(
            "SELECT count(*) AS n FROM sqlite_schema WHERE name LIKE 'experiment_%'",
          )
          .get().n,
        0,
      );
    }
  } finally {
    store.close();
  }
}

async function screenshots(directory) {
  const { chromium } = await import("../../web/test-support/chromium.mjs");
  const store = Store.open({ dbPath });
  let server;
  let browser;
  const evidence = [];
  mkdirSync(directory, { recursive: true });
  try {
    server = await startWebServer({
      store,
      dataDir: root,
      log: () => {},
      config: resolveWebConfig({}, { port: 0 }),
    });
    browser = await chromium();
    await browser.send("Network.enable");
    await browser.send("Network.setCookie", {
      name: "cardigan_session",
      value: store.createWebSession().token,
      url: server.url,
      httpOnly: true,
      sameSite: "Strict",
    });
    const routes = [
      ["board", "cards?view=board", ".board-card"],
      ["list", "cards?view=list", ".card-table-title"],
      ["needs-you", "needs-you", ".needs-item"],
      ["activity", "activity", ".activity-list"],
      ["card", "cards/C-1", ".timeline-entry"],
    ];
    for (const width of [1440, 390])
      for (const theme of ["light", "dark"]) {
        await browser.send("Emulation.setDeviceMetricsOverride", {
          width,
          height: width === 390 ? 844 : 900,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await browser.send("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: theme }],
        });
        for (const [name, route, ready] of routes) {
          await browser.send("Page.navigate", {
            url: `${server.url}/#/p/${project}/${route}`,
          });
          await browser.evaluate(`new Promise((resolve, reject) => {
          const deadline = Date.now() + 20000;
          const check = () => {
            if (document.querySelector(${JSON.stringify(ready)})) document.fonts.ready.then(() => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            else if (Date.now() > deadline) reject(new Error('Page did not become ready'));
            else setTimeout(check, 50);
          }; check();
        })`);
          const overflow = await browser.evaluate(
            "document.documentElement.scrollWidth > innerWidth + 1",
          );
          assert.equal(
            overflow,
            false,
            `${name}/${width}/${theme} page overflow`,
          );
          const filename = `${name}-${width}-${theme}.png`;
          const shot = await browser.send("Page.captureScreenshot", {
            format: "png",
          });
          writeFileSync(
            join(directory, filename),
            Buffer.from(shot.data, "base64"),
          );
          evidence.push({ filename, width, theme, page_overflow: overflow });
        }
      }
    assert.deepEqual(browser.errors, []);
    return evidence;
  } finally {
    try {
      await browser?.close();
    } finally {
      try {
        await server?.close();
      } finally {
        store.close();
      }
    }
  }
}

try {
  const store = Store.open({ dbPath });
  try {
    seed(store);
  } finally {
    store.close();
  }
  const results = [];
  for (const endpoint of endpoints.filter(
    (path) =>
      !process.env.WORKBENCH_BENCHMARK_PATH ||
      path === process.env.WORKBENCH_BENCHMARK_PATH,
  )) {
    const result = await measure(endpoint);
    const cold = [result.first];
    for (let i = 1; i < samples; i++)
      cold.push((await measure(endpoint, true)).first);
    const ordered = cold.map((r) => r.elapsed_ms).sort((a, b) => a - b);
    results.push({
      ...result,
      cold: { p50_ms: ordered[9], p95_ms: ordered[18], samples: cold },
    });
  }
  const report = {
    node: process.version,
    cards: cardCount,
    events: cardCount * eventsPerCard,
    timeline: cardCount * eventsPerCard,
    assignments: cardCount,
    active_assignments: 20,
    runs: cardCount * 4,
    warm_samples: samples,
    results,
    screenshots: [],
    screenshots_status: "not_run",
    query_plans: queryPlans(),
  };
  if (process.argv[2])
    writeFileSync(process.argv[2], `${JSON.stringify(report, null, 2)}\n`);
  if (process.env.WORKBENCH_SCREENSHOTS) {
    try {
      report.screenshots = await screenshots(process.env.WORKBENCH_SCREENSHOTS);
      report.screenshots_status = "passed";
    } catch (error) {
      report.screenshots_status = "failed";
      throw error;
    } finally {
      if (process.argv[2])
        writeFileSync(process.argv[2], `${JSON.stringify(report, null, 2)}\n`);
    }
  }
  console.table(
    results.map(({ path, first, warm, cold }) => ({
      path,
      first_ms: first.elapsed_ms.toFixed(2),
      cold_p95_ms: cold.p95_ms.toFixed(2),
      first_sql_rows: first.rows,
      p50_ms: warm.p50_ms.toFixed(2),
      p95_ms: warm.p95_ms.toFixed(2),
      warm_sql_rows: `${warm.min_rows}–${warm.max_rows}`,
      bytes: warm.bytes,
    })),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
