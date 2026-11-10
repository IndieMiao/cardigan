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
import { attachment, cardDetail, timelineEntry } from "../testing/fixtures.js";
import { Timeline } from "./Timeline.js";
import { TimelineContent } from "./TimelineContent.js";
import { TimelineIcon } from "./TimelineHeader.js";

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
const css = readFileSync(new NodeURL("../styles.css", import.meta.url), "utf8");
const show = (
  entries: ReturnType<typeof timelineEntry>[],
  attachments: ReturnType<typeof attachment>[] = [],
) =>
  render(
    <Timeline
      projectId="p-1"
      cardId="C-1"
      entries={entries}
      attachments={attachments}
    />,
  );
function measure(height: number) {
  const original = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((node) => {
    const style = original(node);
    if (node.classList.contains("long-body")) style.lineHeight = "25.5px";
    return style;
  });
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
    height,
  );
}

test("U6b the continuous rail and seven linear icons share one circular geometry; dates have no colour block", () => {
  for (const [type, event_type] of [
    ["comment", null],
    ["instruction", null],
    ["delivery", null],
    ["review", null],
    ["decision_request", null],
    ["system", "attachment_uploaded"],
    ["system", "card_merged"],
  ] as const)
    render(<TimelineIcon entry={timelineEntry({ type, event_type })} />);
  const icons = [...document.querySelectorAll(".timeline-icon")];
  expect(icons.map((e) => e.getAttribute("data-icon"))).toEqual([
    "comment",
    "instruction",
    "delivery",
    "review",
    "decision",
    "attachment",
    "system",
  ]);
  expect(
    new Set(icons.map((e) => e.querySelector("path")?.getAttribute("d"))).size,
  ).toBe(7);
  expect(
    icons.every(
      (e) => e.querySelector("svg")?.getAttribute("viewBox") === "0 0 24 24",
    ),
  ).toBe(true);
  const rule = (selector: string) =>
    css.slice(
      css.indexOf(`${selector} {`),
      css.indexOf("}", css.indexOf(`${selector} {`)),
    );
  expect(rule(".timeline-days::before")).toContain("width: 1px;");
  expect(rule(".timeline-icon")).toContain("border-radius: 50%;");
  expect(rule(".timeline-day > h3")).not.toContain("background:");
  expect(rule(".timeline-day > h3::after")).toContain("height: 1px;");
});

test.each(["comment", "instruction"] as const)(
  "U6b %s has an avatar, strong speaker, Assignment badge and relative time; ordinary prose stays complete",
  (type) => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-09T12:00:00Z"));
    measure(300); // Fewer than 15 rendered lines, despite multiple source paragraphs.
    show([
      timelineEntry({
        type,
        author: "assignment:A-14",
        author_role: "tester",
        created_at: "2026-11-08T13:00:00Z",
        body: "第一段\n\n- 第一点\n- 第二点\n\n> 引用\n\n最后一段",
      }),
    ]);
    const head = document.querySelector(".timeline-head") as HTMLElement;
    expect(head.querySelector(".employee-avatar")?.textContent).toBe("T");
    expect(head.querySelector("strong")?.textContent).toBe("未命名的 tester");
    expect(within(head).getByText("A-14")).toBeTruthy();
    expect(head.textContent).toContain(
      `${type === "comment" ? "评论" : "指令"}于 23 小时前`,
    );
    expect(head.querySelector("time")?.title).toContain("GMT");
    expect(document.querySelector(".timeline-body ul")).toBeTruthy();
    expect(document.querySelector(".timeline-body blockquote")).toBeTruthy();
    expect(screen.getByText("最后一段")).toBeTruthy();
    expect(document.querySelector(".long-body.collapsed")).toBeNull();
    expect(screen.queryByRole("button", { name: "展开全文" })).toBeNull();
  },
);

test("U6b only comments above fifteen rendered lines fade and fold; expansion preserves safe Markdown", () => {
  measure(410);
  show([
    timelineEntry({
      body:
        "<script>unsafe()</script>\n\n[unsafe](javascript:unsafe())\n\n" +
        "正文完整保留\n\n".repeat(20),
    }),
  ]);
  const collapsed = document.querySelector(".long-content-15 .collapsed");
  expect(collapsed).toBeTruthy();
  expect(css).toContain(".long-content-15 .long-body.collapsed::after");
  expect(css).toContain("linear-gradient(transparent, var(--timeline-card))");
  const expand = screen.getByRole("button", { name: "展开全文" });
  fireEvent.click(expand);
  expect(expand.getAttribute("aria-expanded")).toBe("true");
  expect(document.querySelector(".long-content-15 .collapsed")).toBeNull();
  expect(screen.getAllByText("正文完整保留")).toHaveLength(20);
  expect(document.querySelector("script, a[href^='javascript:']")).toBeNull();
  fireEvent.click(expand);
  expect(expand.getAttribute("aria-expanded")).toBe("false");
});

