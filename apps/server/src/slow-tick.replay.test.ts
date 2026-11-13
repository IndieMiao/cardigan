/**
 * C-216: synthetic replay of the dispatcher "slow tick" (docs/research/
 * c216-slow-tick.md). Skipped unless CARDIGAN_TICK_REPLAY=1; it is a
 * measurement harness, not a regression gate. It seeds a project to production
 * scale, then drives dispatcher ticks while probing the Workbench card list and
 * MCP `get_updates`, and prints one JSON report (numbers only).
 *
 *   CARDIGAN_TICK_REPLAY=1 REPLAY_CARDS=200 pnpm --filter @cardigan/server \
 *     exec vitest run src/slow-tick.replay.test.ts --silent=false
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { postComment } from "@cardigan/domain";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, test } from "vitest";
import { call } from "../test-support/web.js";
import { Dispatcher } from "./dispatch.js";
import {
  acceptThroughMergeGate,
  m4Fixture,
  m4Scenario,
} from "./m4-fixtures.js";
import { startCardiganServer } from "./server.js";
import {
  type ProfileLine,
  setTickProfiler,
  TickProfiler,
} from "./tick-profile.js";
import { resolveWebConfig } from "./web/config.js";

const CARDS = Number(process.env.REPLAY_CARDS ?? 40);
const COMMENTS = Number(process.env.REPLAY_COMMENTS ?? 20);
const OPEN = Number(process.env.REPLAY_OPEN_CARDS ?? 10);
const TICKS = Number(process.env.REPLAY_TICKS ?? 5);
const PROBE_MS = 100;

test.skipIf(process.env.CARDIGAN_TICK_REPLAY !== "1")(
  "replay dispatcher ticks against production-sized synthetic data",
  async () => {
    const f = m4Fixture();
    const seeded = performance.now();
    let last: ReturnType<typeof m4Scenario> | undefined;
    for (let i = 0; i < CARDS; i++) {
      const s = m4Scenario(f);
      last = s;
      if (i < CARDS - OPEN)
        await acceptThroughMergeGate(f, s, i.toString(16).padStart(40, "a"));
      for (let c = 0; c < COMMENTS; c++)
        f.apply((st, a, p) =>
          postComment(st, a, { card_id: s.card.id, body: `c${c}` }, p),
        );
    }
    const st = f.state();
    const shape = {
      seed_ms: Math.round(performance.now() - seeded),
      cards: st.cards.length,
      events: st.events.length,
      timeline: st.timeline.length,
      runs: st.runs.length,
      notifications: f.store.listNotifications({ project_id: f.project_id })
        .length,
    };

    const lines: ProfileLine[] = [];
    const profiler = new TickProfiler({
      log: (line) => lines.push(line),
      reportIntervalMs: 0,
    });
    setTickProfiler(profiler);
    f.store.observe(profiler.storeObserver);
    const webDir = mkdtempSync(join(tmpdir(), "cardigan-replay-web-"));
    const server = await startCardiganServer({
      store: f.store,
      config: { dataDir: f.dataDir, host: "127.0.0.1", port: 0 },
      warn: () => undefined,
      log: (entry) => {
        if (entry.event === "http" && entry.duration_ms !== undefined)
          profiler.request("mcp", entry.duration_ms);
      },
      web: {
        config: resolveWebConfig(
          {},
          { port: 0, staticDir: webDir, loginFailureDelayMs: 0 },
        ),
        log: (event) => {
          if (
            event.event === "web_http" &&
            typeof event.duration_ms === "number"
          )
            profiler.request("web", event.duration_ms);
        },
      },
    });
    const webPort = server.web?.port ?? 0;
    f.store.setWebPassword("replay password");
    const login = await call(webPort, "/api/login", {
      method: "POST",
      body: JSON.stringify({ password: "replay password" }),
      headers: {
        "content-type": "application/json",
        origin: `http://127.0.0.1:${webPort}`,
      },
    });
    const cookie = String(login.headers["set-cookie"]).split(";")[0] ?? "";
    const token = f.store.issueToken({
      project_id: f.project_id,
      assignment_id: last?.coder.id as never,
      role: { role_version: 1, allowed_tools: ["get_updates"] },
    });
    const mcp = new Client({ name: "replay", version: "0.0.0" });
    await mcp.connect(
      new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: { Authorization: `Bearer ${token.token}` } },
      }),
    );

    // Client-side round trips: the server's own duration_ms starts only when
    // its callback runs, so it cannot see time queued behind a blocked loop.
    const ticks: Array<[number, number]> = [];
    const probe: Record<string, Array<[number, number]>> = { web: [], mcp: [] };
    // An open-loop client: each probe is due on a fixed cadence and its
    // latency counts from the due time, so time spent queued behind a
    // blocked event loop is included (an outside browser or Agent would wait
    // the same way). Overlapping a tick means [due, done] intersects it.
    const timed = async (
      channel: string,
      due: number,
      request: () => Promise<unknown>,
    ) => {
      await request();
      probe[channel]?.push([due, performance.now()]);
    };
    let probing = true;
    const probes = (async () => {
      let due = performance.now();
      while (probing) {
        await new Promise((r) =>
          setTimeout(r, Math.max(0, due - performance.now())),
        );
        await Promise.all([
          timed("web", due, () =>
            call(webPort, `/api/projects/${f.project_id}/cards`, { cookie }),
          ),
          timed("mcp", due, () =>
            mcp.callTool({
              name: "get_updates",
              arguments: { card_id: last?.card.id },
            }),
          ),
        ]);
        due += PROBE_MS;
        // Skip slots missed while blocked: one late request stands for them.
        if (due < performance.now()) due = performance.now();
      }
    })();
    const idle = () => new Promise((r) => setTimeout(r, 2_000));

    const runtime = {
      status: async () => ({
        ok: true as const,
        value: { process: "alive", agent: "idle", observed_seq: 1 },
      }),
      wake: async () => ({ ok: true as const, value: { sent: true } }),
      provision: async () => {
        throw new Error("unused");
      },
      release: async () => ({ ok: true as const, value: undefined }),
      interrupt: async () => ({ ok: true as const, value: undefined }),
      resume_or_replace: async () => {
        throw new Error("unused");
      },
      human_entry: async () => ({ ok: true as const, value: "fixture" }),
    };
    const dispatcher = new Dispatcher({
      store: f.store,
      runtime: runtime as never,
      clock: f.clock,
      snapshot: async () => ({ model: "m", agent_cli_version: "v" }),
      startRun: async () => {},
    });
    await idle();
    for (let i = 0; i < TICKS; i++) {
      const started = performance.now();
      await profiler.tick("dispatcher", () => dispatcher.tick());
      ticks.push([started, performance.now()]);
      // The production dispatcher loop sleeps its interval between ticks.
      await new Promise((r) => setTimeout(r, 1_000));
    }
    await idle();
    probing = false;
    await probes;
    profiler.report();
    await mcp.close();
    await server.close();
    profiler.stop();
    setTickProfiler(undefined);
    f.close();
    rmSync(webDir, { recursive: true, force: true });

    const pct = (values: number[]) => {
      const sorted = values.sort((a, b) => a - b);
      const at = (q: number) =>
        Math.round(
          sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ??
            0,
        );
      return sorted.length
        ? { n: sorted.length, p50_ms: at(0.5), p95_ms: at(0.95), max_ms: at(1) }
        : { n: 0 };
    };
    const latency = Object.fromEntries(
      Object.entries(probe).map(([channel, spans]) => {
        const overlaps = ([a, b]: [number, number]) =>
          ticks.some(([s, e]) => a < e && b > s);
        return [
          channel,
          {
            during_tick: pct(spans.filter(overlaps).map(([a, b]) => b - a)),
            idle: pct(spans.filter((x) => !overlaps(x)).map(([a, b]) => b - a)),
          },
        ];
      }),
    );
    const report = { shape, latency, lines };
    console.log(JSON.stringify(report, null, 1));
    if (process.env.REPLAY_OUT)
      writeFileSync(process.env.REPLAY_OUT, JSON.stringify(report, null, 1));
    expect(lines.some((l) => l.event === "tick_profile")).toBe(true);
  },
  3_600_000,
);
