/** C-386: real command/dispatcher paths over synthetic history, no external IO.
 * Node's native type stripping loads the existing isolated test fixture.
 * Build apps/server first; pass a new output prefix. Five sequential operations.
 */

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { performance } from "node:perf_hooks";
import { postComment, prepareDelivery, submitDelivery } from "@cardigan/domain";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import { PROJECT_EVENT_STREAM } from "@cardigan/store";
import { Dispatcher } from "../dist/dispatch.js";
import { setTickProfiler, TickProfiler } from "../dist/tick-profile.js";
import { dispatchFixture } from "./dispatch.ts";
import { seedScenarios } from "./synthetic-scenarios.mjs";

const output = process.argv[2];
if (!output) throw new Error("Expected new output prefix");
const sha = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const f = dispatchFixture();
const size = {
  cards: 350,
  work_items: 1050,
  runs: 5500,
  events: 55000,
  timeline: 18075,
  attachments: 0,
  decisions: 590,
};
let seed = 386,
  serial = 0;
f.store.uow.run((tx) => {
  const roles = tx.roles.list(f.project);
  seedScenarios(tx, {
    size,
    project: f.project,
    now: f.clock.now(),
    random: () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0),
    eventId: () => `synthetic-${++serial}`,
    avatar: null,
    blobs: [{ sha256: "0".repeat(64), size: 0 }],
  });
  for (const role of roles) tx.roles.put(f.project, role);
});
for (const card of [undefined, ...f.state().cards.map((c) => c.id)])
  f.store.advanceRouterCursor(
    f.project,
    card ?? PROJECT_EVENT_STREAM,
    f.store.getUpdates({
      project_id: f.project,
      ...(card ? { card_id: card } : {}),
    }).latest_seq,
  );
const lines = [];
const profiler = new TickProfiler({
  sha,
  log: (line) => lines.push(line),
  reportIntervalMs: 0,
});
setTickProfiler(profiler);
f.store.observe(profiler.storeObserver);
let wakes = 0;
const dispatcher = new Dispatcher({
  store: f.store,
  clock: f.clock,
  runtime: {
    status: async () => ({
      ok: true,
      value: { process: "alive", agent: "idle", observed_seq: 1 },
    }),
    wake: async (_ref, _bell, options) => {
      if (options?.before_send && !(await options.before_send()))
        return { ok: true, value: { sent: false, withdrawn: true } };
      wakes++;
      return { ok: true, value: { sent: true } };
    },
    release: async () => ({ ok: true, value: undefined }),
  },
  snapshot: async () => ({ model: "fixture", agent_cli_version: "fixture" }),
  startRun: async () => {},
});
const inspector = new Session();
inspector.connect();
await inspector.post("Profiler.enable");
await inspector.post("Profiler.start");
const deliveries = [];
for (let i = 0; i < 5; i++) {
  const target = f.create();
  f.session(target.assignment, false);
  const params = {
    work_item_id: target.item.id,
    kind: "code",
    summary: "Synthetic measurement",
    subject: { kind: "git_head", value: "a".repeat(40) },
    requested_verifiers: f
      .state()
      .work_items.filter((w) => w.target_work_item_id === target.item.id)
      .map((w) => w.id),
  };
  const started = performance.now();
  const state = f.state();
  const actor = f.actorFor(target.assignment);
  const prepared = unwrap(
    await prepareDelivery(state, actor, params, {
      verify: async () => ({ ok: true, value: [] }),
    }),
  );
  const preparedAt = performance.now();
  f.store.uow.run((tx) =>
    persistEffect(
      tx,
      f.project,
      unwrap(
        submitDelivery(
          loadCommandState(tx, f.project),
          actor,
          params,
          prepared,
          { clock: f.clock, ids: tx.ids },
        ),
      ),
    ),
  );
  deliveries.push({
    prepare_ms: preparedAt - started,
    commit_ms: performance.now() - preparedAt,
  });
  const candidate = f.create();
  f.session(candidate.assignment);
  f.apply((s, a, p) =>
    postComment(
      s,
      a,
      {
        card_id: candidate.card.id,
        body: `@${candidate.assignment.id} synthetic followup`,
      },
      p,
    ),
  );
  await profiler.tick("dispatcher", () => dispatcher.tick());
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
const { profile } = await inspector.post("Profiler.stop");
inspector.disconnect();
profiler.stop();
setTickProfiler(undefined);
const report = { sha, seed: 386, size, deliveries, wakes, lines };
writeFileSync(`${output}.json`, JSON.stringify(report, null, 2), {
  flag: "wx",
  mode: 0o600,
});
writeFileSync(`${output}.cpuprofile`, JSON.stringify(profile), {
  flag: "wx",
  mode: 0o600,
});
f.close();
console.log(JSON.stringify(report));
