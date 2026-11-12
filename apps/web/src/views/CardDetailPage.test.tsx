// @vitest-environment jsdom
/**
 * M5.3 card page (plan §4 M5.3; development plan §8.4).
 *
 * The header must answer the five questions before the timeline, work items must
 * be collapsible, the 关联区 must show ids with their status, timeline entries
 * must be visually typed, numbers must only link through the server's `refs`,
 * and Agent-written bodies must not execute anything.
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { ApiError } from "../api.js";
import { CommentBox } from "../components/CommentBox.js";
import {
  attachment,
  cardDetail,
  fakeClient,
  timelineEntry,
} from "../testing/fixtures.js";
import { CardDetailPage } from "./CardDetailPage.js";

afterEach(cleanup);

test.each([false, true, undefined])(
  "C-90 comment recipient hint follows project Ops availability (%s)",
  async (hasPmOps) => {
    renderCard({
      card: async () =>
        cardDetail(hasPmOps === undefined ? {} : { has_pm_ops: hasPmOps }),
    });
    const input = await screen.findByRole("textbox", { name: "评论正文" });
    const editor = screen.getByRole("region", { name: "写评论" });
    const hint = within(editor).queryByText("这张卡目前没有人负责");
    expect(Boolean(hint)).toBe(hasPmOps === false);
    expect(input.getAttribute("aria-describedby")).toBe(hint?.id ?? null);
    fireEvent.change(input, { target: { value: "仍然可以留言" } });
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "发表评论" })
        .disabled,
    ).toBe(false);
  },
);

test("C-90 the hint updates when Ops becomes available without losing a comment draft", async () => {
  const client = fakeClient();
  const view = render(
    <CommentBox
      client={client}
      projectId="p-1"
      cardId="C-1"
      hasPmOps={false}
    />,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "评论正文" }), {
    target: { value: "未发送的评论" },
  });
  view.rerender(
    <CommentBox client={client} projectId="p-1" cardId="C-1" hasPmOps />,
  );
  expect(screen.queryByText("这张卡目前没有人负责")).toBeNull();
  expect(
    screen.getByRole<HTMLTextAreaElement>("textbox", { name: "评论正文" })
      .value,
  ).toBe("未发送的评论");
});

function renderCard(
  client: Parameters<typeof fakeClient>[0] = {},
  cardId = "C-1",
  inDrawer = false,
) {
  return render(
    <CardDetailPage
      client={fakeClient(client)}
      projectId="p-1"
      cardId={cardId}
      inDrawer={inDrawer}
    />,
  );
}

test.each(
  (["done", "cancelled"] as const).flatMap((status) =>
    [false, true].map((inDrawer) => ({ status, inDrawer })),
  ),
)(
  "P2a-5: $status detail links to the replacement card outside the sticky identity (drawer=$inDrawer)",
  async ({ status, inDrawer }) => {
    const detail = cardDetail();
    renderCard(
      {
        card: async () => ({
          ...detail,
          card: {
            ...detail.card,
            status,
            resolution: "superseded",
            superseded_by: "C-2",
            related_cards: ["C-99", "C-2"],
          },
        }),
      },
      "C-1",
      inDrawer,
    );
    const link = await screen.findByRole("link", { name: "已被 C-2 取代" });
    expect(link.closest(".card-header")).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "卡片区块导航" });
    expect(nav.querySelector(".card-nav-id")?.textContent).toBe(
      inDrawer ? undefined : "C-1",
    );
    expect(nav.querySelector(".card-nav-title")?.textContent).toBe(
      inDrawer ? undefined : detail.card.title,
    );
    expect(nav.querySelector(".card-nav-title")?.getAttribute("title")).toBe(
      inDrawer ? undefined : detail.card.title,
    );
    expect(within(nav).queryByText(/已被.*取代/)).toBeNull();
    expect(link.getAttribute("href")).toBe("#/p/p-1/cards/C-2");
    expect(screen.queryByText("已被 C-99 取代")).toBeNull();
  },
);

test("P2a-5: legacy superseded cards without a replacement do not infer it from related cards", async () => {
  const detail = cardDetail();
  renderCard({
    card: async () => ({
      ...detail,
      card: {
        ...detail.card,
        resolution: "superseded",
        related_cards: ["C-99"],
      },
    }),
  });
  expect(await screen.findByText("已被取代")).toBeTruthy();
  expect(screen.queryByRole("link", { name: /已被.*取代/ })).toBeNull();
});

test("shows a loading state while the card is on its way", () => {
  renderCard({ card: () => new Promise(() => undefined) });
  expect(screen.getByRole("status").textContent).toBe("");
});

test("a missing card explains itself and offers the way back", async () => {
  renderCard({
    card: async () => {
      throw new ApiError(404, "not_found", "card C-9 not found");
    },
  });
  expect(
    await screen.findByText("找不到卡片 C-1。请核对编号或返回卡片。"),
  ).toBeTruthy();
  expect(
    screen.getByRole("link", { name: "返回到卡片" }).getAttribute("href"),
  ).toBe("#/p/p-1/cards");
});

test("a failed load shows the message and retries", async () => {
  let attempt = 0;
  renderCard({
    card: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("boom");
      return cardDetail();
    },
  });
  expect((await screen.findByRole("alert")).textContent).toContain("boom");
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  expect(await screen.findByRole("heading", { level: 1 })).toBeTruthy();
});

test("the main column and sidebar answer the five questions", async () => {
  renderCard();
  const page = await screen.findByRole("article", { name: "卡片 C-1" });
  const header = within(page).getByRole("heading", { level: 1 });
  expect(header.textContent).toContain("准备发布");

  const questions = [
    ["进行到哪一步", "工作项 0/2 完成"],
    ["下一步该谁做", "未命名的 reviewer"],
    ["被什么阻塞", "等你拍板 D-1"],
  ] as const;
  for (const [question, answer] of questions) {
    const term = within(page).getByText(question);
    const value = term.parentElement?.querySelector("dd");
    expect(value?.textContent ?? "", question).toContain(answer);
  }
  expect(
    within(page).getByRole("region", { name: "目标和验收标准" }).textContent,
  ).toContain("把 0.1 发出去");
  expect(page.textContent).toContain("测试通过");
  expect(
    within(page).getByRole("region", { name: "验收责任" }).textContent,
  ).toContain("reviewer：还没有结论，依据 没有阻塞问题");
  expect(within(page).getByRole("link", { name: "V-1 交付" })).toBeTruthy();
});

test("work items are collapsible and show owner, status and delivery", async () => {
  renderCard();
  await screen.findByRole("article", { name: "卡片 C-1" });
  const details = screen.getByText("工作项（0/2 完成）").closest("details");
  expect(details).not.toBeNull();
  expect((details as HTMLDetailsElement).open).toBe(true);
  expect(details?.textContent).toContain("写迁移脚本");
  expect(details?.textContent).toContain("已交付");
  expect(details?.textContent).toContain("A-1 coder");
  expect(details?.textContent).toContain("V-1 交付 待审核");
  expect(details?.textContent).toContain("代码审核");
  expect(details?.textContent).toContain("reviewer");
});

test("the relations section shows ids with their status", async () => {
  const detail = cardDetail({
    relations: {
      decisions: [
        {
          id: "D-1",
          question: "要不要先跑冒烟？",
          status: "open",
          blocking: true,
          decider: "human",
        },
      ],
      cards: [{ id: "C-2", title: "冒烟测试", status: "todo" }],
      pull_requests: [
        {
          delivery_id: "V-1",
          work_item_id: "W-1",
          status: "accepted",
          pr_url: "https://example.com/pr/7",
        },
      ],
    },
  });
  renderCard({ card: async () => detail });
  const relations = await screen.findByRole("region", { name: "关联" });
  const decisions = screen.getByRole("region", { name: "拍板" });
  expect(decisions.textContent).toContain("D-1");
  expect(decisions.textContent).toContain("待拍板");
  expect(decisions.textContent).toContain("阻塞中");
  const decision = within(decisions).getByRole("link", { name: /^D-1 / });
  expect(decision.getAttribute("href")).toBe(
    "#/p/p-1/cards/C-1?at=decision-D-1",
  );
  const related = within(relations).getByRole("link", { name: /^C-2 / });
  expect(related.getAttribute("href")).toBe("#/p/p-1/cards/C-2");
  const pull = within(relations).getByRole("link", {
    name: "https://example.com/pr/7",
  });
  expect(pull.getAttribute("rel")).toBe("noopener noreferrer");
  expect(pull.getAttribute("target")).toBe("_blank");
});

test("a pull request URL is only a link when its scheme is allowed", async () => {
  const detail = cardDetail({
    relations: {
      decisions: [],
      cards: [],
      pull_requests: [
        {
          delivery_id: "V-1",
          work_item_id: "W-1",
          status: "submitted",
          pr_url: "javascript:alert(1)",
        },
        {
          delivery_id: "V-2",
          work_item_id: "W-1",
          status: "submitted",
          pr_url: "data:text/html,<script>alert(2)</script>",
        },
        {
          delivery_id: "V-3",
          work_item_id: "W-1",
          status: "submitted",
          pr_url: "https://example.com/pr/9",
        },
      ],
    },
  });
  renderCard({ card: async () => detail });
  const relations = await screen.findByRole("region", { name: "关联" });

  // Agent-supplied schemes are text, not links, whatever React would allow.
  expect(
    within(relations).queryByRole("link", { name: /javascript:/u }),
  ).toBeNull();
  expect(
    within(relations).queryByRole("link", { name: /data:text/u }),
  ).toBeNull();
  expect(relations.textContent).toContain("javascript:alert(1)");
  expect(relations.textContent).toContain("data:text/html");
  const anchors = [...relations.querySelectorAll("a")];
  expect(
    anchors.every((link) =>
      /^https?:\/\//u.test(link.getAttribute("href") ?? ""),
    ),
  ).toBe(true);

  // The real https address still links, with the hardened attributes.
  const pull = within(relations).getByRole("link", {
    name: "https://example.com/pr/9",
  });
  expect(pull.getAttribute("target")).toBe("_blank");
  expect(pull.getAttribute("rel")).toBe("noopener noreferrer");
});

test("timeline entries are typed and carry their attachments", async () => {
  const detail = cardDetail({
    timeline: [
      timelineEntry({
        id: "C-1#3",
        event_seq: 3,
        type: "review",
        body: "驳回：缺回滚脚本",
      }),
      timelineEntry({
        id: "C-1#2",
        event_seq: 2,
        type: "comment",
        body: "看过了",
      }),
      timelineEntry({
        id: "C-1#1",
        event_seq: 1,
        type: "decision_request",
        body: "要不要合并？",
      }),
    ],
  });
  renderCard({ card: async () => detail });
  await screen.findByRole("article", { name: "卡片 C-1" });
  const entries = document.querySelectorAll(".timeline-entry");
  expect(entries).toHaveLength(3);
  expect(entries[0]?.getAttribute("data-timeline-type")).toBe("review");
  expect(entries[0]?.textContent).toContain("审核");
  expect(entries[1]?.textContent).toContain("评论");
  expect(entries[2]?.textContent).toContain("请求拍板");

  const comment = document.querySelector('[data-timeline-type="comment"]');
  const image = comment?.querySelector("img");
  expect(image?.getAttribute("src")).toBe("/api/projects/p-1/attachments/F-1");
  expect(comment?.textContent).toContain("依据 D-1（待拍板）");
});

test("a non-bitmap attachment is a download, not an image", async () => {
  const detail = cardDetail({
    attachments: [
      attachment({
        id: "F-2",
        mime: "image/svg+xml",
        inline: false,
        basis: null,
        download_path: "/api/projects/p-1/attachments/F-2",
      }),
    ],
  });
  renderCard({ card: async () => detail });
  const comment = (
    await screen.findByRole("article", { name: "卡片 C-1" })
  ).querySelector('[data-timeline-type="comment"]');
  expect(comment?.querySelector("img")).toBeNull();
  const link = comment?.querySelector("a");
  expect(link?.getAttribute("href")).toBe("/api/projects/p-1/attachments/F-2");
  expect(comment?.textContent).toContain("无拍板依据");
});

test("superseded attachments are collapsed", async () => {
  const detail = cardDetail({
    attachments: [
      attachment({ id: "F-2", supersedes: "F-1", download_path: "/x/F-2" }),
      attachment({ id: "F-1", download_path: "/x/F-1" }),
    ],
  });
  renderCard({ card: async () => detail });
  const comment = (
    await screen.findByRole("article", { name: "卡片 C-1" })
  ).querySelector('[data-timeline-type="comment"]');
  const details = comment?.querySelector("details");
  expect(details?.textContent).toContain("已取代的附件（1）");
  expect(details?.textContent).toContain("F-1");
  // The current attachment stays visible outside the collapsed block.
  expect(comment?.querySelector(".attachments")?.textContent).toContain("F-2");
});

test("only existing server-resolved references become links", async () => {
  const detail = cardDetail({
    timeline: [
      timelineEntry({
        id: "C-1#5",
        event_seq: 5,
        body: "见 C-1、D-9 和 C-9；C-9 不存在。",
        references: [
          { kind: "card", id: "C-1", exists: true, status: "in_progress" },
          { kind: "decision", id: "D-9", exists: true, status: "open" },
          { kind: "card", id: "C-9", exists: false, status: null },
        ],
      }),
    ],
  });
  renderCard({ card: async () => detail });
  const entry = (
    await screen.findByRole("article", { name: "卡片 C-1" })
  ).querySelector('[data-timeline-type="comment"]');
  const links = [...(entry?.querySelectorAll(".timeline-body a") ?? [])];
  const hrefs = links.map((link) => link.getAttribute("href"));
  expect(hrefs).toEqual([
    "#/p/p-1/cards/C-1",
    "#/p/p-1/cards/C-1?at=decision-D-9",
  ]);
  // `exists: false` keeps the number as text, even though the server resolved it.
  expect(entry?.textContent).toContain("C-9");
  expect(links.some((link) => link.textContent === "C-9")).toBe(false);
});

test("delivery and human-action references have a timeline target (M5.S S23)", async () => {
  const detail = cardDetail({
    timeline: [
      timelineEntry({
        id: "C-1#7",
        event_seq: 7,
        delivery_id: "V-7",
        human_action_id: "h(3)",
        body: "见 V-7 和 h(3)。",
      }),
    ],
  });
  renderCard({ card: async () => detail });
  await screen.findByRole("article", { name: "卡片 C-1" });
  expect(document.getElementById("delivery-V-7")).toBeTruthy();
  expect(document.getElementById("human-action-h(3)")).toBeTruthy();
});

test("an Agent body with HTML or javascript: links stays inert", async () => {
  const detail = cardDetail({
    timeline: [
      timelineEntry({
        id: "C-1#6",
        event_seq: 6,
        body: [
          '<img src=x onerror="alert(1)">',
          "[点我](javascript:alert(1))",
          "<script>alert(2)</script>",
        ].join("\n\n"),
      }),
    ],
  });
  renderCard({ card: async () => detail });
  const entry = (
    await screen.findByRole("article", { name: "卡片 C-1" })
  ).querySelector('[data-timeline-type="comment"]');
  expect(entry?.querySelector("script")).toBeNull();
  expect(entry?.querySelector(".timeline-body img")).toBeNull();
  const anchors = [...(entry?.querySelectorAll(".timeline-body a") ?? [])];
  expect(
    anchors.every(
      (anchor) => !/javascript:/iu.test(anchor.getAttribute("href") ?? ""),
    ),
  ).toBe(true);
  // The hostile source is visible as text, which is the point.
  expect(entry?.textContent).toContain("<script>");
});
