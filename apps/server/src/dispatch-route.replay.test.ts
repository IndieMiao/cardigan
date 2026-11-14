/**
 * C-244: synthetic replay of the dispatcher `route` steps at production shape
 * (docs/research/c216-slow-tick.md §9). Skipped unless CARDIGAN_ROUTE_REPLAY=1;
 * it is a measurement harness, not a regression gate. Unlike
 * slow-tick.replay.test.ts it does not start a server or probe requests: it
 * seeds the history that the C-216 replay lacks (hundreds of released
 * Assignments, resolved decisions raised by Agents, tens of thousands of
 * events), then ticks the dispatcher and prints the tick_profile lines.
 *
 *   CARDIGAN_ROUTE_REPLAY=1 ROUTE_REPLAY_CARDS=240 pnpm --filter @cardigan/server \
 *     exec vitest run src/dispatch-route.replay.test.ts --silent=false
 *
 * Do not also set CARDIGAN_TICK_PROFILE=1 (see slow-tick.replay.test.ts).
 */
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import {
  type Assignment,
  type Clock,
  type Decision,
  postComment,
  releaseAssignment,
  requestDecision,
} from "@cardigan/domain";
import { expect, test } from "vitest";
import { standingResolver } from "./assembly.js";
import { Dispatcher } from "./dispatch.js";
import {
  acceptThroughMergeGate,
  m4Fixture,
  m4Scenario,
} from "./m4-fixtures.js";
import {
  type ProfileLine,
  setTickProfiler,
  TickProfiler,
} from "./tick-profile.js";

const CARDS = Number(process.env.ROUTE_REPLAY_CARDS ?? 40);
const OPEN = Number(process.env.ROUTE_REPLAY_OPEN_CARDS ?? 18);
const COMMENTS = Number(process.env.ROUTE_REPLAY_COMMENTS ?? 60);
const TICKS = Number(process.env.ROUTE_REPLAY_TICKS ?? 6);
const TOKENS_PER_RUN = Number(process.env.ROUTE_REPLAY_TOKENS_PER_RUN ?? 2);

const PLAIN = { changed: "回放", impact: "回放", risk: "无" };

