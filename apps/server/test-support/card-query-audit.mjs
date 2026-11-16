/** C-399: actual read-path SQL, serial measurements on disposable authorized copies. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { referenceProjectSnapshot } from "../../../packages/domain/dist/index.js";
import { loadCommandState } from "../../../packages/mcp-server/dist/index.js";
import { Store } from "../../../packages/store/dist/index.js";
import { resolveWebConfig } from "../dist/web/config.js";
import { startWebServer } from "../dist/web/server.js";

const [source, output, project, card] = process.argv.slice(2);
assert(
  source && output && project && card,
  "Expected authorized-copy new-output-directory project detail-card",
);
const samples = Number(process.env.CARD_QUERY_SAMPLES ?? 5);
assert(Number.isSafeInteger(samples) && samples >= 1 && samples <= 20);
const clock = { now: () => "2026-11-16T16:17:00.000Z" };
const digest = (value) => createHash("sha256").update(value).digest("hex");
const median = (values) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const hash = () => digest(readFileSync(source));
const sourceHash = hash();
mkdirSync(output, { mode: 0o700 });

// Bindings and rows stay in memory. Only SQL templates, plans and aggregate costs leave.
function instrument(db, baseline = false) {
  const prepare = db.prepare.bind(db);
  const templates = new Map();
  let current;
  db.prepare = (sql) => {
    // The only product SQL changes are these two selectors. Replay their exact
    // 06cd8ca versions on the unmigrated copy, using the same current HTTP code.
    // This keeps both phases reproducible without checking out another worktree.
    const legacy =
      baseline && /^SELECT doc FROM (reviews|runs) WHERE rowid IN/u.exec(sql);
    if (legacy) {
      sql =
        legacy[1] === "reviews"
          ? "SELECT doc FROM reviews WHERE project_id = ? AND (delivery_id IN (SELECT value FROM json_each(?)) OR json_extract(doc, '$.work_item_id') IN (SELECT value FROM json_each(?)))"
          : "SELECT doc FROM runs WHERE project_id = ? AND (id IN (SELECT value FROM json_each(?)) OR (assignment_id IN (SELECT value FROM json_each(?)) AND json_extract(doc, '$.status') NOT IN ('completed','failed','cancelled')))";
    }
    const statement = prepare(sql);
    return new Proxy(statement, {
      get(target, key) {
        const member = Reflect.get(target, key, target);
        if (typeof member !== "function") return member;
        return (...args) => {
          if (legacy) args = [args[0], args[1], args[3]];
          const started = performance.now();
          const value = Reflect.apply(member, target, args);
          const elapsed = performance.now() - started;
          if (current && ["all", "get"].includes(key)) {
            const normalized = sql.replace(/\s+/gu, " ").trim();
            const rows =
              key === "all" ? value.length : value === undefined ? 0 : 1;
            const entry = current.get(normalized) ?? {
              calls: 0,
              rows: 0,
              ms: 0,
            };
            entry.calls++;
            entry.rows += rows;
            entry.ms += elapsed;
            current.set(normalized, entry);
            if (!templates.has(normalized))
              templates.set(normalized, { sql, args });
          }
          return value;
        };
      },
    });
  };
  return {
    start() {
      current = new Map();
    },
    stop() {
      const value = current;
      current = undefined;
      return value;
    },
    summarize(observations, first) {
      return [...templates].map(([sql, query]) => ({
        sql,
        plan: prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
          .all(...query.args)
          .map((r) => r.detail),
        calls: observations.map((o) => o.queries.get(sql)?.calls ?? 0),
        rows: observations.map((o) => o.queries.get(sql)?.rows ?? 0),
        first: first.queries.get(sql) ?? { calls: 0, rows: 0, ms: 0 },
        median_ms: median(observations.map((o) => o.queries.get(sql)?.ms ?? 0)),
      }));
    },
  };
}

async function measure(dbPath, path, baseline) {
  const store = Store.open({ dbPath, migrate: false, clock });
  let server;
  try {
    const probe = instrument(store.database, baseline);
    // A generated session exists only in this disposable copy, never in reports.
    const cookie = `cardigan_session=${store.createWebSession().token}`;
    server = await startWebServer({
      store,
      clock,
      dataDir: output,
      log: () => {},
      config: resolveWebConfig({}, { port: 0, staticDir: output }),
    });
    const observations = [];
    let first;
    for (let i = 0; i <= samples; i++) {
      probe.start();
      const started = performance.now();
      const response = await fetch(
        `${server.url}/api/projects/${encodeURIComponent(project)}${path}`,
        { headers: { cookie } },
      );
      const body = await response.text();
      const ms = performance.now() - started;
      const queries = probe.stop();
      assert.equal(response.status, 200, path);
      if (!i) first = { ms, queries };
      if (i)
        observations.push({
          ms,
          queries,
          digest: digest(body),
          bytes: Buffer.byteLength(body),
        });
      console.log(`${path}: sample ${i}, ${ms.toFixed(2)} ms`);
    }
    return {
      path,
      first_ms: first.ms,
      median_ms: median(observations.map((o) => o.ms)),
      samples_ms: observations.map((o) => o.ms),
      response_sha256: observations[0].digest,
      bytes: observations[0].bytes,
      queries: probe.summarize(observations, first),
    };
  } finally {
    await server?.close();
    store.close();
  }
}

function measureReferenceProjection(dbPath) {
  const store = Store.open({ dbPath, migrate: false, clock });
  try {
    const assignment = JSON.parse(
      store.database
        .prepare(
          "SELECT doc FROM assignments WHERE project_id = ? AND json_extract(doc, '$.scope') = 'standing' AND json_extract(doc, '$.role_id') = 'pm' AND json_extract(doc, '$.status') = 'active' LIMIT 1",
        )
        .get(project).doc,
    );
    const actor = {
      kind: "assignment",
      project_id: project,
      assignment_id: assignment.id,
      role_id: assignment.role_id,
      role_version: assignment.role_version,
      allowed_tools: ["project_snapshot"],
    };
    const probe = instrument(store.database);
    const observations = [];
    let first;
    for (let i = 0; i <= samples; i++) {
      probe.start();
      const started = performance.now();
      const result = store.uow.read((tx) =>
        referenceProjectSnapshot(loadCommandState(tx, project), actor),
      );
      assert(result.ok);
      const body = JSON.stringify(result.value.data);
      const ms = performance.now() - started;
      const queries = probe.stop();
      if (!i) first = { ms, queries };
      if (i) observations.push({ ms, queries });
      console.log(
        `project_snapshot projection: sample ${i}, ${ms.toFixed(2)} ms`,
      );
      if (i === samples)
        return {
          path: "project_snapshot read projection (without MCP auth/audit)",
          first_ms: first.ms,
          median_ms: median(observations.map((o) => o.ms)),
          samples_ms: observations.map((o) => o.ms),
          response_sha256: digest(body),
          queries: probe.summarize(observations, first),
        };
    }
  } finally {
    store.close();
  }
}

function migration(dbPath) {
  const store = Store.open({ dbPath, migrate: false, clock });
  const db = store.database;
  const exec = db.exec.bind(db);
  const locks = [];
  let acquired;
  db.exec = (sql) => {
    const result = exec(sql);
    if (sql === "BEGIN IMMEDIATE") acquired = performance.now();
    if (sql === "COMMIT" && acquired !== undefined) {
      locks.push(performance.now() - acquired);
      acquired = undefined;
    }
    return result;
  };
  const businessDigest = () => {
    const hasher = createHash("sha256");
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_version' ORDER BY name",
      )
      .all();
    for (const { name } of tables) {
      hasher.update(name);
      for (const row of db
        .prepare(`SELECT * FROM "${name}" ORDER BY rowid`)
        .iterate())
        hasher.update(JSON.stringify(row));
    }
    return hasher.digest("hex");
  };
  try {
    const before = businessDigest();
    const started = performance.now();
    const applied = store.migrate();
    const elapsed_ms = performance.now() - started;
    assert.deepEqual(store.migrate(), []);
    assert.equal(businessDigest(), before);
    assert.equal(
      db.prepare("PRAGMA integrity_check").get().integrity_check,
      "ok",
    );
    return {
      applied,
      elapsed_ms,
      lock_ms: locks,
      repeated_noop: true,
      business_data_unchanged: true,
    };
  } finally {
    store.close();
  }
}

function appendCosts(dbPath) {
  const store = Store.open({ dbPath, migrate: false, clock });
  try {
    const timings = [];
    const sequence = Number(
      store.database
        .prepare(
          "SELECT coalesce(max(seq), 0) AS n FROM events WHERE project_id = ? AND stream = ?",
        )
        .get(project, card).n,
    );
    for (let i = 0; i <= samples; i++) {
      const started = performance.now();
      store.uow.run((tx) =>
        tx.events.append(project, {
          id: `audit-event-${i}`,
          card_id: card,
          seq: sequence + i + 1,
          type: "comment_posted",
          actor: { kind: "system", project_id: project },
          payload: { body: "Synthetic audit append" },
          created_at: clock.now(),
        }),
      );
      if (i) timings.push(performance.now() - started);
    }
    return {
      median_ms: median(timings),
      samples_ms: timings,
      events_per_transaction: 1,
    };
  } finally {
    store.close();
  }
}

const paths = [
  "/cards?view=summary",
  "/cards?view=summary&mode=board&sort=updated",
  `/cards/${encodeURIComponent(card)}?limit=20`,
  "/snapshot",
];
const report = {
  source_sha256: sourceHash,
  node: process.version,
  software_head: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  baseline:
    "06cd8ca275628337e5992ba53c29e544a853b75c: unmigrated snapshot + exact historical review/run selectors; all other read code identical",
  warmups: 1,
  samples,
  fixed_clock: clock.now(),
  phases: {},
};
const phaseNames = process.env.CARD_QUERY_PHASE
  ? [process.env.CARD_QUERY_PHASE]
  : ["before", "after"];
assert(phaseNames.every((p) => ["before", "after"].includes(p)));
for (const phase of phaseNames) {
  const dbPath = join(output, `${phase}.db`);
  copyFileSync(source, dbPath);
  try {
    if (phase === "after") report.migration = migration(dbPath);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      report.phases[phase] = {
        sqlite: db.prepare("SELECT sqlite_version() AS version").get().version,
        schema: db
          .prepare("SELECT max(version) AS version FROM schema_version")
          .get().version,
        counts: Object.fromEntries(
          [
            "cards",
            "events",
            "timeline",
            "work_items",
            "assignments",
            "runs",
            "deliveries",
            "reviews",
            "decisions",
            "human_actions",
            "attachments",
          ].map((table) => [
            table,
            db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,
          ]),
        ),
        indexes: db
          .prepare(
            "SELECT name, sql FROM sqlite_schema WHERE type = 'index' AND sql IS NOT NULL ORDER BY name",
          )
          .all(),
        integrity: db.prepare("PRAGMA integrity_check").get().integrity_check,
        reads: [],
      };
    } finally {
      db.close();
    }
    for (const path of paths) {
      report.phases[phase].reads.push(
        await measure(dbPath, path, phase === "before"),
      );
      writeFileSync(
        join(output, "audit.json"),
        `${JSON.stringify(report, null, 2)}\n`,
        { mode: 0o600 },
      );
    }
    report.phases[phase].reads.push(measureReferenceProjection(dbPath));
    report.phases[phase].append = appendCosts(dbPath);
  } finally {
    for (const suffix of ["", "-wal", "-shm"])
      rmSync(`${dbPath}${suffix}`, { force: true });
  }
}
assert.equal(hash(), sourceHash, "Authorized source changed");
if (report.phases.before && report.phases.after)
  for (let i = 0; i < report.phases.before.reads.length; i++)
    assert.equal(
      report.phases.before.reads[i].response_sha256,
      report.phases.after.reads[i].response_sha256,
      "Read result changed",
    );
report.source_unchanged = true;
writeFileSync(
  join(output, "audit.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  { mode: 0o600 },
);
console.table(
  phaseNames.flatMap((phase) =>
    report.phases[phase].reads.map((r) => ({
      phase,
      path: r.path,
      median_ms: r.median_ms,
      sql_calls: r.queries.reduce((sum, q) => sum + q.calls[0], 0),
    })),
  ),
);
