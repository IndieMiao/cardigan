// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { AuthorView, ExecutionAssignment, NeedsPage } from "../api.js";
import { DEFAULT_CARD_DISPLAY } from "../card-display.js";
import {
  attachment,
  card,
  cardDetail,
  fakeClient,
  timelineEntry,
} from "../testing/fixtures.js";
import { ExecutionPage } from "../views/ExecutionPage.js";
import { NeedsYouPage } from "../views/NeedsYouPage.js";
import { AttachmentGrid } from "./AttachmentGrid.js";
import { Board } from "./Board.js";
import { CardRecords } from "./CardRecords.js";
import { CardSidebar } from "./CardSidebar.js";
import { EmployeeIdentity } from "./EmployeeIdentity.js";
import { TimelineActor } from "./TimelineHeader.js";

const employee = {
  id: "E-17",
  name: "林舟",
  title: "工程师",
  bio: "负责实现与维护",
  role_id: "coder",
  avatar: "/avatars/v1/guan-yu/head-64.webp",
};
const identity: AuthorView = {
  employee,
  author: "assignment:A-1",
  author_role: "coder",
  author_display: employee.name,
};
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.location.hash = "";
});

test("placeholder colors follow the existing light/dark tokens and profiles sit above the lightbox", () => {
  const css = readFileSync(
    new NodeURL("../styles.css", import.meta.url),
    "utf8",
  );
  const identityCss = css.slice(css.indexOf("/* P2-V V5:"));
  expect(identityCss).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
  const palette = [
    "accent",
    "status-progress",
    "status-review",
    "status-done",
    "status-wait",
  ];
  const dark = css.slice(css.indexOf("@media (prefers-color-scheme: dark)"));
  for (const token of palette) {
    expect(identityCss).toContain(`var(--${token})`);
    expect(dark).toContain(`--${token}:`);
  }
  expect(identityCss).toContain("z-index: 210");
});

test("loads a same-origin avatar, falls back on error, and retries a changed path", () => {
  const { container, rerender } = render(<EmployeeIdentity {...identity} />);
  const img = container.querySelector("img");
  expect(img?.getAttribute("src")).toBe("/avatars/v1/guan-yu/head-64.webp");
  expect(screen.getByText("工程师")).toBeTruthy();
  if (!img) throw new Error("Missing avatar");
  fireEvent.error(img);
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector(".employee-avatar")?.textContent).toBe("林");
  rerender(
    <EmployeeIdentity employee={{ ...employee, avatar: "/avatars/new.png" }} />,
  );
  expect(container.querySelector("img")?.getAttribute("src")).toBe(
    "/avatars/new.png",
  );
});

test("library avatars select 64/128 sources with 2x images, including the 64px profile avatar", () => {
  const { container, rerender } = render(<EmployeeIdentity {...identity} />);
  const base = "/avatars/v1/guan-yu/head-";
  expect(container.querySelector("img")?.getAttribute("srcset")).toBe(
    `${base}64.webp 1x, ${base}128.webp 2x`,
  );
  rerender(<EmployeeIdentity {...identity} avatarSize={128} />);
  expect(container.querySelector("img")?.getAttribute("src")).toBe(
    `${base}128.webp`,
  );
  expect(container.querySelector("img")?.getAttribute("srcset")).toBe(
    `${base}128.webp 1x, ${base}256.webp 2x`,
  );
  fireEvent.click(screen.getByRole("button", { name: "林舟的员工卡片" }));
  const profile = screen.getByRole("dialog");
  const image = profile.querySelector("img");
  expect(image?.getAttribute("src")).toBe(`${base}64.webp`);
  expect(image?.getAttribute("srcset")).toBe(
    `${base}64.webp 1x, ${base}128.webp 2x`,
  );
  expect(
    profile.querySelector<HTMLElement>(".employee-avatar")?.style.width,
  ).toBe("64px");
  if (!image) throw new Error("Missing profile avatar");
  fireEvent.error(image);
  expect(profile.querySelector("img")).toBeNull();
  expect(profile.querySelector(".employee-avatar")?.textContent).toBe("林");
});

test("uploaded avatars keep the authenticated URL at both sizes", () => {
  const path = `/api/avatars/${"a".repeat(64)}`;
  const { container } = render(
    <EmployeeIdentity employee={{ ...employee, avatar: path }} />,
  );
  expect(container.querySelector("img")?.getAttribute("src")).toBe(path);
  expect(container.querySelector("img")?.getAttribute("srcset")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "林舟的员工卡片" }));
  expect(
    screen.getByRole("dialog").querySelector("img")?.getAttribute("src"),
  ).toBe(path);
});

