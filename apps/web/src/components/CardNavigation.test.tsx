// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useRef } from "react";
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
import { CardSectionNav } from "./CardSectionNav.js";
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
  expect(screen.getByText("<script>alert(1)</script> 用户原话")).toBeTruthy();
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
          source: { kind: "decision", decision_id: "q(8)" },
        },
        relations: {
          ...base.relations,
          source_card: { id: "C-2", title: "方案来源", decision_id: "q(8)" },
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
    screen.getByRole("link", { name: "q(8)" }).getAttribute("href"),
  ).toContain("at=decision-q(8)");
  const more = screen.getByText("另外 1 张").closest("details");
  expect(more?.open).toBe(false);
  fireEvent.click(screen.getByText("另外 1 张"));
  expect(more?.open).toBe(true);
  expect(
    within(more as HTMLElement).getByRole("link", { name: "C-5 相关卡 5" }),
  ).toBeTruthy();
  expect(view.container.textContent).not.toContain("来源：你的原话");
});

function Navigation({ drawer }: { drawer: boolean }) {
  const ref = useRef<HTMLElement>(null);
  const page = (
    <article ref={ref}>
      <CardSectionNav
        article={ref}
        sections={[
          { id: "overview", label: "概览" },
          { id: "work", label: "工作项", count: 2 },
          { id: "timeline", label: "时间线", count: 3 },
        ]}
      />
      <section id="overview" />
      <section id="work" />
      <section id="timeline">
        <textarea className="comment-input" aria-label="评论正文" />
      </section>
    </article>
  );
  return drawer ? <div className="drawer-body">{page}</div> : page;
}
test.each([false, true])(
  "U5b navigation uses the correct scroll container and focuses comments (drawer=%s)",
  (drawer) => {
    let shift = 0;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function () {
        const top =
          this.classList.contains("drawer-body") ||
          (drawer && this.classList.contains("card-section-nav"))
            ? 100
            : this.id === "work"
              ? 500 - shift
              : this.id === "timeline"
                ? 900 - shift
                : 0;
        return {
          top,
          bottom: top + 40,
          height: 40,
          width: 700,
          left: 0,
          right: 700,
          x: 0,
          y: top,
          toJSON() {},
        };
      },
    );
    const windowScroll = vi
      .spyOn(window, "scrollTo")
      .mockImplementation(() => {});
    render(<Navigation drawer={drawer} />);
    const root = document.querySelector<HTMLElement>(".drawer-body");
    const local = vi.fn();
    if (root) root.scrollTo = local;
    fireEvent.click(screen.getByRole("button", { name: "工作项（2）" }));
    const expected = drawer ? 348 : 448;
    expect(drawer ? local : windowScroll).toHaveBeenCalledWith({
      top: expected,
      behavior: "smooth",
    });
    if (drawer) expect(windowScroll).not.toHaveBeenCalled();
    // Native scrolling rounds to device pixels; half a pixel must not select the previous block.
    shift = drawer ? 347.5 : 447.5;
    fireEvent.scroll(root ?? window);
    expect(
      screen
        .getByRole("button", { name: "工作项（2）" })
        .getAttribute("aria-current"),
    ).toBe("location");
    shift = 850;
    fireEvent.scroll(root ?? window);
    expect(
      screen
        .getByRole("button", { name: "时间线（3）" })
        .getAttribute("aria-current"),
    ).toBe("location");
    shift = 0;
    if (root) {
      Object.defineProperty(root, "clientHeight", { value: 600 });
      Object.defineProperty(root, "scrollHeight", { value: 1000 });
      root.scrollTop = 396;
    } else {
      vi.spyOn(document.documentElement, "scrollHeight", "get").mockReturnValue(
        window.innerHeight + 100,
      );
      vi.spyOn(window, "scrollY", "get").mockReturnValue(96);
    }
    fireEvent.scroll(root ?? window);
    expect(
      screen
        .getByRole("button", { name: "时间线（3）" })
        .getAttribute("aria-current"),
    ).toBe("location");
    const input = screen.getByRole("textbox", { name: "评论正文" });
    const focus = vi.spyOn(input, "focus");
    fireEvent.click(screen.getByRole("button", { name: "写评论" }));
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(document.activeElement).toBe(input);
  },
);

test("U5b section order matches navigation, empty sections disappear and drawer still starts at top", async () => {
  const scroll = vi.fn(),
    original = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = scroll;
  try {
    const view = render(
      <CardDetailPage
        client={fakeClient()}
        projectId="p-1"
        cardId="C-1"
        inDrawer
      />,
    );
    const nav = await screen.findByRole("navigation", { name: "卡片区块导航" });
    expect(
      within(nav)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual([
      "概览",
      "工作项（2）",
      "交付与审核（1）",
      "时间线（2）",
      "附件（1）",
      "写评论",
    ]);
    expect(
      [...document.querySelectorAll(".card-main > [id]")].map((e) => e.id),
    ).toEqual([
      "card-C-1-overview",
      "card-C-1-work",
      "card-C-1-records",
      "card-C-1-timeline",
      "card-C-1-attachments",
    ]);
    expect(scroll).not.toHaveBeenCalled();
    view.unmount();
    const base = cardDetail({
      work_items: [],
      deliveries: [],
      reviews: [],
      timeline: [],
      attachments: [],
      counts: { timeline: 0, deliveries: 0, reviews: 0, open_decisions: 0 },
    });
    render(
      <CardDetailPage
        client={fakeClient({ card: async () => base })}
        projectId="p-1"
        cardId="C-1"
        inDrawer
      />,
    );
    expect(
      within(await screen.findByRole("navigation", { name: "卡片区块导航" }))
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["概览", "写评论"]);
  } finally {
    Element.prototype.scrollIntoView = original;
  }
});

test("U5b attachment grid retains true metadata, only previews bitmaps and restores focus after Lightbox", async () => {
  const when = "2026-11-07T15:52:00Z";
  render(
    <AttachmentGrid
      attachments={[
        attachment({
          id: "F-1",
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
  expect(screen.getByText("tester A-1")).toBeTruthy();
  expect(screen.getByText("你")).toBeTruthy();
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
    screen.getByRole("link", { name: "下载 F-1" }).hasAttribute("download"),
  ).toBe(true);
  const trigger = screen.getByRole("button", { name: "预览 F-1" });
  fireEvent.click(trigger);
  await screen.findByRole("dialog", { name: "附件 F-1" });
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
