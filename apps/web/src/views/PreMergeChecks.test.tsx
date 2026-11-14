// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type {
  CardDetail,
  NeedsDecision,
  NeedsPage,
  PreMergeCheckView,
} from "../api.js";
import { PRE_MERGE_COPY as COPY } from "../pre-merge-copy.js";
import { cardDetail, fakeClient } from "../testing/fixtures.js";
import { CardDetailPage } from "./CardDetailPage.js";
import { NeedsYouPage } from "./NeedsYouPage.js";

afterEach(cleanup);

const check = (
  label: string,
  status: PreMergeCheckView["status"],
  note: string | null = null,
): PreMergeCheckView => ({
  label,
  status,
  note,
  updated_at: "2026-11-12T00:00:00Z",
});
const merge = (checks: readonly PreMergeCheckView[]): NeedsDecision => ({
  id: "Q-7",
  question: "Merge C-1 into main?",
  context: "",
  why: "确认合并",
  status: "open",
  blocking: true,
  decider: "human",
  card_id: "C-1",
  affected_cards: ["C-1"],
  options: [
    { key: "merge", description: "合并", impact: "更新基线" },
    { key: "hold", description: "暂缓", impact: "等待" },
  ],
  recommended: "merge",
  waited_ms: 0,
  trigger: "merge_confirmation",
  category: "general",
  assignment_id: null,
  related_cards: [{ id: "C-1", title: "权限卡" }],
  merge_confirmation: {
    completion: {
      id: "D-9",
      work_item_id: "W-1",
      summary: "完成",
      subject: { kind: "git_head", value: "a".repeat(40) },
    },
    deliveries: [],
    reviews: [],
    known_gaps: [],
    pre_merge_checks: checks,
    blockers: checks
      .filter((c) => c.status !== "passed")
      .map((c) => `${c.label}：${c.status === "failed" ? "未通过" : "待核"}`),
  },
});
const needs = (q: NeedsDecision): NeedsPage => ({
  decisions: [q],
  human_actions: [],
  incidents: [],
});
const pending = [
  check("独立安全审核", "pending"),
  check("截图核对", "failed", "按钮颜色不对"),
];
const passed = [check("独立安全审核", "passed"), check("截图核对", "passed")];

test("C-264: Needs You disables merge and lists reasons while hold and return remain available", async () => {
  const recordDecision = vi.fn(async () => undefined);
  render(
    <NeedsYouPage
      client={fakeClient({
        needsYou: async () => needs(merge(pending)),
        recordDecision,
      })}
      projectId="p-1"
    />,
  );
  const status = await screen.findByRole("status", { name: "合并前置条件" });
  expect(within(status).getByText("等待中：")).toBeTruthy();
  expect(within(status).getByText("独立安全审核：待核")).toBeTruthy();
  expect(within(status).getByText("截图核对：未通过")).toBeTruthy();
  const confirm = screen.getByRole("button", { name: "确认合并", exact: true });
  expect(confirm.hasAttribute("disabled")).toBe(true);
  fireEvent.click(confirm);
  expect(recordDecision).not.toHaveBeenCalled();
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(
    screen
      .getByRole("button", { name: "暂不合并", exact: true })
      .hasAttribute("disabled"),
  ).toBe(false);
  expect(
    screen
      .getByRole("button", { name: "退回修改", exact: true })
      .hasAttribute("disabled"),
  ).toBe(false);
});

test("C-205: passed checks and standard steps fold away without adding a confirmation", async () => {
  const recordDecision = vi.fn(async () => undefined);
  render(
    <NeedsYouPage
      client={fakeClient({
        needsYou: async () => needs(merge(passed)),
        recordDecision,
      })}
      projectId="p-1"
    />,
  );
  await screen.findByRole("article", { name: "合并确认 Q-7" });
  expect(screen.queryByRole("status", { name: COPY.region })).toBeNull();
  const help = screen.getByText("操作说明").closest("details");
  if (!help) throw new Error("Missing help disclosure");
  expect(help.open).toBe(false);
  fireEvent.click(screen.getByText("操作说明"));
  expect(help?.open).toBe(true);
  expect(
    within(help).getByText(COPY.readySteps(false)[2] as string),
  ).toBeTruthy();
  expect(screen.queryByText(/请先不要确认/)).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "确认合并", exact: true }),
  );
  expect(screen.queryByRole("alertdialog")).toBeNull();
  await waitFor(() => expect(recordDecision).toHaveBeenCalled());
});

test("C-160: no checks means no extra prompt", async () => {
  render(
    <NeedsYouPage
      client={fakeClient({ needsYou: async () => needs(merge([])) })}
      projectId="p-1"
    />,
  );
  await screen.findByRole("button", { name: "确认合并", exact: true });
  expect(screen.queryByRole("status", { name: COPY.region })).toBeNull();
});

