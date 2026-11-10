import { attentionCommand, type CliIo } from "@cardigan/cli";
import { type Decision, type Runtime, requestDecision } from "@cardigan/domain";
import { afterEach, expect, test, vi } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";
import { Dispatcher } from "./dispatch.js";
import { needsYou } from "./web/read.js";

afterEach(() => vi.useRealTimers());

test("a resolved review limit stuck past ten minutes raises durable attention once, visible in CLI and Workbench", async () => {
  const f = dispatchFixture();
  try {
    const { card } = f.create();
    const item = f
      .state()
      .work_items.find((w) => w.card_id === card.id && w.kind === "verify");
    if (!item) throw new Error("Missing verifier");
    const q = f.apply((state, actor, ports) =>
      requestDecision(
        state,
        actor,
        {
          card_id: card.id,
          kind: "choose",
          category: "general",
          question: "Review budget exhausted",
          context: "Legacy resolution did not raise the limit",
          options: [
            { key: "raise_limit", description: "Raise", impact: "Resume" },
          ],
          recommended: "raise_limit",
          affected_cards: [card.id],
          affected_work_items: [],
          blocking: true,
          decider: "human",
        },
        ports,
      ),
    );
    const resolved: Decision = {
      ...q,
      trigger: "review_limit",
      status: "resolved",
      affected_work_items: [item.id],
      resolution: {
        option: "raise_limit",
        rationale: "Continue",
        raw_quote: "Continue",
        resolved_by: "human",
        via: "needs_you",
        via_chain: ["human"],
        at: f.clock.now(),
      },
    };
    f.store.uow.run((tx) => {
      tx.decisions.put(f.project, resolved);
      tx.work_items.put(f.project, { ...item, status: "waiting_decision" });
    });
    const options = {
      store: f.store,
      clock: f.clock,
      runtime: { status: vi.fn(), wake: vi.fn() } as unknown as Runtime,
      snapshot: vi.fn(),
      startRun: vi.fn(),
    };
    f.advance(600000);
    await new Dispatcher(options).tick();
    expect(
      f.state().events.filter((e) => e.type === "review_limit_not_resumed"),
    ).toEqual([]);
    expect(needsYou(f.state(), f.clock.now()).attention).toEqual([]);
    f.advance(1);
    await new Dispatcher(options).tick();
    // A fresh dispatcher reuses the durable fact after restart.
    await new Dispatcher(options).tick();
    const events = f
      .state()
      .events.filter((e) => e.type === "review_limit_not_resumed");
    expect(events).toHaveLength(1);
    const notes = f.store
      .listNotifications({ project_id: f.project })
      .filter((n) => n.event_id === events[0]?.id);
    expect(notes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recipient: { kind: "needs_you" },
          status: "needs_attention",
        }),
        expect.objectContaining({
          recipient: { kind: "pm_ops" },
          status: "pending",
        }),
      ]),
    );
    expect(notes).toHaveLength(2);
    expect(needsYou(f.state(), f.clock.now()).attention).toEqual([
      expect.objectContaining({
        work_item_id: item.id,
        decision_id: q.id,
        waited_ms: 600001,
      }),
    ]);
    const output: string[] = [];
    const io: CliIo = {
      cwd: f.dataDir,
      env: { CARDIGAN_DATA_DIR: f.dataDir },
      platform: "linux",
      stdout: (text) => output.push(text),
      stderr: () => {},
      signals: { on() {}, off() {} },
      spawnInherit: () => {
        throw new Error("unused");
      },
      captureCommand: async () => {
        throw new Error("unused");
      },
    };
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(f.clock.now()));
    expect(attentionCommand([], io)).toBe(0);
    expect(output.join("\n")).toContain("review_limit_not_resumed");
    expect(output.join("\n")).toContain(item.id);
    expect(output.join("\n")).toContain(q.id);
    expect(options.startRun).not.toHaveBeenCalled();
    expect(f.state().runs).toEqual([]);
    f.store.uow.run((tx) =>
      tx.work_items.put(f.project, { ...item, status: "ready" }),
    );
    expect(needsYou(f.state(), f.clock.now()).attention).toEqual([]);
  } finally {
    f.close();
  }
});
