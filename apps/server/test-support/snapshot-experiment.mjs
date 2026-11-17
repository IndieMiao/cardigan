/** C-342: four bounded snapshot reads on newly generated, synthetic data only. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from "node:worker_threads";
import { referenceProjectSnapshot } from "@cardigan/domain";
import {
  loadCommandState,
  serverTools,
  startMcpServer,
} from "@cardigan/mcp-server";
import { Store } from "@cardigan/store";
import {
  FIXTURE_NOW,
  generateFixture,
  FIXTURE_PROJECT as project,
} from "./synthetic-fixture.mjs";

const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
if (!isMainThread) {
  // Client has its own event loop: the light request can arrive while the server is blocked.
  const rpc = async (name) => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: {} },
    });
    const start = performance.now();
    const response = await fetch(workerData.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${workerData.token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        connection: "close",
      },
      body,
    });
    const text = await response.text();
    const rtt_ms = performance.now() - start;
    const value = JSON.parse(text);
    assert.equal(response.status, 200);
    assert.ok(!value.error && !value.result?.isError, "Synthetic RPC failed");
    return {
      rtt_ms,
      request_bytes: Buffer.byteLength(body),
      response_bytes: Buffer.byteLength(text),
      data: value.result.structuredContent,
    };
  };
  parentPort.on("message", async () => {
    try {
      const snapshot = rpc("project_snapshot");
      const light = delay(10).then(() => rpc("whoami"));
      const result = await Promise.all([snapshot, light]);
      parentPort.postMessage({ snapshot: result[0], light: result[1] });
    } catch (error) {
      parentPort.postMessage({
        error: String(error),
        cause: String(error.cause),
      });
    }
  });
} else {
  const [output, compare] = process.argv.slice(2);
  if (!output)
    throw new Error("Expected new output prefix and optional baseline prefix");
  const root = await mkdtemp(join(tmpdir(), "cardigan-snapshot-"));
  const report = {
    seed: 338,
    synthetic: true,
    sha: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    samples: [],
  };
  let store, external, mcp, client, active, heartbeat;
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (...args) {
    const stmt = prepare.apply(this, args);
    return new Proxy(stmt, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (typeof value !== "function") return value;
        return (...params) => {
          if (active && ["all", "get", "run"].includes(key)) active.sql_calls++;
          return value.apply(target, params);
        };
      },
    });
  };
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  const responses = [];
  try {
    const manifest = await generateFixture({
      out: join(root, "fixture"),
      profile: "diagnostics",
      seed: 338,
    });
    report.counts = Object.fromEntries(
      Object.entries(manifest.tables).map(([key, value]) => [key, value.count]),
    );
    const dbPath = join(root, "fixture/cardigan.db");
    const clock = { now: () => FIXTURE_NOW };
    store = Store.open({ dbPath, clock });
    external = Store.open({ dbPath, clock });
    const pm = store.uow.read((tx) =>
      tx.assignments
        .list(project)
        .find((a) => a.role_id === "pm" && a.scope === "standing"),
    );
    const allowed_tools = ["project_snapshot", "whoami"];
    store.uow.run((tx) =>
      tx.roles.put(project, {
        ...tx.roles.get(project, { role_id: "pm", role_version: 1 }),
        allowed_tools,
      }),
    );
    const token = store.issueToken({
      project_id: project,
      assignment_id: pm.id,
      role: { role_version: 1, allowed_tools },
    }).token;
    report.active_nonexternal_sessions = store.uow.read(
      (tx) =>
        tx.assignments
          .list(project)
          .filter((a) => a.status === "active" && !a.external).length,
    );
    const measuredUow = { ...store.uow };
    for (const method of ["read", "run"]) {
      const original = store.uow[method].bind(store.uow);
      measuredUow[method] = (operation) => {
        if (!active) return original(operation);
        const start = performance.now();
        const cpu = process.cpuUsage();
        try {
          return original((tx) =>
            operation(
              new Proxy(tx, {
                get(target, key) {
                  if (key === "events" || key === "work_items")
                    return new Proxy(target[key], {
                      get(repository, action) {
                        const fn = repository[action];
                        if (typeof fn !== "function") return fn;
                        return (...args) => {
                          if (key === "work_items" && action === "list")
                            active.work_item_lists++;
                          const started = performance.now();
                          const cpu = process.cpuUsage();
                          try {
                            return fn.apply(repository, args);
                          } finally {
                            if (key === "events" && action === "listStreams") {
                              const usage = process.cpuUsage(cpu);
                              active.state_load_cpu_ms +=
                                (usage.user + usage.system) / 1000;
                              active.state_load_ms +=
                                performance.now() - started;
                            }
                          }
                        };
                      },
                    });
                  if (key === "cachedCommandState")
                    return (...args) => {
                      const started = performance.now();
                      const cpu = process.cpuUsage();
                      try {
                        return target[key](...args);
                      } finally {
                        const usage = process.cpuUsage(cpu);
                        active.state_load_cpu_ms +=
                          (usage.user + usage.system) / 1000;
                        active.state_load_ms += performance.now() - started;
                      }
                    };
                  return Reflect.get(target, key);
                },
              }),
            ),
          );
        } finally {
          const usage = process.cpuUsage(cpu);
          active[`${method}_ms`] += performance.now() - start;
          active[`${method}_cpu_ms`] += (usage.user + usage.system) / 1000;
        }
      };
    }
    const tools = serverTools({
      clock,
      deliveryVerifier: () => {
        throw new Error("Read-only experiment");
      },
    }).map((tool) =>
      tool.name !== "project_snapshot"
        ? tool
        : {
            ...tool,
            handler: (args, context) => {
              const metric = {
                sql_calls: 0,
                work_item_lists: 0,
                state_load_ms: 0,
                state_load_cpu_ms: 0,
                read_ms: 0,
                run_ms: 0,
                read_cpu_ms: 0,
                run_cpu_ms: 0,
              };
              active = metric;
              try {
                return tool.handler(args, context);
              } finally {
                active = undefined;
                report.samples.at(-1).handler = metric;
              }
            },
          },
    );
    mcp = await startMcpServer({
      store: new Proxy(store, {
        get(target, key) {
          if (key === "uow") return measuredUow;
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
      tools,
      clock,
      log: (entry) => {
        if (entry.event === "tool" && entry.tool === "project_snapshot")
          report.samples.at(-1).tool_phases_ms = entry.phases_ms;
      },
    });
    client = new Worker(new URL(import.meta.url), {
      workerData: { url: mcp.url, token },
    });
    histogram.enable();
    for (const mode of ["cold", "warm", "warm", "revision"]) {
      if (mode === "revision")
        external.uow.run((tx) => {
          const card = tx.cards.list(project)[0];
          tx.cards.put(project, { ...card, title: "Synthetic revised title" });
          tx.events.append(project, {
            id: tx.ids.nextEventId(),
            seq: tx.ids.nextEventSequence(project, card.id),
            card_id: card.id,
            actor: { kind: "system", project_id: project },
            type: "card_updated",
            payload: {},
            created_at: FIXTURE_NOW,
          });
        });
      await delay(1000);
      let lastBeat = performance.now();
      let timerMax = 0;
      heartbeat = setInterval(() => {
        const now = performance.now();
        timerMax = Math.max(timerMax, now - lastBeat);
        lastBeat = now;
      }, 10);
      await delay(30);
      histogram.reset();
      timerMax = 0;
      console.error("Measuring", mode);
      const sample = { mode };
      report.samples.push(sample);
      const cpu = process.cpuUsage();
      const result = await new Promise((resolve, reject) => {
        client.once("message", resolve);
        client.once("error", reject);
        client.postMessage("read");
      });
      assert.ok(!result.error, JSON.stringify(result));
      const usage = process.cpuUsage(cpu);
      await delay(30);
      clearInterval(heartbeat);
      responses.push(result.snapshot.data);
      Object.assign(sample, {
        cpu_ms: (usage.user + usage.system) / 1000,
        event_loop_max_ms: Math.max(histogram.max / 1e6, timerMax),
        event_loop_histogram_max_ms: histogram.max / 1e6,
        event_loop_timer_max_ms: timerMax,
        snapshot_rtt_ms: result.snapshot.rtt_ms,
        light_rtt_ms: result.light.rtt_ms,
        request_bytes: result.snapshot.request_bytes,
        response_bytes: result.snapshot.response_bytes,
        response_sha256: digest(result.snapshot.data),
        cards: result.snapshot.data.cards.length,
      });
    }
    // Separate unchanged-revision reads: real MCP calls update activity and append read audits.
    const actor = {
      kind: "assignment",
      project_id: project,
      assignment_id: pm.id,
      role_id: pm.role_id,
      role_version: 1,
      allowed_tools,
    };
    report.unchanged_revision = [];
    for (let i = 0; i < 2; i++) {
      await delay(1000);
      const start = performance.now();
      const result = store.uow.read((tx) =>
        referenceProjectSnapshot(loadCommandState(tx, project), actor),
      );
      assert.ok(result.ok);
      report.unchanged_revision.push({
        ms: performance.now() - start,
        response_sha256: digest(result.value.data),
      });
    }
    if (compare) {
      assert.deepEqual(
        responses,
        JSON.parse(await readFile(`${compare}.responses.json`, "utf8")),
      );
      report.baseline_equal = true;
    }
    await writeFile(`${output}.responses.json`, JSON.stringify(responses), {
      flag: "wx",
      mode: 0o600,
    });
    await writeFile(`${output}.json`, JSON.stringify(report, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    clearInterval(heartbeat);
    histogram.disable();
    await client?.terminate();
    await mcp?.close();
    external?.close();
    store?.close();
    DatabaseSync.prototype.prepare = prepare;
    await rm(root, { recursive: true, force: true });
  }
}
