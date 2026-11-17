import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import { ApiError, type CardiganClient, type NeedsPage } from "../src/api.js";
import { cardDetail, fakeClient, NOW } from "../src/testing/fixtures.js";
import {
  fixtureNeedsCounts,
  fixtureNeedsSection,
} from "../src/testing/needs-fixture.js";
import { sourceMergeFixture } from "../src/testing/source-merge-fixture.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "../src/styles.css";

let q = sourceMergeFixture();
q.related_cards = [
  {
    id: "C-1",
    title: `合成示例：只调整状态标签，来源账号拍板与本次合并无关 ${"LongTitle".repeat(8)}`,
  },
];
const mode = new URLSearchParams(location.search).get("mode");
if (mode === "stale")
  q = {
    ...q,
    source_unrelated_suggestion: {
      ...q.source_unrelated_suggestion,
      stale: true,
    },
  };
const second = {
  ...sourceMergeFixture(),
  id: "Q-4",
  card_id: "C-2",
  related_cards: [{ id: "C-2", title: "第二张合成卡片" }],
  source_unrelated_suggestion: {
    ...sourceMergeFixture().source_unrelated_suggestion,
    card_id: "C-2",
    source_decision_id: "Q-3",
  },
};
const page = (): NeedsPage => ({
  decisions: mode === "empty" ? [] : mode === "multi" ? [q, second] : [q],
  pm_held_merges: [],
  human_actions: [],
  incidents: [],
  later: [],
  notices: [],
  counts: { total_pending: mode === "empty" ? 0 : 1, notices_unread: 0 },
});
const fixture = { calls: [] as unknown[], finish: (_success: boolean) => {} };
const client: CardiganClient = fakeClient({
  needsYou: async () => page(),
  needsYouCounts: async () => fixtureNeedsCounts(page()),
  needsYouSection: async (_project, section) =>
    fixtureNeedsSection(page(), section),
  card: async () =>
    cardDetail({
      card: {
        ...cardDetail().card,
        status: "awaiting_merge",
        title: q.related_cards[0]?.title ?? "合成",
      },
      merge_confirmations: [q],
    }),
  confirmSourceUnrelated: (...args) =>
    new Promise<void>((resolve, reject) => {
      fixture.calls.push(args);
      fixture.finish = (success) => {
        if (!success) {
          reject(
            new ApiError(
              409,
              "stale_target",
              "来源无关建议已失效，请刷新并请 PM 重新核对",
            ),
          );
          return;
        }
        q = {
          ...q,
          source_unrelated_suggestion: {
            ...q.source_unrelated_suggestion,
            confirmed: {
              by: "human",
              at: NOW,
              event_id: "synthetic-human-confirmation",
            },
          },
        };
        resolve();
      };
    }),
});
Object.assign(window, { sourceFixture: fixture });
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<App client={client} />);
