// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cardDetail, fakeClient, timelineEntry } from "../testing/fixtures.js";
import { selectMenu } from "../testing/menu.js";
import { CardDetailPage } from "../views/CardDetailPage.js";
import { Timeline } from "./Timeline.js";
import { TimelineControls } from "./TimelineControls.js";

const sha = "fffb15b13a14088c68e8d1a9e26a8e3cedc3a904";
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
});
function records() {
  const base = cardDetail();
  return {
    ...base,
    attachments: [],
    deliveries: [
      {
        id: "D-9",
        work_item_id: "W-1",
        kind: "code",
        summary: "中文计词已实现",
        subject: { kind: "git_head", value: sha },
        status: "accepted",
      },
    ],
    reviews: [
      {
        id: "V-13",
        delivery_id: "D-9",
        work_item_id: "W-2",
        verdict: "pass",
        target_sha: sha,
        blocking: false,
        issues: [],
      },
    ],
    decisions: [
      {
        id: "Q-8",
        question: "Merge C-1 into main?",
        trigger: "merge_confirmation",
        status: "resolved",
        decider: "human",
        blocking: true,
        recommended: "merge",
        options: [{ key: "merge", description: "Merge", impact: "Publish" }],
        resolution: {
          option: "hold",
          rationale: "Later change",
          raw_quote: "Do not overwrite history",
          at: "2026-11-09T00:00:00Z",
        },
      },
    ],
    timeline: [
      timelineEntry({
        id: "C-1#1",
        event_seq: 1,
        type: "delivery",
        delivery_id: "D-9",
        author_role: "coder",
      }),
      timelineEntry({
        id: "C-1#2",
        event_seq: 2,
        type: "review",
        review_id: "V-13",
        author_role: "reviewer",
      }),
      timelineEntry({
        id: "C-1#3",
        event_seq: 3,
        type: "decision_resolved",
        decision_id: "Q-8",
        decision_option: "merge",
        author: "human",
        body: "在 Needs You 选择了 merge",
      }),
    ],
  };
}
function show(detail = records()) {
  return render(
    <Timeline
      projectId="p-1"
      cardId="C-1"
      detail={detail}
      entries={detail.timeline}
      attachments={[]}
    />,
  );
}
function sheet() {
  const style = document.createElement("style");
  style.textContent = readFileSync(
    new NodeURL("../styles.css", import.meta.url),
    "utf8",
  );
  document.head.append(style);
  return style;
}

test("U5c filters, count and paging share one nonwrapping row with public menus", async () => {
  const style = sheet();
  try {
    const change = vi.fn(),
      load = vi.fn();
    render(
      <TimelineControls
        filters={{ author: "pm" }}
        onChange={change}
        loaded={20}
        total={61}
        pageSize={20}
        pending={false}
        loadEarlier={load}
      />,
    );
    const controls = screen.getByRole("group", { name: "时间线筛选与加载" });
    expect(getComputedStyle(controls).display).toBe("flex");
    expect(getComputedStyle(controls).flexWrap).toBe("nowrap");
    expect(getComputedStyle(controls).whiteSpace).toBe("nowrap");
    for (const text of [/条目类型：/, /发言方：/, /加载更早/, /每次加载：/])
      expect(
        within(controls).getByRole("button", { name: text }).parentElement,
      ).toBe(controls);
    expect(within(controls).getByText("已加载 20 / 61 条")).toBeTruthy();
    expect(within(controls).queryByRole("combobox")).toBeNull();
    await selectMenu(/^条目类型：/, "审核");
    expect(change).toHaveBeenCalledWith({ author: "pm", type: "review" });
    await selectMenu(/^每次加载：/, "50 条");
    expect(change).toHaveBeenCalledWith({ author: "pm", count: "50" });
    fireEvent.click(screen.getByRole("button", { name: "加载更早的记录" }));
    expect(load).toHaveBeenCalledOnce();
  } finally {
    style.remove();
  }
});

test("U5c groups by local calendar day, in order, without combining system events across midnight", () => {
  const entries = [1, 2, 3].map((n) =>
    timelineEntry({
      id: `C-1#${n}`,
      event_seq: n,
      type: "system",
      author: "system",
      event_type: "assignment_released",
      created_at: new Date(
        2026,
        10,
        n === 1 ? 7 : 8,
        n === 1 ? 23 : 0,
        n === 1 ? 59 : n,
      ).toISOString(),
    }),
  );
  render(
    <Timeline
      projectId="p-1"
      cardId="C-1"
      entries={entries.reverse()}
      attachments={[]}
    />,
  );
  const days = [...document.querySelectorAll(".timeline-day")];
  expect(days.map((d) => d.querySelector("h3")?.textContent)).toEqual([
    "2026年11月8日",
    "2026年11月7日",
  ]);
  expect(days[0]?.querySelectorAll(".timeline-entry")).toHaveLength(2);
  expect(days[1]?.querySelectorAll(".timeline-entry")).toHaveLength(1);
  expect(
    within(days[0] as HTMLElement).getByText("释放了 2 个 Assignment"),
  ).toBeTruthy();
  expect(document.getElementById("entry-C-1#3")).toBeTruthy();
  expect(
    [...document.querySelectorAll(".timeline-entry")].map((row) => row.id),
  ).toEqual(["entry-C-1#3", "entry-C-1#2", "entry-C-1#1"]);
  expect(
    days[0]?.querySelector(".system-line time")?.getAttribute("datetime"),
  ).toBe(entries[0]?.created_at);
});

