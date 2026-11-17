// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  attachment,
  cardDetail,
  fakeClient,
  timelineEntry,
} from "../testing/fixtures.js";
import { CardDetailPage } from "../views/CardDetailPage.js";
import { AttachmentGrid } from "./AttachmentGrid.js";
import { CardSource, RecentConclusions } from "./CardIntro.js";
import { Drawer } from "./Drawer.js";

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

test("U5b source quote stays plain text; absent source and relations render nothing", () => {
  const empty = cardDetail();
  const view = render(<CardSource detail={empty} projectId="p-1" />);
  expect(view.container.textContent).toBe("");
  view.rerender(
    <CardSource
      detail={{
        ...empty,
        card: {
          ...empty.card,
          source: { kind: "quote", text: "<script>alert(1)</script> 用户原话" },
        },
      }}
      projectId="p-1"
    />,
  );
  expect(
    screen.getAllByText("<script>alert(1)</script> 用户原话"),
  ).toHaveLength(2);
  expect(view.container.querySelector("script")).toBeNull();
});

test("U5b decision source links to its actual card and excess related cards collapse", () => {
  const base = cardDetail();
  const view = render(
    <CardSource
      detail={{
        ...base,
        card: {
          ...base.card,
          source: { kind: "decision", decision_id: "Q-8" },
        },
        relations: {
          ...base.relations,
          source_card: { id: "C-2", title: "方案来源", decision_id: "Q-8" },
          cards: [2, 3, 4, 5].map((n) => ({
            id: `C-${n}`,
            title: `相关卡 ${n}`,
            status: "done",
          })),
        },
      }}
      projectId="p-1"
    />,
  );
  expect(
    screen.getByRole("link", { name: "C-2 方案来源" }).getAttribute("href"),
  ).toBe("#/p/p-1/cards/C-2");
  expect(
    screen.getByRole("link", { name: "Q-8" }).getAttribute("href"),
  ).toContain("at=decision-Q-8");
  const more = screen.getByText("另外 1 张").closest("details");
  expect(more?.open).toBe(false);
  fireEvent.click(screen.getByText("另外 1 张"));
  expect(more?.open).toBe(true);
  expect(
    within(more as HTMLElement).getByRole("link", { name: "C-5 相关卡 5" }),
  ).toBeTruthy();
  expect(view.container.textContent).not.toContain("来源：你的原话");
});

test.each([false, true])(
  "C-408 tabs isolate work, preserve drafts and support keyboard navigation (drawer=%s)",
  async (inDrawer) => {
    render(
      <CardDetailPage
        client={fakeClient()}
        projectId="p-1"
        cardId="C-1"
        inDrawer={inDrawer}
      />,
    );
    const nav = await screen.findByRole("tablist", { name: "卡片区块导航" });
    expect(within(nav).queryByText("准备发布")).toBeNull();
    expect(screen.queryByRole("region", { name: "工作项" })).toBeNull();
    expect(screen.queryByText(/工作项（.*完成）/)).toBeNull();
    const overview = within(nav).getByRole("tab", { name: "概览" });
    fireEvent.keyDown(overview, { key: "ArrowRight" });
    expect(document.activeElement).toBe(
      within(nav).getByRole("tab", { name: "工作项（2）" }),
    );
    expect(screen.getByRole("region", { name: "工作项" })).toBeTruthy();
    fireEvent.click(within(nav).getByRole("tab", { name: /^时间线/ }));
    fireEvent.click(screen.getByRole("button", { name: "写评论" }));
    const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "评论正文",
    });
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "Keep draft" } });
    fireEvent.click(overview);
    expect(screen.queryByRole("textbox", { name: "评论正文" })).toBeNull();
    fireEvent.click(within(nav).getByRole("tab", { name: /^时间线/ }));
    expect(input.value).toBe("Keep draft");
    expect(screen.getAllByRole("textbox", { name: "评论正文" })).toHaveLength(
      1,
    );
  },
);

