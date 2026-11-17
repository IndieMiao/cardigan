import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import { card, cardDetail, fakeClient } from "../src/testing/fixtures.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/components/ui/theme.css";

const date = "2026-11-17T09:00:00.000Z";
Date.now = () => Date.parse(date);
const check = {
  attempt_id: "synthetic-batch-1",
  completion_id: "D-103",
  candidate_sha: "b".repeat(40),
  tree_sha: "c".repeat(40),
  base_sha: "a".repeat(40),
  status: "failed",
  checks: [{ name: "test", status: "failed", exit_code: 1 }],
  summary: "合成夹具：检查失败",
  updated_at: date,
  level: "batch",
};
const members = [1, 2, 3].map((i) => ({
  card_id: `C-${100 + i}`,
  completion_id: `D-${100 + i}`,
  merge_sha: String(i).repeat(40),
  tree_sha: "c".repeat(40),
}));
const batch = {
  id: "MB-7",
  status: "resolved",
  culprit: "C-103",
  published_prefix: "MB-8",
  solo: false,
  base_sha: "a".repeat(40),
  final_sha: "3".repeat(40),
  final_tree_sha: "c".repeat(40),
  members,
  check,
};
const rows = [1, 2, 3, 4, 5].map((i) => ({
  ...card,
  id: `C-${100 + i}`,
  title: [
    "核对批次最终树",
    "检查成员取消和授权边界",
    "检查发布恢复",
    "等待共享文件合并窗口",
    "排队等候下一批",
  ][i - 1],
  status: "awaiting_merge",
  created_at: date,
  updated_at: date,
  merge_stage:
    i <= 3
      ? {
          stage: "bisecting",
          batch_id: "MB-7",
          peers: members.map((m) => m.card_id),
          color: 3,
          card_check: {
            ...check,
            status: "passed",
            checks: [{ name: "test", status: "passed", exit_code: 0 }],
            level: "card",
          },
          batch_check: check,
        }
      : i === 4
        ? { stage: "held_by_window", protecting_card_id: "C-101" }
        : { stage: "queued", position: 1 },
}));
const soloCards = new Set<string>();
const client = fakeClient({
  setMergeSolo: async (_project, id, solo) => {
    if (solo) soloCards.add(id);
    else soloCards.delete(id);
  },
  subscribe: (_p, c) => {
    c.status("live");
    return () => {};
  },
  cards: async () => ({
    cards: rows,
    counts: { total: 5, needs_me: 0, agent: 5 },
  }),
  card: async (_p, id) =>
    cardDetail({
      card: {
        ...rows.find((c) => c.id === id),
        merge_solo: soloCards.has(id),
        goal: "本地合成夹具 c391-review-v1，5 张卡，非生产数据。",
      },
      timeline: [],
      decisions: [],
    }),
  mergeBatch: async () => ({
    batch,
    probes: [
      {
        ...batch,
        id: "MB-8",
        status: "published",
        members: members.slice(0, 1),
        check: {
          ...check,
          status: "passed",
          checks: [{ name: "test", status: "passed", exit_code: 0 }],
        },
      },
      { ...batch, id: "MB-9", members: members.slice(0, 2) },
    ],
  }),
});
createRoot(document.getElementById("root")!).render(<App client={client} />);
