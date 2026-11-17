/** C-415: bounded background reducers on an explicit credential-free copy.
 * Does not persist effects, discover configuration or perform runtime/Git IO.
 * node test-support/maintenance-profile.mjs COPY_DB NEW_OUTPUT_PREFIX [project]
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { performance } from "node:perf_hooks";
import { maintainPmCoordination, remindSystemWaits } from "@cardigan/domain";
import { loadCommandState } from "@cardigan/mcp-server";
import { Store } from "@cardigan/store";

const [dbPath, output, project = "cardigan"] = process.argv.slice(2);
if (!dbPath || !output)
  throw new Error("Expected COPY_DB NEW_OUTPUT_PREFIX [project]");
const store = Store.open({ dbPath });
store.database.exec("PRAGMA query_only = ON");
const state = store.uow.read((tx) => loadCommandState(tx, project));
const now = state.events
  .map((e) => e.created_at)
  .sort()
  .at(-1);
if (!now) throw new Error("Expected a nonempty event snapshot");
const actor = { kind: "system", project_id: project };
const samples = [];
const inspector = new Session();
inspector.connect();
await inspector.post("Profiler.enable");
await inspector.post("Profiler.start");
for (let sample = 0; sample < 5; sample++) {
  const results = {};
  for (const [name, reduce] of Object.entries({
    maintainPmCoordination,
    remindSystemWaits,
  })) {
    let serial = 0;
    const ports = {
      clock: { now: () => now },
      ids: {
        nextEventId: () => String(++serial).padStart(26, "0"),
        nextEventSequence: () => ++serial,
        nextTimelineEntryId: (_project, card) => `${card}#${++serial}`,
      },
    };
    const start = performance.now();
    const result = reduce(state, actor, ports);
    results[name] = {
      ms: performance.now() - start,
      ok: result.ok,
      effect_sha256: createHash("sha256")
        .update(JSON.stringify(result))
        .digest("hex"),
    };
    if (!result.ok) throw new Error(`${name} rejected the fixture`);
  }
  samples.push(results);
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
const { profile } = await inspector.post("Profiler.stop");
inspector.disconnect();
const report = {
  source: "explicit-disposable-copy",
  node: process.version,
  clock: now,
  counts: Object.fromEntries(
    ["cards", "events", "timeline", "runs"].map((key) => [
      key,
      state[key].length,
    ]),
  ),
  samples,
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