test("U5c delivery, review and decision lead with unique IDs and coloured results above summary and metadata", () => {
  const style = sheet();
  try {
    show();
    for (const [n, id, label, result] of [
      [1, "D-9", "交付", "已接受"],
      [2, "V-13", "审核", "已通过"],
      [3, "Q-8", "拍板", "确认合并"],
    ] as const) {
      const row = document.getElementById(`entry-C-1#${n}`) as HTMLElement;
      const heading = within(row).getByRole("heading", {
        name: `${id} ${label} ${result}`,
      });
      expect(heading.querySelector(".status")?.textContent).toBe(result);
      expect(
        getComputedStyle(heading.querySelector(".status") as Element)
          .fontWeight,
      ).toBe("600");
      expect(getComputedStyle(row).borderLeftWidth).toBe("3px");
      expect(
        heading.compareDocumentPosition(
          row.querySelector(".entry-summary") as Element,
        ) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(row.querySelector(".entry-meta")).toBeTruthy();
      expect(row.textContent?.split(id)).toHaveLength(2);
      expect(row.textContent).not.toMatch(/序号|·/);
    }
    expect(screen.getByText("在 Needs You 选择了 merge")).toBeTruthy();
    expect(screen.queryByText("Do not overwrite history")).toBeNull();
  } finally {
    style.remove();
  }
});

test("U5c seven-character SHA copies the complete bound commit and exposes it in a shared tooltip", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  show();
  const row = document.getElementById("entry-C-1#1") as HTMLElement;
  const copy = within(row).getByRole("button", { name: "复制提交 fffb15b" });
  expect(copy.textContent).toBe("提交 fffb15b");
  expect(row.textContent).not.toContain(sha);
  fireEvent.click(copy);
  expect(await screen.findByText("已复制")).toBeTruthy();
  expect(writeText).toHaveBeenCalledWith(sha);
  act(() => copy.focus());
  expect((await screen.findByRole("tooltip")).textContent).toContain(sha);
});

test("U5c clipboard denial reports failure instead of claiming success", async () => {
  vi.stubGlobal("navigator", {
    clipboard: { writeText: vi.fn().mockRejectedValue(new Error("Denied")) },
  });
  show();
  fireEvent.click(
    screen.getAllByRole("button", {
      name: "复制提交 fffb15b",
    })[0] as HTMLElement,
  );
  expect(
    await screen.findByText("复制失败，请从提示中选取完整 SHA"),
  ).toBeTruthy();
  expect(screen.queryByText("已复制")).toBeNull();
});

test("U6b long comments fold after fifteen rendered lines and expand safely; sequence stays in tooltip", async () => {
  const computed = getComputedStyle(document.body);
  computed.lineHeight = "20px";
  vi.spyOn(window, "getComputedStyle").mockReturnValue(computed);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(400);
  const entry = timelineEntry({
    body: "<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n最后一行",
    author_role: "coder",
    event_seq: 37,
  });
  render(
    <Timeline
      projectId="p-1"
      cardId="C-1"
      entries={[entry]}
      attachments={[]}
    />,
  );
  const expand = screen.getByRole("button", { name: "展开全文" });
  expect(expand.getAttribute("aria-expanded")).toBe("false");
  expect(document.querySelector(".long-content-15 .collapsed")).toBeTruthy();
  fireEvent.click(expand);
  expect(expand.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByText("最后一行")).toBeTruthy();
  expect(document.querySelector("script, a[href^='javascript:']")).toBeNull();
  expect(document.querySelector(".timeline-entry")?.textContent).not.toContain(
    "序号",
  );
  act(() => screen.getByRole("button", { name: "未命名的 coder" }).focus());
  const tooltip = await screen.findByRole("tooltip");
  expect(tooltip.textContent).toContain("序号 37");
  expect(tooltip.textContent).toContain("A-1");
});

test("C-205 full page and drawer keep the header visible above the dated timeline", async () => {
  const data = records();
  data.timeline = data.timeline.map((entry, index) => ({
    ...entry,
    created_at: new Date(2026, 10, 7 + index).toISOString(),
  }));
  const client = fakeClient({ card: async () => data }),
    scroll = vi.fn();
  const original = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = scroll;
  try {
    const full = render(
      <CardDetailPage client={client} projectId="p-1" cardId="C-1" />,
    );
    await screen.findByRole("region", { name: "时间线记录" });
    expect(scroll).not.toHaveBeenCalled();
    expect(document.querySelectorAll(".timeline-day")).toHaveLength(3);
    full.unmount();
    scroll.mockClear();
    render(
      <CardDetailPage client={client} projectId="p-1" cardId="C-1" inDrawer />,
    );
    await screen.findByRole("region", { name: "时间线记录" });
    expect(scroll).not.toHaveBeenCalled();
  } finally {
    Element.prototype.scrollIntoView = original;
  }
});
