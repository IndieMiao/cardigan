// Single-request CPU profiles, isolated synthetic database; no server loops.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  FIXTURE_NOW,
  FIXTURE_PROJECT,
  generateFixture,
} from "../test-support/synthetic-fixture.mjs";

const root = resolve(process.argv[2] ?? ".");
const output = resolve(process.argv[3] ?? join(tmpdir(), "needs-you"));
const moduleAt = (p) => import(pathToFileURL(join(root, p)).href);
const { Store } = await moduleAt("packages/store/dist/index.js");
const gate = process.argv[4] ?? "enabled";
if (!["enabled", "disabled", "invalid"].includes(gate))
  throw new Error("Invalid gate");
const mode = process.argv[5] ?? "current";
if (!["previous", "current"].includes(mode)) throw new Error("Invalid mode");
const currentReader = await moduleAt("apps/server/dist/web/needs-state.js");
const currentView = await moduleAt("apps/server/dist/web/read.js");
const { readNeedsVersion } = await moduleAt(
  "apps/server/dist/web/needs-version.js",
);
const { loadNeedsReference } = await import(
  "../test-support/needs-reference.mjs"
);
const reference =
  mode === "previous" ? await loadNeedsReference(root) : undefined;
const readNeedsState =
  reference?.readNeedsState ?? currentReader.readNeedsState;
const needsYou = reference?.needsYou ?? currentView.needsYou;
const directory = await mkdtemp(join(tmpdir(), "needs-you-bench-"));
let store;
try {
  const data = join(directory, "data");
  const manifest = await generateFixture({ out: data, profile: "needs-you" });
  store = Store.open({ dataDir: data });
  const rows = Object.fromEntries(
    ["events", "timeline", "notifications", "decisions", "cards", "runs"].map(
      (table) => [
        table,
        Number(
          store.database
            .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`)
            .get(FIXTURE_PROJECT).n,
        ),
      ],
    ),
  );
  const samples = [];
  let response;
  for (const condition of ["cold", "warm", "after-write", "after-event"]) {
    if (condition === "after-write")
      store.uow.run((tx) => {
        const q = tx.decisions.list(FIXTURE_PROJECT)[0];
        tx.decisions.put(FIXTURE_PROJECT, {
          ...q,
          context: `${q.context} updated`,
        });
      });
    if (condition === "after-event")
      store.uow.run((tx) =>
        tx.events.append(FIXTURE_PROJECT, {
          id: tx.ids.nextEventId(),
          seq: tx.ids.nextEventSequence(FIXTURE_PROJECT),
          type: "fixture_observed",
          actor: { kind: "system", project_id: FIXTURE_PROJECT },
          payload: { synthetic: true },
          created_at: FIXTURE_NOW,
        }),
      );
    const profiler = new Session();
    profiler.connect();
    await profiler.post("Profiler.enable");
    await profiler.post("Profiler.start");
    const start = performance.now();
    const state = readNeedsState(store, FIXTURE_PROJECT);
    const read_ms = performance.now() - start;
    response = needsYou(state, FIXTURE_NOW, gate);
    const total_ms = performance.now() - start;
    const revisionStarted = performance.now();
    if (mode === "current")
      readNeedsVersion(
        store,
        FIXTURE_PROJECT,
        `benchmark:${gate}`,
        FIXTURE_NOW,
      );
    const revision_ms =
      mode === "current" ? performance.now() - revisionStarted : null;
    const { profile } = await profiler.post("Profiler.stop");
    profiler.disconnect();
    for (const node of profile.nodes) {
      if (node.callFrame.url.startsWith("data:"))
        node.callFrame.url = "reference/previous-needs-you.js";
      else if (node.callFrame.url.startsWith("file://"))
        node.callFrame.url = relative(
          root,
          new URL(node.callFrame.url).pathname,
        );
      else if (node.callFrame.url.startsWith("/"))
        node.callFrame.url = relative(root, node.callFrame.url);
    }
    const parents = new Map();
    for (const n of profile.nodes)
      for (const c of n.children ?? []) parents.set(c, n);
    const top = profile.nodes
      .filter((n) => n.hitCount)
      .sort((a, b) => b.hitCount - a.hitCount)
      .slice(0, 12)
      .map((n) => ({
        function: n.callFrame.functionName,
        file: n.callFrame.url,
        line: n.callFrame.lineNumber + 1,
        caller: parents.get(n.id)?.callFrame,
        samples: n.hitCount,
      }));
    samples.push({
      condition,
      read_ms,
      total_ms,
      revision_ms,
      state_rows: {
        events: state.events.length,
        timeline: state.timeline.length,
      },
      top,
    });
    await writeFile(
      `${output}-${condition}.cpuprofile`,
      JSON.stringify(profile),
    );
  }
  const result = {
    node: process.version,
    seed: manifest.seed,
    gate,
    mode,
    rows,
    samples,
  };
  await writeFile(`${output}.json`, JSON.stringify(result, null, 2));
  await writeFile(`${output}-response.json`, JSON.stringify(response));
  console.log(JSON.stringify(result, null, 2));
} finally {
  store?.close();
  await rm(directory, { recursive: true, force: true });
}