test("U5b attachment grid retains true metadata, only previews bitmaps and restores focus after Lightbox", async () => {
  const when = "2026-11-07T15:52:00Z";
  render(
    <AttachmentGrid
      attachments={[
        attachment({
          id: "F-1",
          original_filename: "截图.png",
          note: "修复后的界面",
          uploader_role: "tester",
          uploaded_at: when,
          supersedes: "F-0",
        }),
        attachment({
          id: "F-2",
          mime: "image/webp",
          uploaded_by: "human",
          uploaded_at: when,
          download_path: "/api/projects/p-1/attachments/F-2",
        }),
        attachment({ id: "F-3", mime: "text/html", inline: true }),
        attachment({ id: "F-4", mime: "image/svg+xml", inline: true }),
        attachment({ id: "F-0", mime: "text/plain", inline: false }),
      ]}
    />,
  );
  expect(screen.getByText("未命名的 tester")).toBeTruthy();
  expect(screen.getByText("所有者")).toBeTruthy();
  expect(document.querySelector("time")?.dateTime).toBe(when);
  expect(screen.getAllByText("1.2 KiB")).toHaveLength(5);
  expect(document.querySelectorAll(".attachment-preview img")).toHaveLength(2);
  expect(
    document.querySelector(".attachment-preview img")?.getAttribute("loading"),
  ).toBe("lazy");
  expect(screen.queryByRole("button", { name: "预览 F-3" })).toBeNull();
  expect(screen.queryByRole("button", { name: "预览 F-4" })).toBeNull();
  expect(screen.getByText("已取代的附件（1）").closest("details")?.open).toBe(
    false,
  );
  expect(
    screen
      .getByRole("link", { name: "下载 截图.png" })
      .hasAttribute("download"),
  ).toBe(true);
  expect(screen.getByText("修复后的界面")).toBeTruthy();
  expect(screen.getByText("F-2")).toBeTruthy();
  const trigger = screen.getByRole("button", { name: "预览 截图.png" });
  fireEvent.click(trigger);
  const preview = await screen.findByRole("dialog", { name: "附件 截图.png" });
  expect(within(preview).getByText("修复后的界面")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "下一张" }));
  const next = await screen.findByRole("dialog", { name: "附件 F-2" });
  expect(within(next).getByRole("img").getAttribute("src")).toBe(
    "/api/projects/p-1/attachments/F-2",
  );
  fireEvent.keyDown(next, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(trigger);
});

test("U5b recent conclusions are capped, link to their event and disappear when empty", () => {
  const base = cardDetail();
  const view = render(
    <RecentConclusions detail={base} projectId="p-1" onLocate={undefined} />,
  );
  expect(view.container.textContent).toBe("");
  const entries = [4, 3, 2, 1].map((n) =>
    timelineEntry({
      id: `C-1#${n}`,
      event_seq: n,
      type: "review",
      review_id: `V-${n}`,
      author_role: "reviewer",
    }),
  );
  const detail = {
    ...base,
    recent_conclusions: entries,
    reviews: entries.map((e) => ({
      id: e.review_id as string,
      delivery_id: "D-8",
      work_item_id: "W-2",
      verdict: "pass",
      blocking: false,
    })),
  };
  view.rerender(
    <RecentConclusions detail={detail} projectId="p-1" onLocate={undefined} />,
  );
  expect(screen.getAllByRole("link")).toHaveLength(3);
  expect(screen.getAllByRole("link")[0]?.getAttribute("href")).toBe(
    "#/p/p-1/cards/C-1?at=entry-C-1%234",
  );
});

