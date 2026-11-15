import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Actor,
  type CardId,
  type CommandEffect,
  type CommandPorts,
  type CommandState,
  postComment,
  type Result,
  remindSuggestionProgress,
  requestDecision,
  suggestionView,
} from "@cardigan/domain";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import { Store } from "@cardigan/store";
import { expect, test } from "vitest";
import {
  FIXTURE_NOW,
  FIXTURE_PROJECT,
  generateFixture,
} from "../test-support/synthetic-fixture.mjs";
import { readNeedsState } from "./web/needs-state.js";
import { readPagedCard } from "./web/timeline-state.js";

test("C-303: synthetic SQLite restart preserves baselines, cross-card evidence and notification windows", async () => {
  const root = await mkdtemp(join(tmpdir(), "suggestion-progress-"));
  const out = join(root, "data");
  let store: Store | undefined;
  try {
    // C-287 source: small profile, seed 303, 49 cards / 56 initial decisions.
    // Non-production scale. No real accounts, database, attachments or logs.
    const manifest = await generateFixture({
      out,
      profile: "small",
      seed: 303,
    });
    expect(manifest.counts.cards).toBe(49);
    const dbPath = join(out, "cardigan.db");
    store = Store.open({ dbPath });
    const human: Actor = { kind: "human", project_id: FIXTURE_PROJECT };
    let at = FIXTURE_NOW;
    const clock = { now: () => at };
    const command = <T>(
      reduce: (s: CommandState, p: CommandPorts) => Result<CommandEffect<T>>,
    ) => {
      if (!store) throw new Error("Missing fixture store");
      return store.uow.run((tx) => {
        const effect = unwrap(
          reduce(loadCommandState(tx, FIXTURE_PROJECT), { clock, ids: tx.ids }),
        );
        persistEffect(tx, FIXTURE_PROJECT, effect);
        return effect.data;
      });
    };
    const q = command((s, p) =>
      requestDecision(
        s,
        human,
        {
          card_id: "C-2" as CardId,
          affected_cards: ["C-2", "C-14", "C-14"] as CardId[],
          affected_work_items: [],
          kind: "choose",
          category: "permission",
          question: "核对新证据",
          context: "合成数据",
          decider: "human",
          blocking: false,
          options: [{ key: "yes", description: "继续", impact: "继续" }],
          recommended: "yes",
          suggestion: { option: "yes", rationale: "已核对原证据" },
          plain_summary: {
            changed: "核对合成证据",
            impact: "由人选择方案",
            risk: "无",
          },
        },
        p,
      ),
    );
    const comment = (card: string, body: string) =>
      command((s, p) =>
        postComment(s, human, { card_id: card as CardId, body }, p),
      );
    comment("C-2", "正常卡片的新证据");
    comment("C-14", "敏感正文不得出现在新进展中");
    const state = readNeedsState(store, FIXTURE_PROJECT);
    const current = state.decisions.find((d) => d.id === q.id);
    if (!current) throw new Error("Missing decision");
    const progress = suggestionView(state, current)?.progress;
    expect(progress?.count).toBe(2);
    expect(JSON.stringify(progress)).toContain("正常卡片的新证据");
    expect(JSON.stringify(progress)).not.toContain(
      "敏感正文不得出现在新进展中",
    );
    const paged = readPagedCard(
      store,
      FIXTURE_PROJECT,
      "C-2" as CardId,
      new URL("http://localhost/card?limit=1&type=system"),
      { now: at },
    );
    expect(
      paged?.decisions.find((d) => d.id === q.id)?.suggestion?.progress,
    ).toEqual(progress);
    const remind = () =>
      command((s, p) =>
        remindSuggestionProgress(
          s,
          { kind: "system", project_id: FIXTURE_PROJECT },
          p,
        ),
      );
    expect(remind()).toContain(q.id);
    comment("C-2", "窗口内的新证据");
    store.close();
    store = Store.open({ dbPath });
    at = new Date(Date.parse(FIXTURE_NOW) + 299_999).toISOString();
    expect(remind()).not.toContain(q.id);
    at = new Date(Date.parse(FIXTURE_NOW) + 300_000).toISOString();
    expect(remind()).toContain(q.id);
    expect(remind()).not.toContain(q.id);
  } finally {
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