test("U6b structural conclusions retain their result and share the comment header", () => {
  const detail = cardDetail({
    deliveries: [
      {
        id: "D-1",
        work_item_id: "W-1",
        kind: "code",
        status: "accepted",
        summary: "交付摘要",
        subject: { kind: "git_head", value: "a".repeat(40) },
      },
    ],
    reviews: [
      {
        id: "V-1",
        delivery_id: "D-1",
        work_item_id: "W-2",
        verdict: "reject",
        blocking: true,
      },
    ],
    decisions: [
      {
        id: "q(1)",
        question: "选择方案",
        status: "open",
        blocking: true,
        decider: "human",
        options: [],
        recommended: "",
      },
    ],
  });
  const entries = [
    timelineEntry({
      id: "e1",
      type: "delivery",
      delivery_id: "D-1",
      author_role: "coder",
    }),
    timelineEntry({
      id: "e2",
      type: "review",
      review_id: "V-1",
      author_role: "reviewer",
    }),
    timelineEntry({
      id: "e3",
      type: "decision_request",
      decision_id: "q(1)",
      author_role: "pm",
    }),
  ];
  render(
    <Timeline
      projectId="p-1"
      cardId="C-1"
      entries={entries}
      attachments={[]}
      detail={detail}
    />,
  );
  for (const [n, result] of ["已接受", "已驳回", "待拍板"].entries()) {
    const row = document.getElementById(`entry-e${n + 1}`) as HTMLElement;
    expect(row.querySelector(".employee-avatar")).toBeTruthy();
    expect(row.querySelector(".timeline-head strong")).toBeTruthy();
    expect(row.querySelector(".timeline-conclusion .status")?.textContent).toBe(
      result,
    );
    expect(row.querySelector(".timeline-when time")).toBeTruthy();
  }
});

test("attachment names and notes appear in comments and upload rows as plain text, with legacy fallback", () => {
  const named = attachment({
    id: "attachment-1",
    original_filename: "截图.png",
    note: "<script>plain text</script>",
    attach_to: { kind: "timeline_entry", id: "comment" },
  });
  const document = attachment({
    id: "attachment-2",
    original_filename: "结果.txt",
    note: "测试日志",
    mime: "text/plain",
    inline: false,
  });
  const legacy = attachment({
    id: "attachment-3",
    attach_to: { kind: "timeline_entry", id: "comment" },
  });
  const view = show(
    [
      timelineEntry({ id: "comment", type: "comment", body: "附件结果" }),
      timelineEntry({
        id: "upload",
        event_seq: 2,
        type: "system",
        event_type: "attachment_uploaded",
        attachment_id: named.id,
        body: "Attached attachment-1",
      }),
      timelineEntry({
        id: "upload-text",
        event_seq: 3,
        type: "system",
        event_type: "attachment_uploaded",
        attachment_id: document.id,
        body: "Attached attachment-2",
      }),
    ],
    [named, document, legacy],
  );
  const attached = view.container.querySelector(".attachments") as HTMLElement;
  expect(within(attached).getByText("截图.png")).toBeTruthy();
  expect(
    within(attached).getByText("<script>plain text</script>"),
  ).toBeTruthy();
  expect(within(attached).getByText("attachment-3")).toBeTruthy();
  const rows = view.container.querySelectorAll(".system-line");
  expect(
    [...rows].some(
      (row) =>
        row.textContent?.includes("截图.png") &&
        row.textContent.includes("<script>plain text</script>"),
    ),
  ).toBe(true);
  expect(screen.getByRole("link", { name: "下载 结果.txt" })).toBeTruthy();
  expect(screen.getByText("测试日志")).toBeTruthy();
  expect(view.container.querySelector("script")).toBeNull();
});