test.skipIf(process.env.CARDIGAN_ROUTE_REPLAY !== "1")(
  "replay dispatcher route steps against production-shaped history",
  async () => {
    let now = Date.parse("2030-01-01T00:00:00.000Z");
    const clock: Clock = { now: () => new Date(now).toISOString() };
    const f = m4Fixture({ clock });
    const seeded = performance.now();
    // Production has an active PM Ops and PM Office whose Runs are often busy,
    // so their pending bells wait; standing owners resolve through tokens.
    const first = m4Scenario(f);
    const standing = (["ops", "office"] as const).map((mode, i) => {
      const { work_item_id: _w, ...base } = first.pmAcceptance;
      const pm: Assignment = {
        ...base,
        id: `A-90${i}` as Assignment["id"],
        scope: "standing",
        role_id: "pm",
        standing_mode: mode,
      };
      f.store.uow.run((tx) => tx.assignments.put(f.project_id, pm));
      f.startRun(pm);
      return pm;
    });
    for (let i = 0; i < CARDS; i++) {
      const s = i === 0 ? first : m4Scenario(f);
      const closed = i < CARDS - OPEN;
      // Every card carries one Agent-raised decision, resolved by the human.
      f.startRun(s.coder);
      const decision = f.apply(
        (st, a, p) =>
          requestDecision(
            st,
            a,
            {
              card_id: s.card.id,
              category: "general",
              kind: "choose",
              question: "继续？",
              context: "回放",
              options: [{ key: "go", description: "继续", impact: "继续" }],
              recommended: "go",
              affected_cards: [s.card.id],
              affected_work_items: [],
              blocking: false,
              decider: "human",
              plain_summary: PLAIN,
            },
            p,
          ),
        f.actorFor(s.coder),
      ) as Decision;
      f.endRun(s.coder);
      now += 1_000;
      f.decide(decision, "go");
      // Half record the implementation (a human comment citing the decision),
      // half will be reminded on the first tick.
      if (i % 2 === 0)
        f.apply((st, a, p) =>
          postComment(
            st,
            a,
            {
              card_id: s.card.id,
              body: `${decision.id} 已执行`,
              refs: [{ kind: "decision", id: decision.id }],
            },
            p,
          ),
        );
      if (closed)
        await acceptThroughMergeGate(f, s, i.toString(16).padStart(40, "a"));
      for (let c = 0; c < COMMENTS; c++)
        f.apply((st, a, p) =>
          postComment(st, a, { card_id: s.card.id, body: `c${c}` }, p),
        );
      if (closed)
        for (const a of [s.coder, s.reviewer, s.pmAcceptance])
          f.apply((st, actor, p) =>
            releaseAssignment(st, actor, { assignment_id: a.id }, p),
          );
      now += 60_000;
    }
    // Each Run start issues Agent tokens; the tokens table only grows.
    for (const run of f.state().runs)
      for (let t = 0; t < TOKENS_PER_RUN; t++)
        f.store.issueToken({
          project_id: f.project_id,
          assignment_id: run.assignment_id,
          role: { role_version: 1, allowed_tools: ["get_updates"] },
        });
    const st = f.state();
    const shape = {
      seed_ms: Math.round(performance.now() - seeded),
      cards: st.cards.length,
      events: st.events.length,
      timeline: st.timeline.length,
      runs: st.runs.length,
      decisions: st.decisions.length,
      assignments: st.assignments.length,
      released: st.assignments.filter((a) => a.status === "released").length,
      standing: standing.length,
      tokens: st.runs.length * TOKENS_PER_RUN,
    };
    // Every decision is now older than the 30-minute reminder threshold.
    now += 2 * 60 * 60_000;

    const lines: ProfileLine[] = [];
    const profiler = new TickProfiler({
      log: (line) => lines.push(line),
      reportIntervalMs: 0,
    });
    setTickProfiler(profiler);
    f.store.observe(profiler.storeObserver);
    const runtime = {
      status: async () => ({
        ok: true as const,
        value: { process: "alive", agent: "idle", observed_seq: 1 },
      }),
      wake: async () => ({ ok: true as const, value: { sent: true } }),
      release: async () => ({ ok: true as const, value: undefined }),
      interrupt: async () => ({ ok: true as const, value: undefined }),
      human_entry: async () => ({ ok: true as const, value: "fixture" }),
    };
    const dispatcher = new Dispatcher({
      store: f.store,
      runtime: runtime as never,
      clock,
      standing: standingResolver(f.store),
      snapshot: async () => ({ model: "m", agent_cli_version: "v" }),
      startRun: async () => {},
    });
    const { Session } = await import("node:inspector/promises");
    const inspector = process.env.ROUTE_REPLAY_PROFILE
      ? new Session()
      : undefined;
    const walls: number[] = [];
    for (let i = 0; i < TICKS; i++) {
      // Profile steady-state ticks only; the first tick routes the backlog.
      if (inspector && i === 1) {
        inspector.connect();
        await inspector.post("Profiler.enable");
        await inspector.post("Profiler.start");
      }
      const started = performance.now();
      await profiler.tick("dispatcher", () => dispatcher.tick());
      walls.push(performance.now() - started);
      now += 1_000;
    }
    if (inspector) {
      const { profile } = await inspector.post("Profiler.stop");
      writeFileSync(
        String(process.env.ROUTE_REPLAY_PROFILE),
        JSON.stringify(profile),
      );
      inspector.disconnect();
    }
    profiler.stop();
    setTickProfiler(undefined);
    f.close();
    const steady = walls.slice(1).sort((a, b) => a - b);
    const report = {
      shape,
      wall_ms: walls.map(Math.round),
      steady_mean_ms: Math.round(
        steady.reduce((s, x) => s + x, 0) / Math.max(1, steady.length),
      ),
      steady_p90_ms: Math.round(
        steady[Math.min(steady.length - 1, Math.floor(0.9 * steady.length))] ??
          0,
      ),
      lines: lines.filter((l) => l.event === "tick_profile"),
    };
    console.log(JSON.stringify(report, null, 1));
    if (process.env.ROUTE_REPLAY_OUT)
      writeFileSync(
        process.env.ROUTE_REPLAY_OUT,
        JSON.stringify(report, null, 1),
      );
    expect(report.lines.length).toBe(TICKS);
  },
  3_600_000,
);