test("C-264: card detail shows the same blockers and disables merge", async () => {
  const base = cardDetail();
  const q = merge(pending);
  const detail: CardDetail = {
    ...base,
    card: { ...base.card, status: "awaiting_merge" },
    decisions: [q],
    merge_confirmations: [q],
  };
  const recordDecision = vi.fn(async () => undefined);
  render(
    <CardDetailPage
      client={fakeClient({ card: async () => detail, recordDecision })}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  const region = within(
    await screen.findByRole("region", { name: "合并处理" }),
  );
  expect(
    region.getByText(COPY.waitingTitle(["独立安全审核", "截图核对"])),
  ).toBeTruthy();
  fireEvent.click(
    region.getByRole("button", { name: "确认合并", exact: true }),
  );
  expect(
    region
      .getByRole("button", { name: "确认合并", exact: true })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(recordDecision).not.toHaveBeenCalled();
});

test.each(["needs", "card"])(
  "C-264: %s refreshes blockers on events without remounting",
  async (page) => {
    let q = merge(pending);
    const base = cardDetail();
    const client = fakeClient({
      needsYou: async () => needs(q),
      card: async () => ({
        ...base,
        card: { ...base.card, status: "awaiting_merge" },
        decisions: [q],
        merge_confirmations: [q],
      }),
    });
    const view = (revision: number) =>
      page === "needs" ? (
        <NeedsYouPage client={client} projectId="p-1" revision={revision} />
      ) : (
        <CardDetailPage
          client={client}
          projectId="p-1"
          cardId="C-1"
          revision={revision}
        />
      );
    const { rerender } = render(view(0));
    const button = () =>
      screen.getByRole("button", { name: "确认合并", exact: true });
    await screen.findByRole("status", { name: "合并前置条件" });
    expect(button().hasAttribute("disabled")).toBe(true);
    q = merge(passed);
    rerender(view(1));
    await waitFor(() => expect(button().hasAttribute("disabled")).toBe(false));
    expect(screen.getByText("检查都已通过")).toBeTruthy();
    q = merge(pending);
    rerender(view(2));
    await waitFor(() => expect(button().hasAttribute("disabled")).toBe(true));
  },
);

test("C-264: an older conclusion shows as pending and blocks merge", async () => {
  render(
    <NeedsYouPage
      client={fakeClient({
        needsYou: async () =>
          needs(
            merge([
              {
                ...check("独立安全审核", "pending", "已审核 a 版本"),
                stale: true,
              },
            ]),
          ),
      })}
      projectId="p-1"
    />,
  );
  const status = await screen.findByRole("status", { name: COPY.region });
  expect(
    within(status).getByText(COPY.waitingTitle(["独立安全审核"])),
  ).toBeTruthy();
  expect(within(status).getByText(new RegExp(COPY.staleNote))).toBeTruthy();
  expect(screen.queryByText(COPY.readyTitle)).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "确认合并", exact: true }),
  );
  expect(
    screen
      .getByRole("button", { name: "确认合并", exact: true })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

test.each(["needs", "card"])(
  "Q-440: %s has a separate override dialog requiring a reason",
  async (page) => {
    const q = merge(pending),
      base = cardDetail();
    const recordDecision = vi.fn(async () => undefined);
    const client = fakeClient({
      needsYou: async () => needs(q),
      card: async () => ({
        ...base,
        card: { ...base.card, status: "awaiting_merge" },
        decisions: [q],
        merge_confirmations: [q],
      }),
      recordDecision,
    });
    render(
      page === "needs" ? (
        <NeedsYouPage client={client} projectId="p-1" />
      ) : (
        <CardDetailPage client={client} projectId="p-1" cardId="C-1" />
      ),
    );
    const trigger = await screen.findByRole("button", {
      name: "仍要合并",
      exact: true,
    });
    fireEvent.click(trigger);
    let dialog = await screen.findByRole("alertdialog", {
      name: "仍要确认合并？",
    });
    expect(within(dialog).getByText("截图核对：未通过")).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(dialog).getByRole("button", { name: "先不确认" }),
      ),
    );
    fireEvent.keyDown(dialog, { key: "Escape", code: "Escape" });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    dialog = await screen.findByRole("alertdialog", { name: "仍要确认合并？" });
    const submit = within(dialog).getByRole("button", { name: "确认仍要合并" });
    expect(submit.hasAttribute("disabled")).toBe(true);
    fireEvent.click(submit);
    expect(recordDecision).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText("强行合并理由（必填）"), {
      target: { value: "已人工核实" },
    });
    fireEvent.click(submit);
    await waitFor(() =>
      expect(recordDecision).toHaveBeenCalledWith(
        "p-1",
        "Q-7",
        "merge",
        "",
        expect.any(String),
        false,
        undefined,
        "已人工核实",
      ),
    );
  },
);

test("C-264: a response missing the domain result cannot claim all checks passed", async () => {
  const q = merge([]);
  if (!q.merge_confirmation) throw new Error("Missing fixture");
  const { blockers: _blockers, ...unknown } = q.merge_confirmation;
  render(
    <NeedsYouPage
      client={fakeClient({
        needsYou: async () => needs({ ...q, merge_confirmation: unknown }),
      })}
      projectId="p-1"
    />,
  );
  const confirm = await screen.findByRole("button", {
    name: "确认合并",
    exact: true,
  });
  expect(confirm.hasAttribute("disabled")).toBe(true);
  expect(screen.getByText("检查状态尚未读取，请刷新")).toBeTruthy();
  expect(screen.queryByText("检查都已通过")).toBeNull();
});

test("Q-440: an uncertain override failure stays visible in the dialog and retries with the same key", async () => {
  const recordDecision = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("offline"))
    .mockResolvedValue(undefined);
  render(
    <NeedsYouPage
      client={fakeClient({
        needsYou: async () => needs(merge(pending)),
        recordDecision,
      })}
      projectId="p-1"
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "仍要合并", exact: true }),
  );
  const dialog = await screen.findByRole("alertdialog");
  const reason = within(dialog).getByLabelText("强行合并理由（必填）");
  fireEvent.change(reason, { target: { value: "已人工核实" } });
  const confirm = within(dialog).getByRole("button", { name: "确认仍要合并" });
  fireEvent.click(confirm);
  expect(await within(dialog).findByRole("alert")).toBeTruthy();
  expect((reason as HTMLTextAreaElement).value).toBe("已人工核实");
  fireEvent.click(confirm);
  await waitFor(() => expect(recordDecision).toHaveBeenCalledTimes(2));
  expect(recordDecision.mock.calls[1]).toEqual(recordDecision.mock.calls[0]);
});
