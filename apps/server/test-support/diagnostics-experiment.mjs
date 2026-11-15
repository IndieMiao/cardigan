import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { HOST_OPS_ROLE_TOOLS } from "@cardigan/domain";
import { HostOpsService, UpstreamHealthMonitor } from "@cardigan/host";
import {
  authenticate,
  serverTools,
  startMcpServer,
  unwrap,
} from "@cardigan/mcp-server";
import { parseLaunchConfig } from "@cardigan/roles";
import { Store } from "@cardigan/store";
import { DiagnosticsReader } from "../dist/diagnostics-reader.js";
import { resolveWebConfig } from "../dist/web/config.js";
import { startWebServer } from "../dist/web/server.js";
import {
  FIXTURE_NOW,
  generateFixture,
  FIXTURE_PROJECT as project,
} from "./synthetic-fixture.mjs";

// Reference of the two pre-C-338 hot paths; domain diagnosis remains identical.
class LegacyMonitor extends UpstreamHealthMonitor {
  targets(state) {
    return state.assignments
      .filter(
        (a) =>
          a.status === "active" &&
          !a.external &&
          (a.scope !== "work_item" ||
            !state.cards.some(
              (c) =>
                ["done", "cancelled"].includes(c.status) &&
                state.work_items.some(
                  (w) => w.id === a.work_item_id && w.card_id === c.id,
                ),
            )),
      )
      .flatMap((a) => {
        const run = state.runs.findLast(
          (r) => r.assignment_id === a.id && r.launch_profile_ref,
        );
        const ref =
          run?.launch_profile_ref ??
          state.employees?.find((e) => e.id === a.employee_id)
            ?.launch_profile_ref;
        return ref
          ? [{ assignment_id: a.id, provider: "relay", group: "relay" }]
          : [];
      });
  }
  diagnostics(state, fresh) {
    const view = this.view(state, fresh);
    return {
      classification_available: view.unavailable_groups.size === 0,
      thresholds: this.policy,
      probe_configured: true,
      providers: view.probes,
      sessions: state.assignments
        .filter((a) => a.status === "active" && !a.external)
        .map((a) => this.diagnosis(state, a.id, undefined, fresh)),
    };
  }
}
const stats = (values) => {
  const a = [...values].sort((a, b) => a - b);
  return {
    n: a.length,
    p95_ms: a[Math.max(0, Math.ceil(a.length * 0.95) - 1)] ?? null,
    max_ms: a.at(-1) ?? null,
  };
};
const { values } = parseArgs({
  options: {
    output: { type: "string" },
    minutes: { type: "string", default: "10" },
    calls: { type: "string", default: "30" },
  },
});
if (!values.output)
  throw new Error("--output is required (use a temporary directory)");
const minutes = Number(values.minutes),
  calls = Number(values.calls);
if (!(minutes > 0 && minutes <= 10 && calls > 0 && calls <= 30))
  throw new Error("Bounded synthetic experiment only");
