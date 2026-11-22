import type {
  StoryQuestionGroup,
  StoryReply,
  TimelineEntryId,
} from "@cardigan/domain";
import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import type { CardDetail } from "../src/api.js";
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

// C-581 evidence only: a story card whose URL still points at an earlier
// comment (entry-C-1#8) while a question group with six questions waits for
// answers. Reads take 120 ms like a real request; `window.__c581.live()` emits
// a live change the way SSE does. No network client, database or production data.
Date.now = () => Date.parse(NOW);
const id = (n: number) => `C-1#${n}` as TimelineEntryId;
const group: StoryQuestionGroup = {
  id: id(9),
  questions: [1, 2, 3, 4, 5, 6].map((n) => ({
    question: `合成问题 ${n}：地块美术按哪种规范出图？`,
    recommended: `推荐方案 ${n}`,
    impact: `影响范围 ${n}`,
  })),
};
const paragraph =
  "动态地图与地块美术规范说明（合成样例）：地块按 64×64 网格切图，边缘留 2px 出血，阴影统一朝右下；季节变体共用同一套轮廓，只替换色板。";
let seq = 9;
const extra: CardDetail["timeline"] = [];
const older = [1, 2, 3, 4, 5, 6, 7].map((n) =>
  timelineEntry({
    id: id(n),
    event_seq: n,
    body: `较早的合成评论 ${n}。${paragraph}`,
    author_display: "合成成员",
  }),
);
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
        id: id(9),
        event_seq: 9,
        body: "问题清单：请逐题回答，或整组按默认。",
        author: "assignment:A-2",
        author_display: "合成 PM",
      }),
      timelineEntry({
        id: id(8),
        event_seq: 8,
        body: Array.from({ length: 6 }, () => paragraph).join("\n\n"),
        author: "human",
        author_display: "合成用户",
      }),
      ...older,
    ],
    counts: {
      timeline: 9 + extra.length,
      deliveries: 1,
      reviews: 0,
      open_decisions: 0,
    },
  });
}
const listeners = new Set<StreamCallbacks>();
const state = { reads: 0, pending: 0 };
const live = (type = "comment_posted") => {
  seq += 1;
  for (const listener of listeners)
    listener.change({ stream: "C-1", seq, type });
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
    if (reply?.action === "answer") {
      const question = group.questions[reply.number - 1];
      if (question)
        Object.assign(question, {
          resolution: { source: "answer", value: reply.answer },
        });
    } else if (reply?.action === "accept_defaults") {
      for (const question of group.questions)
        if (!question.resolution)
          Object.assign(question, {
            resolution: {
              source: "accepted_default",
              value: question.recommended,
            },
          });
    }
    seq += 1;
    extra.unshift(
      timelineEntry({
        id: id(seq),
        event_seq: seq,
        body: input.body,
        author: "human",
        author_display: "合成用户",
      }),
    );
    live();
    return { id: id(seq) };
  },
});
/** Another member's comment arriving over the live stream. */
const arrive = () => {
  seq += 1;
  extra.unshift(
    timelineEntry({
      id: id(seq),
      event_seq: seq,
      body: "其他成员的新动态（合成）。",
      author_display: "合成成员",
    }),
  );
  live();
};
Object.assign(window, { __c581: { state, arrive } });
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<App client={client} />);
