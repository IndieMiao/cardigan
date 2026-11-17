/** C-352: bounded normal reads on a newly generated fixture, never a production DB.
 * Build apps/server, then run: node test-support/cards-tabs-profile.mjs NEW_OUTPUT
 * Business time is simulated; measured durations/event-loop probes use real time.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Store } from "@cardigan/store";
import ts from "typescript";
import {
  readCachedCardsPage,
  readCardsVersion,
} from "../dist/web/cards-cache.js";
import { cardSummary } from "../dist/web/cards-page.js";
import {
  FIXTURE_NOW,
  FIXTURE_PROJECT,
  generateFixture,
} from "./synthetic-fixture.mjs";

const baseline = "cbd0c094d69499a4e077c4aa1b80226862546baa";
const output = process.argv[2];
if (!output) throw new Error("Expected a new output directory");
const directory = resolve(output);
mkdirSync(directory, { mode: 0o700 });
const root = fileURLToPath(new URL("../../../", import.meta.url));
const compiled = mkdtempSync(
  fileURLToPath(new URL("../dist/web/c352-", import.meta.url)),
);
const save = (path, data) =>
  writeFileSync(path, JSON.stringify(data, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const originalNow = Date.now;
try {
  // Only the two changed read modules differ. All their dependencies are the
  // identical current build. Artifacts are isolated and removed in finally.
  for (const name of ["cards-page", "cards-cache"]) {
    let source = execFileSync(
      "git",
      ["show", `${baseline}:apps/server/src/web/${name}.ts`],
      { cwd: root, encoding: "utf8" },
    );
    source = source.replaceAll('"./', '"../');
    if (name === "cards-cache")
      source = source.replace('"../cards-page.js"', '"./cards-page.js"');
    const js = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ES2022,
      },
    }).outputText;
    writeFileSync(join(compiled, `${name}.js`), js, { flag: "wx" });
  }
  const before = (
    await import(pathToFileURL(join(compiled, "cards-cache.js")).href)
  ).readCachedCardsPage;
  const fixture = await generateFixture({
    out: join(directory, "fixture"),
    seed: 352,
    profile: "cards",
  });
  const results = [];
  for (const mode of ["list", "board"]) {
    for (const scenario of [
      { name: "five-visible-seven-changes", visible: 5, changes: 7 },
      { name: "one-visible-seven-changes", visible: 1, changes: 7 },
      { name: "five-visible-idle", visible: 5, changes: 0 },
    ]) {
      for (const variant of ["before", "after"]) {
        const dbPath = join(
          directory,
          `${mode}-${scenario.name}-${variant}.db`,
        );
        copyFileSync(
          join(directory, "fixture", "cardigan.db"),
          dbPath,
          constants.COPYFILE_EXCL,
        );
        const store = Store.open({ dbPath });
        let logical = 0;
        Date.now = () => Date.parse(FIXTURE_NOW) + logical * 1000;
        const pages = Array(5);
        const requests = { cards: 0, version: 0, bytes: 0, read_ms: 0 };
        const observations = [];
        let eventLoopMax = 0;
        const baseUrl = new URL(
          `http://fixture/cards?view=summary&mode=${mode}&sort=updated&limit=10`,
        );
        const read = (tab, measured) => {
          const start = performance.now();
          const previous = pages[tab];
          if (variant === "after" && previous) {
            const version = readCardsVersion(store, FIXTURE_PROJECT, baseUrl);
            if (measured) {
              requests.version++;
              requests.bytes += Buffer.byteLength(JSON.stringify(version));
            }
            if (version.snapshot_version === previous.snapshot_version) {
              if (measured) requests.read_ms += performance.now() - start;
              return;
            }
          }
          const url = new URL(baseUrl);
          if (previous)
            url.searchParams.set("since_version", previous.snapshot_version);
          const received = (
            variant === "before" ? before : readCachedCardsPage
          )(store, FIXTURE_PROJECT, url);
          const serialized = JSON.stringify(received);
          if (measured) {
            requests.cards++;
            requests.bytes += Buffer.byteLength(serialized);
            requests.read_ms += performance.now() - start;
          }
          const rows = new Map(
            [...(previous?.cards ?? []), ...received.cards].map((c) => [
              c.id,
              c,
            ]),
          );
          pages[tab] = received.delta
            ? {
                ...received,
                cards: received.card_ids.map((id) => rows.get(id)),
              }
            : received;
        };
        try {
          const coldStart = performance.now();
          // All five tabs open once before some become hidden. Exclude warmup.
          for (let tab = 0; tab < 5; tab++) read(tab, false);
          const warmup_ms = performance.now() - coldStart;
          for (logical = 1; logical <= 60; logical++) {
            if (
              scenario.changes &&
              [5, 13, 21, 29, 37, 45, 53].includes(logical)
            ) {
              store.uow.run((tx) => {
                const card = tx.cards.get(FIXTURE_PROJECT, "C-3");
                tx.cards.put(FIXTURE_PROJECT, {
                  ...card,
                  title: `合成变化 ${logical}`,
                });
                tx.events.append(FIXTURE_PROJECT, {
                  id: `synthetic-tabs-${logical}`,
                  card_id: "C-3",
                  seq: tx.ids.nextEventSequence(FIXTURE_PROJECT, "C-3"),
                  type: "card_updated",
                  actor: { kind: "system", project_id: FIXTURE_PROJECT },
                  payload: { card_id: "C-3" },
                  created_at: new Date(Date.now()).toISOString(),
                });
              });
            }
            if (logical % 30 !== 0) continue;
            // One queued callback measures the real event-loop blockage of this
            // normal five-tab burst. No busy loop, background worker or load filler.
            const queued = performance.now();
            const probe = new Promise((done) =>
              setImmediate(() => done(performance.now() - queued)),
            );
            for (let tab = 0; tab < scenario.visible; tab++) read(tab, true);
            eventLoopMax = Math.max(eventLoopMax, await probe);
            observations.push(
              pages.slice(0, scenario.visible).map((p) =>
                digest({
                  cards: p.cards.map(cardSummary),
                  counts: p.counts,
                  lanes: p.lanes,
                  roles: p.roles,
                  total_filtered: p.total_filtered,
                  page: p.page,
                }),
              ),
            );
          }
          results.push({
            mode,
            scenario: scenario.name,
            variant,
            warmup_ms,
            ...requests,
            event_loop_max_ms: eventLoopMax,
            observations,
          });
        } finally {
          Date.now = originalNow;
          store.close();
          for (const suffix of ["", "-wal", "-shm"])
            rmSync(dbPath + suffix, { force: true });
        }
      }
      const [left, right] = results.slice(-2);
      if (
        JSON.stringify(left.observations) !== JSON.stringify(right.observations)
      )
        throw new Error(`Card content/order changed: ${mode}/${scenario.name}`);
    }
  }
  const report = {
    baseline,
    current_head: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    source_diff_sha256: digest(
      execFileSync("git", ["diff", "--", "apps/server/src/web"], {
        cwd: root,
        encoding: "utf8",
      }),
    ),
    node: process.version,
    sqlite: process.versions.sqlite,
    seed: 352,
    counts: fixture.counts,
    clock:
      "60 simulated seconds, default 30-second refresh; real synchronous-read and queued-callback durations",
    boundary:
      "server page/version read + serialization; excludes HTTP/auth, SSE, browser render, worker loops and production load",
    results,
  };
  save(join(directory, "report.json"), report);
  console.log(
    JSON.stringify(
      { ...report, results: results.map(({ observations, ...row }) => row) },
      null,
      2,
    ),
  );
} finally {
  Date.now = originalNow;
  rmSync(compiled, { recursive: true, force: true });
}