test("missing avatar uses a stable employee color and Unicode initial; missing employee uses a role placeholder", () => {
  const { container, rerender } = render(
    <EmployeeIdentity employee={{ ...employee, name: "𠮷田", avatar: null }} />,
  );
  const avatar = container.querySelector(".employee-avatar");
  expect(avatar?.textContent).toBe("𠮷");
  const color = avatar?.className;
  rerender(
    <EmployeeIdentity
      employee={{ ...employee, name: "新名字", avatar: null }}
      showTitle={false}
    />,
  );
  expect(container.querySelector(".employee-avatar")?.className).toBe(color);
  expect(screen.queryByText("工程师")).toBeNull();
  rerender(<EmployeeIdentity employee={null} author_role="reviewer" />);
  expect(screen.getByText("未命名的 reviewer")).toBeTruthy();
  expect(container.querySelector(".employee-avatar")?.textContent).toBe("R");
});

test.each([
  "https://example.com/a.png",
  "//example.com/a.png",
  "/\\example.com/a.png",
  "/\n/evil.png",
  "data:image/png;base64,YQ==",
  "avatar:one",
])("never creates an image for %s", (avatar) => {
  const { container } = render(
    <EmployeeIdentity employee={{ ...employee, avatar }} />,
  );
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector(".employee-avatar")?.textContent).toBe("林");
});

test("hover and click reveal a profile, Escape/outside dismiss it, and keyboard focus returns", async () => {
  render(
    <>
      <EmployeeIdentity {...identity} />
      <button type="button">其他</button>
    </>,
  );
  screen.getByRole("button", { name: "其他" }).focus();
  const trigger = screen.getByRole("button", { name: "林舟的员工卡片" });
  vi.useFakeTimers();
  fireEvent.pointerEnter(trigger);
  act(() => vi.advanceTimersByTime(1000));
  vi.useRealTimers();
  const profile = await screen.findByRole("dialog", { name: "林舟的员工卡片" });
  expect(profile.textContent).toContain("负责实现与维护");
  expect(profile.textContent).toContain("角色：coder");
  expect(profile.querySelector("a")).toBeNull();
  expect(within(profile).queryByRole("button")).toBeNull();
  expect(profile.textContent).not.toContain("关闭");
  fireEvent.pointerLeave(trigger);
  fireEvent.pointerEnter(profile);
  await new Promise((resolve) => setTimeout(resolve, 220));
  expect(screen.getByRole("dialog")).toBeTruthy();
  fireEvent.pointerLeave(profile);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "其他" }),
  );
  trigger.focus();
  fireEvent.click(trigger);
  expect(await screen.findByRole("dialog")).toBeTruthy();
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  await screen.findByRole("dialog");
  await new Promise((resolve) => setTimeout(resolve, 10));
  fireEvent.pointerDown(screen.getByRole("button", { name: "其他" }), {
    button: 0,
    pointerType: "mouse",
  });
  fireEvent.click(screen.getByRole("button", { name: "其他" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("hover waits a full second, leaving cancels it, and returning starts a fresh delay", () => {
  vi.useFakeTimers();
  render(<EmployeeIdentity {...identity} />);
  const trigger = screen.getByRole("button", { name: "林舟的员工卡片" });
  fireEvent.pointerEnter(trigger);
  act(() => vi.advanceTimersByTime(999));
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.pointerLeave(trigger);
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.pointerEnter(trigger);
  act(() => vi.advanceTimersByTime(999));
  expect(screen.queryByRole("dialog")).toBeNull();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.getByRole("dialog", { name: "林舟的员工卡片" })).toBeTruthy();
});

test("opening a second hover profile immediately dismisses the first", () => {
  vi.useFakeTimers();
  render(
    <>
      <EmployeeIdentity {...identity} />
      <EmployeeIdentity employee={{ ...employee, id: "E-18", name: "李青" }} />
    </>,
  );
  fireEvent.pointerEnter(
    screen.getByRole("button", { name: "林舟的员工卡片" }),
  );
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.getByRole("dialog", { name: "林舟的员工卡片" })).toBeTruthy();
  // Keep the first hovered: the second must dismiss it independently of leave timers.
  fireEvent.pointerEnter(
    screen.getByRole("button", { name: "李青的员工卡片" }),
  );
  act(() => vi.advanceTimersByTime(999));
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(screen.queryByRole("dialog", { name: "李青的员工卡片" })).toBeNull();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.queryByRole("dialog", { name: "林舟的员工卡片" })).toBeNull();
  expect(screen.getByRole("dialog", { name: "李青的员工卡片" })).toBeTruthy();
});

