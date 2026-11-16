// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { ActivityData, NeedsPage, NoticeView } from "../api.js";
import { cardDetail, fakeClient, timelineEntry } from "../testing/fixtures.js";
import { ActivityPage } from "../views/ActivityPage.js";
import { NeedsYouPage } from "../views/NeedsYouPage.js";
import { RecentConclusions } from "./CardIntro.js";
import { EmployeeIdentity } from "./EmployeeIdentity.js";
import { Timeline } from "./Timeline.js";
import { TimelineActor } from "./TimelineHeader.js";

afterEach(cleanup);

/** One fixed gear icon, the name 系统, and never a lettered circle. */
function expectSystem(root: ParentNode) {
  const avatar = root.querySelector(".employee-avatar");
  expect(avatar?.classList.contains("employee-system")).toBe(true);
  expect(avatar?.getAttribute("data-system-icon")).toBe("gear");
  expect(avatar?.querySelector("svg")).toBeTruthy();
  expect(avatar?.querySelector("img")).toBeNull();
  expect(avatar?.textContent).toBe("");
  expect(root.textContent).toContain("系统");
}

test("system author renders the fixed gear icon and keeps the name 系统", () => {
  const { container, rerender } = render(<EmployeeIdentity author="system" />);
  expectSystem(container);
  expect(screen.getByText("系统").tagName).toBe("STRONG");
  const gear = container.querySelector(".employee-system")?.innerHTML;
  // The server's author_display does not change the icon.
  rerender(<EmployeeIdentity author="system" author_display="系统" />);
  expect(container.querySelector(".employee-system")?.innerHTML).toBe(gear);
  rerender(<EmployeeIdentity author="system" avatarOnly />);
  expect(screen.getByRole("img", { name: "系统" })).toBeTruthy();
  expect(container.querySelector(".employee-system")?.innerHTML).toBe(gear);
  rerender(<EmployeeIdentity author="system" metadata="system，C-1#2" />);
  expect(screen.getByRole("button", { name: "系统" })).toBeTruthy();
  expect(container.querySelector(".employee-system")?.innerHTML).toBe(gear);
});

test("people, employees and standing PMs keep their avatars", () => {
  const { container, rerender } = render(
    <EmployeeIdentity author="human" member={null} />,
  );
  expect(container.querySelector(".employee-system")).toBeNull();
  expect(container.querySelector(".employee-avatar")?.textContent).toBe("所");
  rerender(
    <EmployeeIdentity
      author="assignment:A-1"
      author_display="PM 后台（PM Ops）"
      author_role="pm"
    />,
  );
  expect(container.querySelector(".employee-system")).toBeNull();
  expect(container.querySelector(".employee-avatar")?.textContent).toBe("P");
  rerender(
    <EmployeeIdentity
      author="system"
      employee={{
        id: "E-1",
        name: "林舟",
        title: "工程师",
        avatar: "/avatars/v1/guan-yu/head-64.webp",
      }}
    />,
  );
  expect(container.querySelector(".employee-system")).toBeNull();
  expect(container.querySelector(".employee-avatar img")).toBeTruthy();
});

test("timeline rows, single and grouped, show the gear for system", () => {
  const { container } = render(
    <TimelineActor
      entry={timelineEntry({ author: "system", type: "system" })}
    />,
  );
  expectSystem(container);
  cleanup();
  render(
    <Timeline
      entries={[
        timelineEntry({
          id: "C-1#3",
          event_seq: 3,
          type: "system",
          event_type: "card_merged",
          author: "system",
          body: "card_merged",
        }),
      ]}
      attachments={[]}
    />,
  );
  const line = document.querySelector(".system-line") as HTMLElement;
  expectSystem(line);
});

