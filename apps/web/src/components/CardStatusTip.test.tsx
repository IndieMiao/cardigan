// @vitest-environment jsdom
import { type Card, deriveCardFields, WHY_MAX_LENGTH } from "@cardigan/domain";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { card } from "../testing/fixtures.js";
import { CardHoldTip, CardMergeTip, CardStatusTip } from "./CardStatusTip.js";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test.each([
  { name: "short", reason: "等待确认" },
  { name: "long", reason: "等待外部合成供应方回传验收记录。".repeat(60) },
  {
    name: "unicode",
    reason: `${"🧩".repeat(24)}${"核对完整记录。".repeat(60)}`,
  },
])(
  "the $name derived hold summary is replaced by its complete reason",
  async ({ reason }) => {
    const held: Card = {
      id: card.id as Card["id"],
      project_id: "p-1",
      title: card.title,
      goal: card.goal,
      acceptance_criteria: [],
      source: { kind: "quote", text: "合成暂停" },
      out_of_scope: [],
      related_cards: [],
      priority: 1,
      status: "in_progress",
      template: "dev",
      created_by: "human",
      created_at: card.created_at,
      hold: {
        reason,
        resume_condition: "完成核对",
        set_by: "human",
        set_at: card.created_at,
      },
    };
    const derived = deriveCardFields({
      card: held,
      work_items: [],
      deliveries: [],
      reviews: [],
      decisions: [],
      human_actions: [],
    });
    expect(Array.from(derived.why).length).toBeLessThanOrEqual(WHY_MAX_LENGTH);
    render(<CardStatusTip card={{ ...card, ...held, ...derived }} />);
    act(() => screen.getByRole("button", { name: "进行中" }).focus());
    const tip = await screen.findByRole("tooltip");
    expect([...tip.querySelectorAll("p")].map((p) => p.textContent)).toEqual([
      `已暂停：${reason}`,
    ]);
  },
);

test.each([
  { why: "等待 C-1", detail: "等待 C-10" },
  { why: "核对记录".repeat(10), detail: "等待另一项工作" },
])(
  "retains a distinct reason when full replacement is unavailable: $why",
  async ({ why, detail }) => {
    render(
      <CardStatusTip
        card={{
          ...card,
          why,
          waiting_on: [{ kind: "blocked", ref: "W-1", label: detail }],
        }}
      />,
    );
    act(() => screen.getByRole("button", { name: "进行中" }).focus());
    const tip = await screen.findByRole("tooltip");
    expect([...tip.querySelectorAll("p")].map((p) => p.textContent)).toEqual([
      why,
      detail,
    ]);
  },
);

test.each(["hover", "focus"])(
  "%s exposes review, dependencies, blocking and human work in the state tooltip",
  async (mode) => {
    const messages = [
      "等待完成申请",
      "等 C-7、C-8",
      "接口验证未完成",
      "请负责人确认验收结果",
    ];
    const { container } = render(
      <CardStatusTip
        card={{
          ...card,
          status: "review",
          why: messages[0] ?? "",
          dependency: {
            predecessors: [],
            successors: [],
            waiting_on: ["C-7", "C-8"],
            critical_path_length: 2,
          },
          waiting_on: [
            { kind: "blocked", ref: "W-1", label: messages[2] ?? "" },
            { kind: "human_action", ref: "H-1", label: messages[3] ?? "" },
          ],
        }}
      />,
    );
    expect(container.textContent).toBe("审核中");
    const trigger = screen.getByRole("button", { name: "审核中" });
    if (mode === "focus") act(() => trigger.focus());
    else {
      vi.useFakeTimers();
      fireEvent.pointerMove(trigger, { pointerType: "mouse" });
      act(() => vi.advanceTimersByTime(1000));
      vi.useRealTimers();
    }
    const tip = await screen.findByRole("tooltip");
    for (const text of messages)
      expect(within(tip).getByText(text)).toBeTruthy();
    expect(trigger.getAttribute("aria-describedby")).toBe(tip.id);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
    expect(container.textContent).toBe("审核中");
  },
);

test("pause text stays complete and literal without rendering a detail box on the card", async () => {
  const reason =
    '<script>alert("fixture")</script>\n' + "等待完整验收记录。".repeat(24);
  const condition = "全部核对通过后恢复。".repeat(24);
  const { container } = render(
    <CardHoldTip
      card={{
        ...card,
        hold: {
          reason,
          resume_condition: condition,
          set_by: "human",
          set_at: card.created_at,
        },
      }}
    />,
  );
  expect(container.textContent).toBe("已暂停");
  expect(container.querySelector("p,.card-hold-details")).toBeNull();
  act(() => screen.getByRole("button", { name: "已暂停" }).focus());
  const tip = await screen.findByRole("tooltip");
  expect(tip.textContent).toContain(reason);
  expect(tip.textContent).toContain(condition);
  expect(tip.querySelector("script")).toBeNull();
});

test("merge labels keep batch navigation and put queue/protection detail in tips", async () => {
  const view = render(
    <CardMergeTip
      projectId="p-1"
      card={{
        ...card,
        merge_stage: { stage: "held_by_window", protecting_card_id: "C-3" },
      }}
    />,
  );
  expect(view.container.textContent).toBe("等待合并窗口");
  act(() => screen.getByRole("button", { name: "等待合并窗口" }).focus());
  expect((await screen.findByRole("tooltip")).textContent).toContain(
    "等待合并窗口：保护 C-3",
  );
  view.unmount();
  render(
    <CardMergeTip
      projectId="p-1"
      card={{
        ...card,
        merge_stage: { stage: "batch_checking", batch_id: "MB-9" },
      }}
    />,
  );
  const link = screen.getByRole("link", { name: /MB-9.*批次检查中/ });
  expect(link.getAttribute("href")).toBe("#/p/p-1/merge-batches/MB-9");
  act(() => link.focus());
  expect((await screen.findByRole("tooltip")).textContent).toContain(
    "MB-9 批次检查中",
  );
});
