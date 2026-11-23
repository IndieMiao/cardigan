/**
 * C-648: project_snapshot on a cardigan-scale synthetic project (630 cards,
 * 193k events, card dependencies and a 63k-event system stream), served by a
 * real MCP endpoint. Measures the Web event loop while a separate client
 * thread reads the snapshot and sends a light request 10 ms later.
 *
 *   node apps/server/test-support/snapshot-worker-experiment.mjs <inline|worker> <new output prefix> [rounds]
 *
 * Only newly generated synthetic data in a temporary directory is read; the
 * directory is deleted on exit. Run without parallel local tests.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from "node:worker_threads";
import { startMcpServer } from "@cardigan/mcp-server";
import { Store } from "@cardigan/store";
import {
  FIXTURE_NOW,
  generateFixture,
  PROFILES,
  FIXTURE_PROJECT as project,
} from "./synthetic-fixture.mjs";

const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

if (!isMainThread) {
  const rpc = async (token, name) => {
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
        authorization: `Bearer ${token}`,
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
    assert.ok(!value.error && !value.result?.isError, text.slice(0, 300));
    return {
      rtt_ms,
      response_bytes: Buffer.byteLength(text),
      data: value.result.structuredContent,
    };
  };
  parentPort.on("message", async ({ token }) => {
    try {
      const snapshot = rpc(token, "project_snapshot");
      const light = delay(10).then(() => rpc(token, "whoami"));
      const [s, l] = await Promise.all([snapshot, light]);
      parentPort.postMessage({ snapshot: s, light: l });
    } catch (error) {
      parentPort.postMessage({ error: String(error) });
    }
  });
} else {
  const [mode, output, roundsArg] = process.argv.slice(2);
  if (!["inline", "worker"].includes(mode) || !output)
    throw new Error("Expected <inline|worker> <new output prefix> [rounds]");
  const rounds = Number(roundsArg ?? (mode === "worker" ? 20 : 3));
  const root = await mkdtemp(join(tmpdir(), "cardigan-c648-"));
  let store, mcp, client, reader, heartbeat;
  const histogram = monitorEventLoopDelay({ resolution: 5 });
  try {
    PROFILES["c648-cardigan"] = {
      cards: 630,
      work_items: 2100,
      timeline: 40000,
      events: 130000,
      runs: 9000,
      attachments: 4000,
      decisions: 1200,
    };
    await generateFixture({
      out: join(root, "fixture"),
      profile: "c648-cardigan",
      seed: 648,
    });
    const dbPath = join(root, "fixture/cardigan.db");
    store = Store.open({ dbPath, clock: { now: () => FIXTURE_NOW } });
    // Shape of the reported project: 590 closed cards (most merged), chained
    // dependencies and a long system stream without card ids.
    let n = 0;
    const append = (tx, card, type, payload) =>
      tx.events.append(project, {
        id: `synthetic-c648-${n++}`,
        ...(card ? { card_id: card } : {}),
        seq: tx.ids.nextEventSequence(project, card),
        type,
        actor: { kind: "system", project_id: project },
        payload,
        created_at: FIXTURE_NOW,
      });
    const allowed_tools = ["project_snapshot", "whoami"];
    store.uow.run((tx) => {
      const cards = tx.cards.list(project);
      const closed = new Set(
        cards.slice(0, cards.length - 40).map((c) => c.id),
      );
      cards.forEach((card, i) => {
        tx.cards.put(project, {
          ...card,
          status: closed.has(card.id) ? "done" : card.status,
          ...(i > 5 && i % 5 !== 0
            ? {
                depends_on_cards: [
                  ...new Set([
                    cards[(i * 7) % i].id,
                    cards[i - 1].id,
                    ...(i % 3 ? [cards[(i * 13) % i].id] : []),
                  ]),
                ],
              }
            : {}),
        });
        if (closed.has(card.id) && i % 4)
          append(tx, card.id, "card_merged", { sha: "0".repeat(40) });
      });
      const types = [
        "github_check_dispatch",
        "run_queued",
        "run_dispatched",
        "run_started",
        "branch_backup",
        "session_maintenance_changed",
      ];
      for (let i = 0; i < 63000; i++)
        append(tx, undefined, types[i % types.length], { ordinal: i });
      const items = new Map(tx.work_items.list(project).map((w) => [w.id, w]));
      for (const a of tx.assignments.list(project)) {
        const live =
          a.scope === "standing" ||
          !closed.has(items.get(a.work_item_id)?.card_id);
        tx.assignments.put(project, {
          ...a,
          status: live ? "active" : "released",
        });
      }
      for (const role of tx.roles.list(project))
        tx.roles.put(project, { ...role, allowed_tools });
    });
    const counts = store.uow.read((tx) => ({
      cards: tx.cards.list(project).length,
      events: tx.events
        .listStreams(project)
        .values()
        .reduce((sum, list) => sum + list.length, 0),
    }));
    const live = store.uow.read((tx) => tx.assignments.list(project));
    const items = store.uow.read((tx) => tx.work_items.list(project));
    const pm = live.find(
      (a) =>
        a.role_id === "pm" && a.scope === "standing" && a.status === "active",
    );
    const producer = live.find(
      (a) =>
        a.scope === "work_item" &&
        a.status === "active" &&
        items.some(
          (w) =>
            w.id === a.work_item_id &&
            w.assignment_id === a.id &&
            w.status !== "cancelled" &&
            ["produce", "verify"].includes(w.kind),
        ),
    );
    const token = (a) =>
      store.issueToken({
        project_id: project,
        assignment_id: a.id,
        role: { role_version: a.role_version, allowed_tools },
      }).token;
    const readers = [
      { name: "standing_pm", token: token(pm) },
      { name: "work_item", token: token(producer) },
    ];
    const phases = [];
    if (mode === "worker") {
      if (!existsSync(new URL("../dist/mcp-read-worker.js", import.meta.url)))
        throw new Error("Build apps/server before the worker mode");
      const { McpReader } = await import("../dist/mcp-reader.js");
      reader = new McpReader({ dbPath });
    }
    mcp = await startMcpServer({
      store,
      clock: { now: () => FIXTURE_NOW },
      ...(reader
        ? {
            readProjectSnapshot: (context, input) =>
              reader.projectSnapshot(context, input),
          }
        : {}),
      log: (entry) => {
        if (entry.event === "tool" && entry.tool === "project_snapshot")
          phases.push(entry.phases_ms);
      },
    });
    client = new Worker(new URL(import.meta.url), {
      workerData: { url: mcp.url },
    });
    const samples = [];
    const call = async (who, round) => {
      let lastBeat = performance.now();
      let timerMax = 0;
      heartbeat = setInterval(() => {
        const now = performance.now();
        timerMax = Math.max(timerMax, now - lastBeat);
        lastBeat = now;
      }, 5);
      await delay(20);
      histogram.reset();
      timerMax = 0;
      histogram.enable();
      const result = await new Promise((resolve, reject) => {
        client.once("message", resolve);
        client.once("error", reject);
        client.postMessage({ token: who.token });
      });
      await delay(20);
      histogram.disable();
      clearInterval(heartbeat);
      assert.ok(!result.error, result.error);
      const phase = phases.at(-1) ?? {};
      samples.push({
        reader: who.name,
        round,
        snapshot_rtt_ms: result.snapshot.rtt_ms,
        light_rtt_ms: result.light.rtt_ms,
        event_loop_max_ms: Math.max(histogram.max / 1e6, timerMax),
        handler_ms: phase.handler,
        read_worker_ms: phase.read_worker,
        read_roundtrip_ms: phase.read_roundtrip,
        serialize_ms: phase.serialize,
        response_bytes: result.snapshot.response_bytes,
        response_sha256: digest(result.snapshot.data.cards),
        cards: result.snapshot.data.cards.length,
      });
      console.error(JSON.stringify(samples.at(-1)));
    };
    for (let round = 0; round < rounds; round++)
      for (const who of readers) {
        if (round > 0 && round % 5 === 0 && who === readers[0])
          // A commit from another connection invalidates the cached state.
          store.uow.run((tx) => {
            const card = tx.cards.list(project).at(-1);
            tx.cards.put(project, { ...card, title: `Synthetic ${round}` });
            append(tx, card.id, "card_updated", {});
          });
        await call(who, round);
      }
    const summary = (name, key) => {
      const values = samples
        .filter((s) => s.reader === name && s.round > 0)
        .map((s) => s[key])
        .filter((v) => typeof v === "number")
        .sort((a, b) => a - b);
      if (!values.length) return null;
      return {
        n: values.length,
        p50: values[Math.floor((values.length - 1) * 0.5)],
        p95: values[Math.ceil((values.length - 1) * 0.95)],
        max: values.at(-1),
      };
    };
    const report = {
      mode,
      synthetic: true,
      counts,
      node: process.version,
      summary: Object.fromEntries(
        readers.map(({ name }) => [
          name,
          Object.fromEntries(
            [
              "snapshot_rtt_ms",
              "light_rtt_ms",
              "event_loop_max_ms",
              "read_worker_ms",
            ].map((key) => [key, summary(name, key)]),
          ),
        ]),
      ),
      samples,
    };
    await writeFile(`${output}.json`, JSON.stringify(report, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
    console.log(JSON.stringify(report.summary, null, 2));
  } finally {
    clearInterval(heartbeat);
    histogram.disable();
    await client?.terminate();
    await mcp?.close();
    await reader?.close();
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
}
