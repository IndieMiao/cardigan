import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import {
  type CommandEffect,
  type CommandPorts,
  type CommandState,
  markCardDone,
  type Result,
  refreshCardDependencies,
  updateCard,
} from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { expect, test } from "vitest";
import {
  card,
  fixture,
  human,
  id,
  now,
  value,
} from "../../domain/src/commands/test-fixtures.js";
import { loadCommandState, persistEffect } from "./commands/execute.js";

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "cg-dependencies-"));
  const store = Store.open({ dataDir });
  const project = human.project_id;
  store.createProject({ id: project });
  store.uow.run((tx) => {
    for (const role of fixture().roles) tx.roles.put(project, role);
    tx.cards.put(project, { ...card(), status: "backlog" });
    tx.cards.put(project, {
      ...card(2),
      status: "todo",
      template: "general",
      merge_policy: "none",
    });
  });
  return { dataDir, store, project };
}
const system = { kind: "system" as const, project_id: human.project_id };
const clock = { now: () => now };

test("legacy JSON and new dependency fields survive reconnect; release and notices replay exactly once", () => {
  const f = setup();
  let store = f.store;
  const apply = (
    fn: (s: CommandState, p: CommandPorts) => Result<CommandEffect<unknown>>,
  ) =>
    store.uow.run((tx) => {
      const effect = value(
        fn(loadCommandState(tx, f.project), { clock, ids: tx.ids }),
      );
      persistEffect(tx, f.project, effect);
      return effect;
    });
  try {
    expect(
      store.uow.read((tx) => tx.cards.get(f.project, id("card", 1)))
        ?.depends_on_cards,
    ).toBeUndefined();
    apply((s, p) =>
      updateCard(
        s,
        human,
        {
          card_id: id("card", 1),
          depends_on_cards: [id("card", 2)],
          wait_for_dependencies: true,
        },
        p,
      ),
    );
    expect(
      apply((s, p) => refreshCardDependencies(s, system, p)).changes,
    ).toEqual([]);
    apply((s, p) =>
      markCardDone(s, human, { card_id: id("card", 2), result: "Complete" }, p),
    );
    store.close();
    store = Store.open({ dataDir: f.dataDir });
    const released = apply((s, p) => refreshCardDependencies(s, system, p));
    expect(released.events.map((e) => e.type)).toEqual([
      "card_dependencies_released",
    ]);
    expect(released.timeline).toHaveLength(1);
    expect(
      apply((s, p) => refreshCardDependencies(s, system, p)).events,
    ).toEqual([]);
    store.close();
    store = Store.open({ dataDir: f.dataDir });
    expect(
      apply((s, p) => refreshCardDependencies(s, system, p)).events,
    ).toEqual([]);
    expect(
      store.uow.read((tx) => tx.cards.get(f.project, id("card", 1))),
    ).toMatchObject({
      status: "todo",
      depends_on_cards: ["C-2"],
      wait_for_dependencies: false,
    });
  } finally {
    store.close();
    rmSync(f.dataDir, { recursive: true, force: true });
  }
});

test("two simultaneous opposing edge writes serialize under SQLite and cannot commit a cycle", async () => {
  const f = setup();
  const workers: Worker[] = [];
  try {
    const source = `
      (async () => {
        const { parentPort, workerData: d } = await import('node:worker_threads');
        const { Store } = await import(d.store);
        const { updateCard } = await import(d.domain);
        const { loadCommandState, persistEffect } = await import(d.mcp);
        const store = Store.open({ dataDir: d.dataDir });
        parentPort.postMessage({ ready: true });
        parentPort.once('message', () => {
          try {
            const result = store.uow.run(tx => {
              const result = updateCard(loadCommandState(tx, d.project), { kind: 'human', project_id: d.project }, { card_id: d.from, depends_on_cards: [d.to] }, { ids: tx.ids, clock: { now: () => d.now } });
              if (result.ok) persistEffect(tx, d.project, result.value);
              return result.ok ? { ok: true } : { ok: false, message: result.error.message };
            });
            parentPort.postMessage(result);
          } finally { store.close(); }
        });
      })().catch(error => { throw error; });`;
    const results = [
      ["C-1", "C-2"],
      ["C-2", "C-1"],
    ].map(([from, to]) => {
      const worker = new Worker(source, {
        eval: true,
        workerData: {
          dataDir: f.dataDir,
          project: f.project,
          from,
          to,
          now,
          store: new URL("../../store/dist/index.js", import.meta.url).href,
          domain: new URL("../../domain/dist/index.js", import.meta.url).href,
          mcp: new URL("../dist/index.js", import.meta.url).href,
        },
      });
      workers.push(worker);
      return {
        ready: new Promise<void>((resolve, reject) => {
          worker.once("message", () => resolve());
          worker.once("error", reject);
        }),
        done: new Promise<{ ok: boolean; message?: string }>(
          (resolve, reject) => {
            worker.on("message", (message) => {
              if (!message.ready) resolve(message);
            });
            worker.once("error", reject);
          },
        ),
      };
    });
    await Promise.all(results.map((r) => r.ready));
    for (const worker of workers) worker.postMessage("go");
    const replies = await Promise.all(results.map((r) => r.done));
    expect(replies.filter((r) => r.ok)).toHaveLength(1);
    expect(replies.find((r) => !r.ok)?.message).toContain("依赖成环");
    expect(
      f.store.uow
        .read((tx) => tx.cards.list(f.project))
        .filter((c) => c.depends_on_cards?.length),
    ).toHaveLength(1);
  } finally {
    await Promise.all(workers.map((w) => w.terminate()));
    f.store.close();
    rmSync(f.dataDir, { recursive: true, force: true });
  }
});
