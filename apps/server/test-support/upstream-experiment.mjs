import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { recordUpstreamHealth } from "@cardigan/domain";
import { UpstreamHealthMonitor } from "@cardigan/host";
import { loadCommandState, unwrap } from "@cardigan/mcp-server";
import { parseLaunchConfig } from "@cardigan/roles";
import { newUlid, Store } from "@cardigan/store";
import ts from "typescript";
import {
  FIXTURE_NOW,
  generateFixture,
  hash,
  FIXTURE_PROJECT as project,
  tableDigests,
} from "./synthetic-fixture.mjs";

// A bounded, single-call comparison. No network, production discovery or polling loop.
const baseline = "b4d1e1b90f4f1f953839f130a85c48d37c53a66e";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const root = await mkdtemp(join(tmpdir(), "cardigan-upstream-experiment-"));
const clock = { now: () => FIXTURE_NOW };
const at = (minutes) =>
  new Date(Date.parse(FIXTURE_NOW) + minutes * 60000).toISOString();
const eventId = (n) => newUlid(Date.parse(FIXTURE_NOW) + n, new Uint8Array(10));
const config = parseLaunchConfig({
  providers: { relay: { harness: "codex", upstream: { group: "relay" } } },
  profiles: Object.fromEntries(
    [1, 2, 3].map((n) => [
      `synthetic-profile-${n}`,
      { harness: "codex", provider: "relay" },
    ]),
  ),
});
const runtime = {
  status: async () => {
    throw new Error("No runtime IO in experiment");
  },
};
let source, oldStore, newStore;
try {
  const manifest = await generateFixture({
    out: join(root, "fixture"),
    profile: "diagnostics",
    seed: 345,
  });
  source = Store.open({ dbPath: join(root, "fixture/cardigan.db"), clock });
  source.uow.run((tx) => {
    const runs = tx.runs.list(project);
    const template = runs[0];
    for (const a of tx.assignments
      .list(project)
      .filter((a) => a.status === "active" && !a.external)) {
      tx.assignments.put(project, { ...a, last_mcp_activity_at: at(-30) });
      const run = runs.findLast((r) => r.assignment_id === a.id) ?? {
        ...template,
        id: tx.ids.next(project, "run"),
        assignment_id: a.id,
      };
      tx.runs.put(project, {
        ...run,
        status: "running",
        started_at: at(-30),
        heartbeat_at: at(-30),
        launch_profile_ref: "synthetic-profile-1",
      });
      tx.events.append(project, {
        id: eventId(Number(a.id.slice(2))),
        seq: tx.ids.nextEventSequence(project),
        type: "run_inactive",
        actor: { kind: "system", project_id: project },
        payload: { assignment_id: a.id, run_id: run.id },
        created_at: at(-5),
      });
    }
  });
  const inputTables = tableDigests(source.database);
  source.close();
  source = undefined;
  await copyFile(join(root, "fixture/cardigan.db"), join(root, "old.db"));
  await copyFile(join(root, "fixture/cardigan.db"), join(root, "new.db"));
  // Compile only the three original modules into this private temporary directory.
  // All remaining imports resolve to the same current built dependencies.
  const replacements = new Map([
    ["packages/domain/src/upstream-health.ts", join(root, "analysis.mjs")],
    [
      "packages/domain/src/commands/upstream-health.ts",
      join(root, "command.mjs"),
    ],
    ["packages/host/src/upstream-health.ts", join(root, "monitor.mjs")],
  ]);
  for (const [path, target] of replacements) {
    const original = execFileSync("git", ["show", `${baseline}:${path}`], {
      cwd: repo,
      encoding: "utf8",
    });
    let code = ts.transpileModule(original, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2024,
        module: ts.ModuleKind.ESNext,
      },
    }).outputText;
    code = code.replace(/from "([^"]+)"/g, (_, spec) => {
      let url = spec;
      if (spec.startsWith(".")) {
        const src = join(dirname(path), spec).replace(/\.js$/, ".ts");
        url = pathToFileURL(
          replacements.get(src) ??
            join(repo, src.replace("/src/", "/dist/").replace(/\.ts$/, ".js")),
        ).href;
      } else if (spec === "@cardigan/domain" && path.includes("host/src")) {
        url = pathToFileURL(join(root, "domain.mjs")).href;
      } else if (!spec.startsWith("node:")) url = import.meta.resolve(spec);
      return `from ${JSON.stringify(url)}`;
    });
    await writeFile(target, code);
  }
  await writeFile(
    join(root, "domain.mjs"),
    `export * from ${JSON.stringify(import.meta.resolve("@cardigan/domain"))};\nexport { recordUpstreamHealth } from "./command.mjs";\nexport { diagnoseUpstream, diagnoseUpstreams } from "./analysis.mjs";\n`,
  );
  const legacy = await import(pathToFileURL(join(root, "command.mjs")).href);
  const { UpstreamHealthMonitor: LegacyMonitor } = await import(
    pathToFileURL(join(root, "monitor.mjs")).href
  );
  oldStore = Store.open({ dbPath: join(root, "old.db"), clock });
  newStore = Store.open({ dbPath: join(root, "new.db"), clock });
  const state = newStore.uow.read((tx) => loadCommandState(tx, project));
  const view = new UpstreamHealthMonitor(
    config,
    runtime,
    clock,
    undefined,
    newStore,
  ).view(state);
  assert.equal(view.targets.length, 40);
  assert.ok(
    state.events.length >= 55000 &&
      state.runs.length >= 5500 &&
      state.assignments.length >= 1000,
  );
  const calls = {};
  const counted = { ...state };
  for (const key of ["events", "runs", "assignments"]) {
    calls[key] = 0;
    counted[key] = new Proxy(state[key], {
      get(target, prop, receiver) {
        if (prop === Symbol.iterator)
          return function* () {
            calls[key]++;
            yield* target;
          };
        return Reflect.get(target, prop, receiver);
      },
    });
  }
  // Run each command in a rollback-only transaction, including identical counter state.
  const effect = (fn, snapshot) => {
    let output;
    const rollback = new Error("synthetic rollback");
    try {
      newStore.uow.run((tx) => {
        let serial = 100000;
        const ids = { ...tx.ids, nextEventId: () => eventId(serial++) };
        output = unwrap(
          fn(snapshot, { kind: "system", project_id: project }, view, {
            clock,
            ids,
          }),
        );
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
    return output;
  };
  const oldEffect = effect(legacy.recordUpstreamHealth, state);
  const newEffect = effect(recordUpstreamHealth, counted);
  assert.deepEqual(newEffect, oldEffect);
  assert.deepEqual(calls, { events: 1, runs: 1, assignments: 1 });
  const reconcile = (Monitor, store) => {
    const monitor = new Monitor(config, runtime, clock, undefined, store);
    let serial = 100000;
    // Keep real counters, transactions, notification writes and snapshot revisions;
    // only replace random event identifiers so every persisted table is comparable.
    const facade = {
      database: store.database,
      uow: {
        run: (fn) =>
          store.uow.run((tx) =>
            fn({
              ...tx,
              ids: { ...tx.ids, nextEventId: () => eventId(serial++) },
            }),
          ),
      },
    };
    // Both paths start with a decoded, unchanged CommandState cache.
    store.uow.read((tx) => loadCommandState(tx, project));
    const start = performance.now();
    monitor.reconcile(facade, project);
    const elapsed = performance.now() - start;
    assert.equal(
      monitor.diagnostics(store.uow.read((tx) => loadCommandState(tx, project)))
        .classification_available,
      true,
    );
    return elapsed;
  };
  const oldMs = reconcile(LegacyMonitor, oldStore);
  const newMs = reconcile(UpstreamHealthMonitor, newStore);
  const oldTables = tableDigests(oldStore.database),
    newTables = tableDigests(newStore.database);
  const bindNotificationIds = (store, tables) => {
    const ids = store.database
      .prepare(
        "SELECT id, event_id, recipient_kind, assignment_id FROM notifications",
      )
      .all()
      .map((n) => [
        n.id,
        `ntf_synthetic:${n.event_id}:${n.recipient_kind}:${n.assignment_id}`,
      ]);
    const normalized = { ...tables };
    for (const name of ["notifications", "command_rows"]) {
      const rows = store.database
        .prepare(`SELECT * FROM ${name}`)
        .all()
        .map((row) => {
          let text = JSON.stringify(row);
          for (const [id, binding] of ids) text = text.replaceAll(id, binding);
          return text;
        })
        .sort();
      normalized[name] = {
        count: rows.length,
        sha256: hash(JSON.stringify(rows)),
      };
    }
    return normalized;
  };
  assert.deepEqual(
    bindNotificationIds(newStore, newTables),
    bindNotificationIds(oldStore, oldTables),
  );
  assert.ok(
    newTables.events.count > inputTables.events.count,
    "reconcile must persist real incident output",
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        seed: 345,
        baseline_sha: baseline,
        counts: Object.fromEntries(
          Object.entries(inputTables).map(([k, v]) => [k, v.count]),
        ),
        generated_counts: manifest.counts,
        active_sessions: view.targets.length,
        command_effect_equal: true,
        persisted_tables_equal_after_notification_id_binding: true,
        notification_id_note:
          "Random notification IDs are bound by identical event and recipient; all other columns and all tables are compared.",
        index_builds: calls,
        reconcile_ms: { before: oldMs, after: newMs },
        new_event_count: newTables.events.count - inputTables.events.count,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  source?.close();
  oldStore?.close();
  newStore?.close();
  await rm(root, { recursive: true, force: true });
}
