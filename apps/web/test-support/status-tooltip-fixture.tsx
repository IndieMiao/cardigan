import { type Card, deriveCardFields } from "@cardigan/domain";
import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import { CardHoldTip, CardStatusTip } from "../src/components/CardStatusTip.js";
import { card, fakeClient } from "../src/testing/fixtures.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/components/ui/theme.css";

const params = new URLSearchParams(location.search);
const repeat = Number(params.get("repeat") ?? 60);
const heldCard: Card = {
  id: card.id as Card["id"],
  project_id: "p-1",
  title: "状态提示边界验证",
  goal: card.goal,
  acceptance_criteria: [],
  priority: 1,
  status: "in_progress",
  created_at: card.created_at,
  source: { kind: "quote", text: "合成状态提示边界" },
  out_of_scope: [],
  related_cards: [],
  template: "dev",
  created_by: "human",
  hold: {
    reason: `${"等待完整验收记录。".repeat(repeat)}原因末尾`,
    resume_condition: `${"全部核对通过后恢复。".repeat(repeat)}恢复末尾`,
    set_by: "human",
    set_at: card.created_at,
  },
};
const held = {
  ...card,
  ...heldCard,
  ...deriveCardFields({
    card: heldCard,
    work_items: [],
    deliveries: [],
    reviews: [],
    decisions: [],
    human_actions: [],
  }),
};
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
  params.get("view") === "isolated" ? (
    <main className="ui-workspace">
      <h1>状态提示边界验证</h1>
      <CardHoldTip card={held} />
      <CardStatusTip card={held} />
    </main>
  ) : (
    <App
      client={fakeClient({
        subscribe: (_project, callbacks) => {
          callbacks.status("live");
          return () => {};
        },
        cards: async () => ({
          cards: [held],
          counts: { total: 1, needs_me: 0, agent: 1 },
        }),
      })}
    />
  ),
);