const root = await mkdtemp(join(tmpdir(), "cardigan-diagnostics-experiment-"));
let store, reader, web, mcp, baselineService;
const report = {
  seed: 338,
  synthetic: true,
  implementation_sha: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  baseline:
    "pre-C-338 targets and per-session view; same domain/state; excludes legacy read-side reconcile",
  observations: [],
};
const clock = { now: () => FIXTURE_NOW };
const config = parseLaunchConfig({
  providers: { relay: { harness: "codex", upstream: { group: "relay" } } },
  profiles: Object.fromEntries(
    [1, 2, 3].map((i) => [
      `synthetic-profile-${i}`,
      { harness: "codex", provider: "relay" },
    ]),
  ),
  upstream_health: {
    probe: { interval_ms: 1000, timeout_ms: 1000, stale_after_ms: 600000 },
  },
});
const runtime = {
  status: async () => ({
    ok: true,
    value: { process: "alive", agent: "idle", observed_seq: 1 },
  }),
  diagnostics: () => ({ synthetic: true }),
};
const rpc = async (url, token, name) => {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: {} },
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(!body.error && !body.result?.isError, JSON.stringify(body));
  return body.result.structuredContent;
};
try {
  const manifest = await generateFixture({
    out: join(root, "fixture"),
    profile: "diagnostics",
    seed: 338,
  });
  store = Store.open({ dbPath: join(root, "fixture/cardigan.db"), clock });
  store.setWebPassword("synthetic-experiment-only");
  const roles = [
    ["host_ops", HOST_OPS_ROLE_TOOLS],
    ["pm", ["project_snapshot"]],
  ];
  store.uow.run((tx) => {
    for (const [role, tools] of roles)
      tx.roles.put(project, {
        ...tx.roles.get(project, { role_id: role, role_version: 1 }),
        allowed_tools: tools,
      });
  });
  const assignments = store.uow.read((tx) => tx.assignments.list(project));
  const ops = assignments.find((a) => a.role_id === "host_ops");
  const pm = assignments.find(
    (a) => a.role_id === "pm" && a.scope === "standing",
  );
  const tokenFor = (a, tools) =>
    store.issueToken({
      project_id: project,
      assignment_id: a.id,
      role: { role_version: 1, allowed_tools: tools },
    }).token;
  const token = tokenFor(ops, HOST_OPS_ROLE_TOOLS);
  const context = { store, identity: unwrap(authenticate(store, token)) };
  report.counts = Object.fromEntries(
    Object.entries(manifest.tables).map(([name, value]) => [name, value.count]),
  );
  report.active_nonexternal_sessions = assignments.filter(
    (a) => a.status === "active" && !a.external,
  ).length;
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  const legacy = new LegacyMonitor(config, runtime, clock, undefined, store);
  baselineService = new HostOpsService({
    store,
    runtime,
    clock,
    upstreamMonitor: legacy,
    snapshot: async () => {
      throw new Error("read-only");
    },
  });
  mcp = await startMcpServer({
    store,
    hostOps: baselineService.tools,
    log: () => {},
    acknowledgeRuns: false,
  });
  await delay(30);
  const startOld = performance.now();
  const old = await rpc(mcp.url, token, "host_ops_read_diagnostics");
  report.old_diagnostics_rtt_ms = performance.now() - startOld;
  await delay(30);
  report.old_event_loop_max_ms = histogram.max / 1e6;
  await mcp.close();
  await baselineService.close();
  baselineService = undefined;
  const pmToken = tokenFor(pm, ["project_snapshot"]);
  const snapshotTool = serverTools({
    deliveryVerifier: () => {
      throw new Error("read-only");
    },
  }).find((t) => t.name === "project_snapshot");
  const startSnapshot = performance.now();
  const snapshot = await snapshotTool.handler(
    {},
    { store, identity: unwrap(authenticate(store, pmToken)) },
  );
  report.project_snapshot_ms = performance.now() - startSnapshot;
  report.project_snapshot_cards = snapshot.cards.length;
  reader = new DiagnosticsReader(
    { dbPath: join(root, "fixture/cardigan.db"), upstream: config },
    runtime,
    clock,
  );
  const stages = [];
  const directStart = performance.now();
  const fresh = await reader.read({
    ...context,
    recordTiming: (stage, ms) => stages.push({ stage, ms }),
  });
  report.cold_worker_ms = performance.now() - directStart;
  assert.deepEqual(fresh, old);
  report.output_equal = true;
  report.cold_worker_stages = stages;
  // True hot reads: unlike an MCP call, these do not update activity/revision.
  const hotRevision = store.uow.read(() => store.snapshotVersion(project));
  report.unchanged_revision_reads_ms = [];
  for (let i = 0; i < 3; i++) {
    const at = performance.now();
    assert.deepEqual(await reader.read(context), old);
    report.unchanged_revision_reads_ms.push(performance.now() - at);
    assert.equal(
      store.uow.read(() => store.snapshotVersion(project)),
      hotRevision,
    );
  }
  report.unchanged_revision_confirmed = true;
  report.cache_note =
    "MCP tools/call updates activity and invalidates assignment revision, including hot-labeled calls; hot means warm entity/event caches. Separate direct reads above hold the revision unchanged.";
  await reader.close();
  reader = new DiagnosticsReader(
    { dbPath: join(root, "fixture/cardigan.db"), upstream: config },
    runtime,
    clock,
  );
  const logs = [];
  mcp = await startMcpServer({
    store,
    hostOps: {
      read: (c, p) => reader.read(c, p),
      execute: async () => {
        throw new Error("read-only");
      },
    },
    log: (entry) => {
      if (entry.event === "tool") logs.push(entry);
    },
    acknowledgeRuns: false,
  });
  web = await startWebServer({
    store,
    dataDir: join(root, "fixture"),
    clock,
    config: resolveWebConfig({}, { port: 0 }),
    log: () => {},
  });
  const login = await fetch(`${web.url}/api/login`, {
    method: "POST",
    headers: { origin: web.url, "content-type": "application/json" },
    body: JSON.stringify({ password: "synthetic-experiment-only" }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const abort = new AbortController();
  const sse = await fetch(`${web.url}/api/projects/${project}/stream`, {
    headers: { cookie },
    signal: abort.signal,
  });
  assert.equal(sse.status, 200);
  const frameTimes = [],
    lightMcp = [],
    lightWeb = [],
    diagnostics = [];
  const start = performance.now();
  const stream = (async () => {
    let buffer = "";
    const decoder = new TextDecoder();
    for await (const chunk of sse.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let end = buffer.indexOf("\n\n");
      while (end >= 0) {
        frameTimes.push(performance.now() - start);
        buffer = buffer.slice(end + 2);
        end = buffer.indexOf("\n\n");
      }
    }
  })().catch((error) => {
    if (!abort.signal.aborted) throw error;
  });
  histogram.reset();
  const duration = minutes * 60000;
  const light = (async () => {
    while (performance.now() - start < duration) {
      let at = performance.now();
      await rpc(mcp.url, token, "whoami");
      lightMcp.push(performance.now() - at);
      at = performance.now();
      const r = await fetch(`${web.url}/api/projects`, { headers: { cookie } });
      assert.equal(r.status, 200);
      await r.arrayBuffer();
      lightWeb.push(performance.now() - at);
      await delay(
        Math.min(2000, Math.max(0, duration - (performance.now() - start))),
      );
    }
  })();
  for (let i = 0; i < calls; i++) {
    const due = start + (i * duration) / calls;
    if (performance.now() < due) await delay(due - performance.now());
    const state = i === 0 ? "cold" : i % 3 === 0 ? "revision" : "hot";
    if (state === "revision")
      store.uow.run((tx) => {
        const a = tx.assignments.get(project, ops.id);
        tx.assignments.put(project, {
          ...a,
          last_mcp_activity_at: FIXTURE_NOW,
        });
      });
    const at = performance.now();
    await rpc(mcp.url, token, "host_ops_read_diagnostics");
    const ms = performance.now() - at;
    diagnostics.push(ms);
    report.observations.push({
      call: i + 1,
      state,
      offset_ms: at - start,
      rtt_ms: ms,
    });
    process.stdout.write(
      `${JSON.stringify({ call: i + 1, state, rtt_ms: ms })}\n`,
    );
  }
  await light;
  report.elapsed_ms = performance.now() - start;
  report.event_loop_max_ms = histogram.max / 1e6;
  report.event_loop_p99_ms = histogram.percentile(99) / 1e6;
  histogram.disable();
  abort.abort();
  await stream;
  report.diagnostics = stats(diagnostics);
  report.light_mcp = stats(lightMcp);
  report.light_web = stats(lightWeb);
  report.sse = {
    frames: frameTimes.length,
    connection_ms: report.elapsed_ms,
    gaps: stats(frameTimes.slice(1).map((at, i) => at - frameTimes[i])),
    frame_offsets_ms: frameTimes,
  };
  report.tool_phases = logs
    .filter((l) => l.tool === "host_ops_read_diagnostics")
    .map((l) => ({
      timestamp: l.timestamp,
      request_id: l.request_id,
      phases_ms: l.phases_ms,
    }));
  await writeFile(values.output, `${JSON.stringify(report, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  process.stdout.write(
    `${JSON.stringify({ complete: true, output_equal: true, diagnostics: report.diagnostics, light_mcp: report.light_mcp, light_web: report.light_web, event_loop_max_ms: report.event_loop_max_ms })}\n`,
  );
} finally {
  await reader?.close();
  await mcp?.close();
  await web?.close();
  await baselineService?.close();
  store?.close();
  await rm(root, { recursive: true, force: true });
}