test("U6b system rows show the authenticated actor and exact upload thumbnail; previews exclude SVG and close to their trigger", async () => {
  const file = attachment({ id: "F-1" }),
    svg = attachment({ id: "F-2", mime: "image/svg+xml", inline: true });
  show(
    [
      timelineEntry({
        id: "upload1",
        event_seq: 1,
        type: "system",
        event_type: "attachment_uploaded",
        attachment_id: "F-1",
        author: "assignment:A-14",
        author_role: "tester",
        body: "Attached F-1",
      }),
      timelineEntry({
        id: "upload2",
        event_seq: 2,
        type: "system",
        event_type: "attachment_uploaded",
        attachment_id: "F-2",
        author: "human",
        body: "Attached F-2",
      }),
      timelineEntry({
        id: "merged",
        event_seq: 3,
        type: "system",
        event_type: "card_merged",
        author: "system",
        body: "card_merged",
      }),
    ],
    [file, svg],
  );
  const rows = [...document.querySelectorAll(".system-line")];
  expect(rows.map((r) => r.querySelector("strong")?.textContent)).toEqual([
    "系统",
    "你",
    "未命名的 tester",
  ]);
  expect(rows[2]?.textContent).toContain("上传了附件");
  expect(rows[2]?.textContent).toContain("A-14");
  expect(rows[0]?.textContent).toContain("完成了合并");
  expect(rows[0]?.parentElement?.querySelector("summary")).toBeNull();
  expect(document.querySelectorAll(".system-line img")).toHaveLength(1);
  expect(
    document.querySelector(".system-line img")?.getAttribute("loading"),
  ).toBe("lazy");
  const trigger = within(rows[2] as HTMLElement).getByRole("button", {
    name: "预览 F-1",
  });
  fireEvent.click(trigger);
  const dialog = await screen.findByRole("dialog", { name: "附件 F-1" });
  expect(within(dialog).getByRole("img").getAttribute("src")).toBe(
    file.download_path,
  );
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(trigger);
  expect(
    within(rows[1] as HTMLElement).queryByRole("button", { name: "预览 F-2" }),
  ).toBeNull();
  expect(css).toContain(".system-details > summary::-webkit-details-marker");
});

test("merge timeline shows the deadline and distinguishes delegated from human confirmation", () => {
  const decision = {
    id: "q(1)",
    trigger: "merge_confirmation",
    question: "Merge C-1 into main?",
    status: "open",
    decider: "human",
    blocking: true,
    options: [{ key: "merge", description: "合并", impact: "更新基线" }],
    recommended: "merge",
    auto_merge: { minutes: 10, due_at: "2026-01-01T00:10:00.000Z" },
  };
  const detail = cardDetail({ decisions: [decision] });
  const entry = timelineEntry({
    type: "decision_request",
    decision_id: decision.id,
  });
  const content = (item: typeof entry) => (
    <TimelineContent
      entry={item}
      detail={detail}
      projectId="p-1"
      cardId="C-1"
    />
  );
  const view = render(content(entry));
  expect(screen.getByText(/自动合并（偏好设置：10 分钟）/)).toBeTruthy();
  const resolved = {
    ...entry,
    type: "decision_resolved" as const,
    decision_option: "merge",
    author: "system",
    body: "超过 10 分钟无人处理，按偏好设置自动确认合并",
  };
  view.rerender(content({ ...resolved, decision_via: "delegated" }));
  expect(screen.getByText("自动合并（代批）")).toBeTruthy();
  expect(screen.queryByText(/将于/)).toBeNull();
  view.rerender(content({ ...resolved, author: "human" }));
  expect(screen.queryByText("自动合并（代批）")).toBeNull();
});

test("a PM delegated decision uses a shared status icon and remains distinct from automatic merge approval", () => {
  const decision = {
    id: "q(2)",
    question: "选用哪个展示方式？",
    status: "resolved",
    decider: "pm",
    blocking: false,
    options: [{ key: "compact", description: "紧凑展示", impact: "减少留白" }],
  };
  render(
    <TimelineContent
      entry={timelineEntry({
        type: "decision_resolved",
        decision_id: decision.id,
        decision_via: "delegated",
        decision_option: "compact",
        author: "assignment:A-4",
      })}
      detail={cardDetail({ decisions: [decision] })}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  expect(
    screen
      .getByText("已拍板（PM 代拍）")
      .querySelector("svg.status-shape-success")
      ?.getAttribute("aria-hidden"),
  ).toBe("true");
  expect(screen.queryByText("自动合并（代批）")).toBeNull();
});

test("human completion results render literally, including Markdown, references and HTML", () => {
  const body =
    "**确认完成** <img src=x onerror=alert(1)>\n[证据](https://example.test) C-2";
  const { container } = show([
    timelineEntry({
      type: "status_change",
      event_type: "card_marked_done",
      author: "human",
      body,
      references: [
        {
          kind: "card",
          id: "C-2",
          exists: true,
          status: "done",
          card_id: "C-2",
        },
      ],
    }),
  ]);
  fireEvent.click(screen.getByText("详情"));
  const content = container.querySelector(".timeline-body");
  expect(content?.textContent).toBe(body);
  expect(content?.querySelector("strong, a, img, script")).toBeNull();
  expect(content?.classList.contains("markdown")).toBe(false);
});