test("click opens immediately, cancels pending hover and keeps the profile pinned", () => {
  vi.useFakeTimers();
  render(
    <>
      <EmployeeIdentity {...identity} />
      <EmployeeIdentity employee={{ ...employee, id: "E-18", name: "李青" }} />
    </>,
  );
  const trigger = screen.getByRole("button", { name: "林舟的员工卡片" });
  fireEvent.pointerEnter(trigger);
  act(() => vi.advanceTimersByTime(500));
  fireEvent.click(trigger);
  expect(screen.getByRole("dialog", { name: "林舟的员工卡片" })).toBeTruthy();
  fireEvent.pointerLeave(trigger);
  fireEvent.pointerEnter(
    screen.getByRole("button", { name: "李青的员工卡片" }),
  );
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.getAllByRole("dialog")).toHaveLength(2);
  fireEvent.click(trigger);
  expect(screen.queryByRole("dialog", { name: "林舟的员工卡片" })).toBeNull();
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.queryByRole("dialog", { name: "林舟的员工卡片" })).toBeNull();
});

test("unmount cancels pending hover and releases the active profile", () => {
  vi.useFakeTimers();
  const first = render(<EmployeeIdentity {...identity} />);
  fireEvent.pointerEnter(
    screen.getByRole("button", { name: "林舟的员工卡片" }),
  );
  first.unmount();
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.queryByRole("dialog")).toBeNull();
  const second = render(<EmployeeIdentity {...identity} />);
  fireEvent.pointerEnter(
    screen.getByRole("button", { name: "林舟的员工卡片" }),
  );
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.getByRole("dialog")).toBeTruthy();
  second.unmount();
  render(<EmployeeIdentity {...identity} />);
  fireEvent.pointerEnter(
    screen.getByRole("button", { name: "林舟的员工卡片" }),
  );
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
});

test.each(["open", "closing", "restoring focus"] as const)(
  "unmount while %s leaves no focus restoration timer",
  async (phase) => {
    vi.useFakeTimers();
    const view = render(
      <StrictMode>
        <EmployeeIdentity {...identity} />
      </StrictMode>,
    );
    const trigger = screen.getByRole("button", { name: "林舟的员工卡片" });
    trigger.focus();
    fireEvent.click(trigger);
    await act(() => vi.runAllTimersAsync());
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(vi.getTimerCount()).toBe(0);

    if (phase !== "open") {
      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.queryByRole("dialog")).toBeNull();
      // Radix defers onCloseAutoFocus until after its effect cleanup.
      expect(vi.getTimerCount()).toBe(1);
      if (phase === "restoring focus") {
        act(() => vi.advanceTimersByTime(0));
        // The component's second focus attempt is now pending.
        expect(vi.getTimerCount()).toBe(1);
      }
    }

    view.unmount();
    // Let Radix finish its deferred cleanup. This must not enqueue a new
    // component timer after EmployeeIdentity's cleanup has already run.
    act(() => vi.advanceTimersByTime(0));
    expect(vi.getTimerCount()).toBe(0);
    expect(() => act(() => vi.runAllTimers())).not.toThrow();
  },
);

