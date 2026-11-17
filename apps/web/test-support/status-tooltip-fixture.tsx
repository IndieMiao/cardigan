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
const held = {
  ...card,
  title: "状态提示边界验证",
  why: `${"等待完整验收记录。".repeat(repeat)}原因末尾`,
  waiting_on: [],
  next_owners: [],
  hold: {
    reason: `${"等待完整验收记录。".repeat(repeat)}原因末尾`,
    resume_condition: `${"全部核对通过后恢复。".repeat(repeat)}恢复末尾`,
    set_by: "human",
    set_at: card.created_at,
  },
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
        cards: async () => ({
          cards: [held],
          counts: { total: 1, needs_me: 0, agent: 1 },
        }),
      })}
    />
  ),
);