test("recent conclusions share status shapes and only underline the link on hover", () => {
  const base = cardDetail(),
    pass = timelineEntry({
      id: "C-1#6",
      event_seq: 6,
      type: "review",
      review_id: "V-6",
      author_role: "reviewer",
    }),
    reject = timelineEntry({
      id: "C-1#5",
      event_seq: 5,
      type: "review",
      review_id: "V-5",
      author_role: "reviewer",
    });
  render(
    <RecentConclusions
      detail={{
        ...base,
        recent_conclusions: [pass, reject],
        reviews: [
          {
            id: "V-6",
            delivery_id: "V-1",
            work_item_id: "W-2",
            verdict: "pass",
            blocking: false,
          },
          {
            id: "V-5",
            delivery_id: "V-1",
            work_item_id: "W-2",
            verdict: "reject",
            blocking: true,
          },
        ],
      }}
      projectId="p-1"
      onLocate={undefined}
    />,
  );
  const rows = [...document.querySelectorAll(".recent-conclusions li")];
  expect(
    rows.map((row) => row.querySelector(".status-icon")?.getAttribute("class")),
  ).toEqual([
    "status-icon status-shape-success",
    "status-icon status-shape-error",
  ]);
  // Decorative: the row text already states the outcome.
  for (const row of rows)
    expect(row.querySelector(".status-icon")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
  const css = readFileSync(
    new NodeURL("../styles.css", import.meta.url),
    "utf8",
  );
  const linkStart = css.indexOf(".recent-conclusions a {");
  expect(linkStart).toBeGreaterThanOrEqual(0);
  const link = css.slice(linkStart, css.indexOf("}", linkStart) + 1);
  expect(link).toContain("text-decoration: none;");
  expect(css).toContain(".recent-conclusions a:hover {");
  expect(css).toContain(".status-shape-error");
});

test("U5b a conclusion outside the drawer window loads and scrolls its original entry without leaving the drawer", async () => {
  const base = cardDetail(),
    entry = timelineEntry({
      id: "C-1#1",
      type: "review",
      review_id: "V-9",
      event_seq: 1,
    });
  const data = {
    ...base,
    recent_conclusions: [entry],
    reviews: [
      {
        id: "V-9",
        delivery_id: "V-1",
        work_item_id: "W-2",
        verdict: "pass",
        blocking: false,
      },
    ],
  };
  const card = vi.fn(
    async (_p: string, _c: string, options?: { at?: string }) => ({
      ...data,
      timeline: options?.at
        ? [entry]
        : [timelineEntry({ id: "C-1#30", event_seq: 30 })],
    }),
  );
  const original = Element.prototype.scrollIntoView,
    scroll = vi.fn();
  Element.prototype.scrollIntoView = scroll;
  window.location.hash = "#/p/p-1/cards?card=C-1";
  try {
    render(
      <CardDetailPage
        client={fakeClient({ card })}
        projectId="p-1"
        cardId="C-1"
        inDrawer
      />,
    );
    const recent = await screen.findByRole("region", { name: "最近结论" });
    expect(scroll).not.toHaveBeenCalled();
    fireEvent.click(within(recent).getByRole("link"));
    await waitFor(() =>
      expect(card).toHaveBeenLastCalledWith("p-1", "C-1", {
        limit: 20,
        at: "entry-C-1#1",
      }),
    );
    await waitFor(() =>
      expect(scroll.mock.contexts.at(-1)).toBe(
        document.getElementById("entry-C-1#1"),
      ),
    );
    expect(window.location.hash).toBe("#/p/p-1/cards?card=C-1");
  } finally {
    Element.prototype.scrollIntoView = original;
  }
});

test("U5b closing a nested image preview keeps the card drawer open and restores its trigger", async () => {
  const close = vi.fn();
  render(
    <Drawer open onOpenChange={close} title="卡片详情">
      <AttachmentGrid attachments={[attachment()]} />
    </Drawer>,
  );
  const drawer = await screen.findByRole("dialog", { name: "卡片详情" });
  const trigger = within(drawer).getByRole("button", { name: "预览 F-1" });
  fireEvent.click(trigger);
  const preview = await screen.findByRole("dialog", { name: "附件 F-1" });
  fireEvent.keyDown(preview, { key: "Escape" });
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "附件 F-1" })).toBeNull(),
  );
  expect(screen.getByRole("dialog", { name: "卡片详情" })).toBe(drawer);
  expect(close).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(trigger);
});

test("drawer title follows the loaded card even when filters omit it from the list", async () => {
  const { App } = await import("../App.js");
  window.location.hash = "#/p/p-1/cards?card=C-1&q=unrelated";
  render(
    <App
      client={fakeClient({
        cards: async (_p, filter) => ({
          project_id: "p-1",
          filter,
          cards: [],
          counts: { total: 0, needs_me: 0, agent: 0 },
        }),
      })}
    />,
  );
  const drawer = await screen.findByRole("dialog", { name: "C-1 准备发布" });
  expect(within(drawer).getAllByText(/准备发布/)).toHaveLength(1);
  expect(drawer.querySelector(".card-header h1")).toBeNull();
});
