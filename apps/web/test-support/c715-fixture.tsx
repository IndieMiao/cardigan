import type {
  StoryQuestionGroup,
  StoryReply,
  TimelineEntryId,
} from "@cardigan/domain";
import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import { ApiError, type CardDetail } from "../src/api.js";
import type { StreamCallbacks } from "../src/stream.js";
import {
  card,
  cardDetail,
  fakeClient,
  NOW,
  timelineEntry,
} from "../src/testing/fixtures.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/components/ui/theme.css";

// C-715 evidence only: a story card with one checklist of four questions, the
// first answered earlier on its own. The first whole-checklist submission
// fails like a dropped connection when the page URL has `?fail=1`; the retry
// succeeds and the next read shows the server's resolutions. No network
// client, database or production data.
Date.now = () => Date.parse(NOW);
const id = (n: number) => `C-1#${n}` as TimelineEntryId;
type Question = StoryQuestionGroup["questions"][number];
const questions: Question[] = [
  {
    question: "合成问题 1：地块美术按哪种规范出图？",
    recommended: "沿用 64×64 网格",
    impact: "已有素材不用重切",
    resolution: { source: "answer", value: "改用 128×128", entry_id: id(4) },
  },
  {
    question: "合成问题 2：季节变体是否共用轮廓？",
    recommended: "共用轮廓，只换色板",
    impact: "美术工作量减半",
  },
  {
    question: "合成问题 3：阴影朝向？",
    recommended: "统一朝右下",
    impact: "与现有建筑一致",
  },
  {
    question: "合成问题 4：首批交付几张地块？",
    recommended: "12 张",
    impact: "覆盖两个季节的样例",
  },
];
const group = { id: id(3), questions } as StoryQuestionGroup;
let seq = 4;
let failNext = new URLSearchParams(location.search).has("fail");
const extra: CardDetail["timeline"] = [];
function detail(): CardDetail {
  return cardDetail({
    card: {
      ...card,
      title: "合成需求卡：动态地图与地块美术",
      story: { discussion_rounds: 1, question_groups: [group] },
    },
    timeline: [
      ...extra,
      timelineEntry({
        id: id(4),
        event_seq: 4,
        body: `回答问题\n\n${id(3)} 第 1 题：改用 128×128`,
        author: "human",
        author_display: "合成用户",
      }),
      timelineEntry({
        id: id(3),
        event_seq: 3,
        body: "问题清单（合成）",
        author: "assignment:A-2",
        author_display: "合成 PM",
      }),
    ],
    counts: {
      timeline: 4 + extra.length,
      deliveries: 1,
      reviews: 0,
      open_decisions: 0,
    },
  });
}
const listeners = new Set<StreamCallbacks>();
const state = { reads: 0, pending: 0, writes: [] as unknown[] };
const settle = (number: number, resolution: Question["resolution"]) => {
  const q = questions[number - 1];
  if (q && !q.resolution) questions[number - 1] = { ...q, resolution };
};
const client = fakeClient({
  subscribe: (_project, callbacks) => {
    listeners.add(callbacks);
    callbacks.status("live");
    callbacks.ready();
    return () => listeners.delete(callbacks);
  },
  card: async () => {
    state.pending += 1;
    await new Promise((resolve) => setTimeout(resolve, 120));
    state.pending -= 1;
    state.reads += 1;
    return detail();
  },
  addComment: async (_project, _card, input) => {
    const reply = (input as { story_discussion?: StoryReply }).story_discussion;
    state.writes.push(reply);
    await new Promise((resolve) => setTimeout(resolve, 120));
    if (failNext) {
      failNext = false;
      throw new ApiError(503, "unavailable", "连接中断（合成）");
    }
    seq += 1;
    const entry_id = id(seq);
    const lines: string[] = [];
    if (reply?.action === "answer") {
      settle(reply.number, { source: "answer", value: reply.answer, entry_id });
    } else if (reply) {
      const answers = new Map(
        reply.action === "submit_answers"
          ? reply.answers.map((a) => [a.number, a.answer])
          : [],
      );
      questions.forEach((q, i) => {
        if (q.resolution) return;
        const answer = answers.get(i + 1);
        lines.push(
          answer === undefined
            ? `${group.id} 第 ${i + 1} 题按默认：${q.recommended}`
            : `${group.id} 第 ${i + 1} 题：${answer}`,
        );
        settle(
          i + 1,
          answer === undefined
            ? { source: "accepted_default", value: q.recommended, entry_id }
            : { source: "answer", value: answer, entry_id },
        );
      });
    }
    extra.unshift(
      timelineEntry({
        id: entry_id,
        event_seq: seq,
        body: [input.body, ...lines].join("\n\n"),
        author: "human",
        author_display: "合成用户",
      }),
    );
    for (const listener of listeners)
      listener.change({ stream: "C-1", seq, type: "comment_posted" });
    return { id: entry_id };
  },
});
Object.assign(window, { __c715: { state } });
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<App client={client} />);
