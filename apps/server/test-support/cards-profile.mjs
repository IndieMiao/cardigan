/** C-386: bounded, sequential reads of an explicit credential-free fixture copy.
 * Build apps/server first, then: node test-support/cards-profile.mjs DB OUTPUT
 * No config discovery, HTTP credentials, writes to source data or load filler.
 */

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { performance } from "node:perf_hooks";
import { Store } from "@cardigan/store";
import { readCachedCardsPage } from "../dist/web/cards-cache.js";
import { readCardsPage } from "../dist/web/cards-page.js";

const [dbPath, output, project = "synthetic", mode = "direct"] =
  process.argv.slice(2);
if (!dbPath || !output)
  throw new Error("Expected DB copy and new output prefix");
const store = Store.open({ dbPath });
// Only an already migrated disposable copy is allowed; reads below cannot write.
store.database.exec("PRAGMA query_only = ON");
const inspector = new Session();
inspector.connect();
await inspector.post("Profiler.enable");
await inspector.post("Profiler.start");
const samples = [];
let version;
for (let i = 0; i < 5; i++) {
  const started = performance.now();
  const page = (mode === "cached" ? readCachedCardsPage : readCardsPage)(
    store,
    project,
    new URL(
      `http://fixture/cards?view=summary&mode=board&sort=updated&limit=10${version ? `&since_version=${version}` : ""}`,
    ),
  );
  version = page.snapshot_version;
  samples.push({ ms: performance.now() - started, cards: page.cards.length });
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
const { profile } = await inspector.post("Profiler.stop");
inspector.disconnect();
const report = {
  sha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  mode,
  samples,
  p50_ms: samples.map((s) => s.ms).sort((a, b) => a - b)[2],
  counts: Object.fromEntries(
    ["cards", "events", "runs", "work_items"].map((table) => [
      table,
      store.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,
    ]),
  ),
};
writeFileSync(`${output}.json`, JSON.stringify(report, null, 2), {
  flag: "wx",
  mode: 0o600,
});
writeFileSync(`${output}.cpuprofile`, JSON.stringify(profile), {
  flag: "wx",
  mode: 0o600,
});
store.close();
console.log(JSON.stringify(report));