test("repeated closes restore focus in StrictMode without leaving timers", async () => {
  vi.useFakeTimers();
  const view = render(
    <StrictMode>
      <EmployeeIdentity {...identity} />
      <button type="button">其他</button>
    </StrictMode>,
  );
  const trigger = screen.getByRole("button", { name: "林舟的员工卡片" });
  const other = screen.getByRole("button", { name: "其他" });

  for (const keepOtherFocus of [false, true, false]) {
    fireEvent.click(trigger);
    await act(() => vi.runAllTimersAsync());
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    if (keepOtherFocus) other.focus();
    else (document.activeElement as HTMLElement | null)?.blur();
    await act(() => vi.runAllTimersAsync());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(keepOtherFocus ? other : trigger);
    expect(vi.getTimerCount()).toBe(0);
  }
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

test("outside clicks close the click-opened profile and return focus to the avatar unless another control takes it", async () => {
  render(
    <>
      <EmployeeIdentity {...identity} />
      <p>空白区域</p>
      <button type="button">其他</button>
    </>,
  );
  const trigger = screen.getByRole("button", { name: "林舟的员工卡片" });
  const blank = screen.getByText("空白区域");
  const other = screen.getByRole("button", { name: "其他" });
  // Mirrors the browser: pointerdown, then the default focus move, then click.
  const clickOutside = (target: HTMLElement, focusable: boolean) => {
    fireEvent.pointerDown(target, { button: 0, pointerType: "mouse" });
    if (focusable) target.focus();
    else (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.mouseDown(target);
    fireEvent.mouseUp(target);
    fireEvent.click(target);
  };
  const open = async () => {
    trigger.focus();
    fireEvent.click(trigger);
    await screen.findByRole("dialog");
    await new Promise((resolve) => setTimeout(resolve, 10));
  };

  await open();
  clickOutside(blank, false);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(document.activeElement).toBe(trigger);

  await open();
  clickOutside(other, true);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(document.activeElement).toBe(other);
});

test("compact profile lays out name, title, bio and role without empty rows", async () => {
  const { rerender } = render(<EmployeeIdentity {...identity} />);
  fireEvent.click(screen.getByRole("button", { name: "林舟的员工卡片" }));
  let profile = await screen.findByRole("dialog");
  const body = profile.querySelector(".employee-card-body");
  expect(profile.firstElementChild?.classList).toContain("employee-avatar");
  expect(body?.querySelector(".employee-card-heading")?.textContent).toBe(
    "林舟工程师",
  );
  expect(body?.querySelector(".employee-card-bio")?.textContent).toBe(
    "负责实现与维护",
  );
  expect(
    [...(body?.querySelectorAll(".employee-card-meta") ?? [])].map(
      (node) => node.textContent,
    ),
  ).toEqual(["角色：coder"]);

  rerender(
    <EmployeeIdentity
      employee={{
        ...employee,
        title: "",
        bio: "  ",
        avatar: null,
        role_id: undefined,
      }}
      author_role="reviewer"
      metadata="2 分钟前"
    />,
  );
  profile = screen.getByRole("dialog");
  expect(profile.querySelector("img")).toBeNull();
  expect(profile.querySelector(".employee-avatar")?.textContent).toBe("林");
  expect(profile.querySelector(".employee-title")).toBeNull();
  expect(profile.querySelector(".employee-card-bio")).toBeNull();
  expect(profile.textContent).not.toContain("暂无简介");
  expect(
    [...profile.querySelectorAll(".employee-card-body > *")].map(
      (node) => node.textContent,
    ),
  ).toEqual(["林舟", "角色：reviewer", "2 分钟前"]);
  for (const node of profile.querySelectorAll(".employee-card-body > *"))
    expect(node.textContent?.trim()).not.toBe("");

  rerender(
    <EmployeeIdentity
      employee={{ ...employee, bio: undefined, role_id: undefined }}
    />,
  );
  expect(screen.getByRole("dialog").textContent).toBe(
    "林舟工程师角色：未知角色",
  );
});

test("profile CSS is a compact horizontal card that clamps the bio to two lines", () => {
  const css = readFileSync(
    new NodeURL("../styles.css", import.meta.url),
    "utf8",
  );
  const rule = (selector: string) => {
    const start = css.indexOf(`${selector} {`);
    return css.slice(start, css.indexOf("}", start));
  };
  const card = rule(".employee-card");
  expect(card).not.toContain("flex-direction: column");
  const width = Number(card.match(/\bwidth: (\d+)px/)?.[1]);
  expect(width).toBeGreaterThanOrEqual(280);
  expect(width).toBeLessThanOrEqual(320);
  expect(rule(".employee-card-bio")).toContain("-webkit-line-clamp: 2");
});

test.each(["comment", "delivery", "review"] as const)(
  "%s timeline authors share the employee profile",
  async (type) => {
    render(<TimelineActor entry={timelineEntry({ ...identity, type })} />);
    fireEvent.click(screen.getByRole("button", { name: "林舟的员工卡片" }));
    expect((await screen.findByRole("dialog")).textContent).toContain(
      "负责实现与维护",
    );
  },
);

test("delivery/review records, attachment uploaders and next owners use the same identity", () => {
  const delivery = cardDetail().deliveries[0];
  if (!delivery) throw new Error("Missing delivery");
  const detail = cardDetail({
    card: {
      ...card,
      next_owners: [{ ...identity, kind: "assignment", ref: "A-1" }],
    },
    deliveries: [{ ...delivery, ...identity }],
    reviews: [
      {
        ...identity,
        id: "V-1",
        delivery_id: "V-1",
        work_item_id: "W-2",
        verdict: "pass",
        blocking: false,
      },
    ],
  });
  render(
    <>
      <CardRecords detail={detail} projectId="p-1" onLocate={undefined} />
      <AttachmentGrid
        attachments={[
          attachment({ ...identity, mime: "text/plain", inline: false }),
        ]}
      />
      <CardSidebar detail={detail} projectId="p-1" cardId="C-1" />
    </>,
  );
  expect(
    screen.getAllByRole("button", { name: "林舟的员工卡片" }),
  ).toHaveLength(4);
});

test("board shows three owner avatars plus overflow; profile click does not open the card", () => {
  const openCard = vi.fn();
  const owners = [1, 2, 3, 4, 5].map((n) => ({
    ...identity,
    employee: { ...employee, id: `E-${n}`, name: `员工${n}` },
  }));
  render(
    <Board
      cards={[{ ...card, produce_owners: owners }]}
      projectId="p-1"
      lanes={{}}
      onLaneChange={() => {}}
      display={DEFAULT_CARD_DISPLAY}
      onOpenCard={openCard}
    />,
  );
  const group = screen.getByRole("group", { name: "参与员工" });
  expect(
    within(group).getAllByRole("button", { name: /的员工卡片$/ }),
  ).toHaveLength(3);
  expect(within(group).getByText("+2")).toBeTruthy();
  const trigger = within(group).getByRole("button", {
    name: "员工1的员工卡片",
  });
  expect(trigger.closest("a")).toBeNull();
  fireEvent.click(trigger);
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(openCard).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("link", { name: /准备发布/ }));
  expect(openCard).toHaveBeenCalledOnce();
});

test("Needs You decisions, human actions and incidents display their employee", async () => {
  const data: NeedsPage = {
    decisions: [
      {
        ...identity,
        id: "Q-1",
        question: "继续？",
        context: "背景",
        status: "open",
        blocking: true,
        decider: "human",
        options: [],
        recommended: "go",
        card_id: "C-1",
        affected_cards: [],
        why: "继续？",
        waited_ms: 0,
        trigger: null,
        category: "general",
        assignment_id: null,
        related_cards: [],
        merge_confirmation: null,
      },
    ],
    human_actions: [
      {
        ...identity,
        id: "H-1",
        card_id: "C-1",
        why: "连接设备",
        instructions: "连接",
        expected_return: "结果",
        due: null,
        waited_ms: 0,
        blocked_work_items: [],
      },
    ],
    incidents: [
      {
        ...identity,
        id: "A-1",
        role_id: "coder",
        runtime_state: "lost",
        card_id: "C-1",
        waited_ms: 0,
      },
    ],
  };
  render(
    <NeedsYouPage
      client={fakeClient({ needsYou: async () => data })}
      projectId="p-1"
    />,
  );
  expect(
    await screen.findAllByRole("button", { name: "林舟的员工卡片" }),
  ).toHaveLength(3);
});

test("execution assignment identity opens the profile without expanding its row", async () => {
  const assignment: ExecutionAssignment = {
    ...identity,
    id: "A-1",
    role_id: "coder",
    role_version: 1,
    status: "active",
    runtime_state: "idle",
    machine_id: "local",
    standing_mode: null,
    card_id: "C-1",
    card_status: "in_progress",
    work_item_id: "W-1",
    worktree_path: null,
    branch: null,
    session_ref: null,
    runtime_ref: { terminal_ref: "fixture", runtime_machine: "local" },
    last_mcp_activity_at: null,
    cursors: [],
  };
  render(
    <ExecutionPage
      client={fakeClient({
        execution: async () => ({
          assignments: [assignment],
          runs: [],
          machines: [],
        }),
      })}
      projectId="p-1"
    />,
  );
  const trigger = await screen.findByRole("button", { name: "林舟的员工卡片" });
  fireEvent.click(trigger);
  expect(await screen.findByRole("dialog")).toBeTruthy();
  // C-75: the profile opens on its own; the execution detail drawer does not.
  expect(screen.queryByRole("dialog", { name: /详情$/ })).toBeNull();
});