test("Needs You notices resolved by the system show the gear", async () => {
  const notice: NoticeView = {
    id: "N-1",
    kind: "merge",
    card_id: "C-1",
    decision_id: "Q-7",
    question: "",
    option: "merge",
    resolved_by: "system",
    author: "system",
    author_display: "系统",
    body: "超时自动合并",
    proxy_authority: null,
    at: "2026-01-01T00:00:00.000Z",
    read: false,
  };
  const data = {
    decisions: [],
    human_actions: [],
    incidents: [],
    notices: [notice],
  } as unknown as NeedsPage;
  render(
    <NeedsYouPage
      client={fakeClient({ needsYou: async () => data })}
      projectId="p-1"
    />,
  );
  const article = await screen.findByRole("article", { name: "知会 Q-7" });
  const identity = within(article.querySelector("header") as HTMLElement)
    .getByText("系统")
    .closest(".employee-identity");
  expect(identity).toBeTruthy();
  if (identity) expectSystem(identity);
});

test("activity shows the gear for single and grouped system events", async () => {
  const systemEvent = (id: string, card_id: string) => ({
    id,
    card_id,
    card_title: "准备发布",
    seq: 1,
    type: "run_queued",
    role: null,
    created_at: "2026-01-01T01:00:00Z",
    payload: {},
    actor: { kind: "system" as const },
  });
  const data = {
    cards: [{ id: "C-1", title: "准备发布" }],
    events: [
      systemEvent("e1", "C-1"),
      systemEvent("e2", "C-1"),
      systemEvent("e3", "C-2"),
    ],
    next_before: null,
    counts: { returned: 3, matched: 3 },
  } as unknown as ActivityData;
  render(
    <ActivityPage
      client={fakeClient({ activity: async () => data })}
      projectId="p-1"
    />,
  );
  await screen.findAllByText("系统");
  const rows = [...document.querySelectorAll(".activity-summary")];
  expect(rows).toHaveLength(2);
  for (const row of rows) expectSystem(row);
  expect(document.querySelectorAll(".activity-summary > strong")).toHaveLength(
    0,
  );
});

test("system icon is a token-coloured rounded square, not a person circle", () => {
  const css = readFileSync(
    new NodeURL("../styles.css", import.meta.url),
    "utf8",
  );
  const rule = css.match(/\.employee-avatar\.employee-system \{([^}]*)\}/)?.[1];
  expect(rule).toBeTruthy();
  expect(rule).toMatch(/color: var\(--text\)/);
  expect(rule).toMatch(/background: var\(--surface-muted\)/);
  expect(rule).not.toMatch(/50%|#[0-9a-f]{3,8}\b/i);
});

test("card detail recent conclusions show the gear for a system decision only", () => {
  const decision = {
    id: "Q-7",
    question: "合并？",
    status: "resolved",
    blocking: false,
    decider: "human",
    options: [{ key: "merge", description: "合并", impact: "上线" }],
    recommended: "merge",
    trigger: "merge_confirmation",
  };
  const byPm = { ...decision, id: "Q-8" };
  const detail = cardDetail({
    decisions: [decision, byPm],
    recent_conclusions: [
      timelineEntry({
        id: "C-1#9",
        event_seq: 9,
        type: "decision_resolved",
        author: "system",
        author_display: "系统",
        decision_id: "Q-7",
        decision_option: "merge",
      }),
      timelineEntry({
        id: "C-1#8",
        event_seq: 8,
        type: "decision_resolved",
        author: "assignment:A-9",
        author_role: "pm",
        author_display: "王熙凤",
        decision_id: "Q-8",
        decision_option: "merge",
      }),
    ],
  });
  render(
    <RecentConclusions detail={detail} projectId="p-1" onLocate={undefined} />,
  );
  const [system, pm] = [...document.querySelectorAll(".recent-conclusions li")];
  expect(system?.querySelector('[data-system-icon="gear"]')).toBeTruthy();
  expect(
    system?.querySelector(".employee-system")?.getAttribute("aria-hidden"),
  ).toBe("true");
  expect(system?.querySelector(".status-icon")).toBeTruthy();
  const link = within(system as HTMLElement).getByRole("link");
  expect(link.textContent).toBe("Q-7 系统 确认合并");
  expect(link.getAttribute("href")).toBe("#/p/p-1/cards/C-1?at=entry-C-1%239");
  expect(pm?.querySelector(".employee-system")).toBeNull();
  expect(pm?.textContent).toBe("Q-8 王熙凤 确认合并");
});
