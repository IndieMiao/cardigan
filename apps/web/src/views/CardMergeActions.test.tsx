// @vitest-environment jsdom

import { DECISION_OTHER_OPTION, decisionOtherOption } from "@cardigan/domain";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ApiError, type CardDetail, type NeedsDecision } from "../api.js";
import { cardDetail, fakeClient } from "../testing/fixtures.js";
import { selectMenu } from "../testing/menu.js";
import { CardDetailPage } from "./CardDetailPage.js";

afterEach(cleanup);

test("C-178: merge blockers show the reason and local start time even without a confirmation", async () => {
  const base = cardDetail();
  const started_at = "2026-01-01T08:25:00.000Z";
  const blocker = {
    key: "H-25",
    label: "H-25",
    detail: "轮换合并凭据",
    started_at,
  };
  const detail = {
    ...base,
    card: {
      ...base.card,
      status: "awaiting_merge",
      merge_check_blockers: [blocker],
    },
    merge_confirmations: [],
    timeline: [
      {
        id: "C-1#100",
        card_id: "C-1",
        event_seq: 100,
        type: "system" as const,
        author: "system",
        body: "UTC fallback",
        refs: [],
        mentions: [],
        retracted: false,
        created_at: started_at,
        event_type: "merge_check_blocked",
        merge_check_blocker: blocker,
      },
    ],
  };
  render(
    <CardDetailPage
      client={fakeClient({ card: async () => detail })}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  const region = within(
    await screen.findByRole("region", { name: "合并处理" }),
  );
  const since = new Date(started_at).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const message = `合并检查未开始：被 H-25 挡住（自 ${since} 起）：轮换合并凭据`;
  expect(region.getByText(message)).toBeTruthy();
  expect(screen.getAllByText(message)).toHaveLength(2);
  expect(screen.queryByText("UTC fallback")).toBeNull();
});

function fixture(confirmed = false): CardDetail {
  const detail = cardDetail();
  const q: NeedsDecision = {
    id: "Q-115",
    question: "确认合并",
    context: "",
    why: "合并检查失败或超时，可退回修改或重新检查",
    status: confirmed ? "resolved" : "open",
    blocking: true,
    decider: "human",
    card_id: "C-1",
    affected_cards: [],
    waited_ms: 0,
    trigger: "merge_confirmation",
    category: "general",
    assignment_id: null,
    related_cards: [{ id: "C-1", title: "敏感卡" }],
    options: [
      { key: "merge", description: "合并", impact: "更新基线" },
      { key: "hold", description: "暂缓", impact: "等待" },
      { key: "request_changes", description: "退回修改", impact: "返工" },
    ],
    recommended: "merge",
    merge_confirmation: {
      blockers: [],
      completion: {
        id: "D-115",
        work_item_id: "W-1",
        summary: "等待合并",
        subject: { kind: "git_head", value: "a".repeat(40) },
      },
      deliveries: [],
      reviews: [],
      known_gaps: [],
      merge_gate_enabled: true,
      merge_check: {
        completion_id: "D-115",
        attempt_id: "attempt-115",
        candidate_sha: "b".repeat(40),
        tree_sha: "c".repeat(40),
        status: "failed",
        checks: [{ name: "test", status: "failed" }],
        summary: "断言失败",
        updated_at: "2026-01-01T00:00:00Z",
      },
    },
  };
  return {
    ...detail,
    card: { ...detail.card, status: "awaiting_merge", sensitive: true },
    decisions: [q],
    merge_confirmations: [q],
  };
}

test.each(["merge", "hold", "request_changes", "recheck"] as const)(
  "C-115: sensitive card detail performs %s and refreshes the current controls",
  async (option) => {
    let detail = fixture();
    const done = () => {
      detail = { ...detail, merge_confirmations: [] };
      return Promise.resolve();
    };
    const recordDecision = vi.fn(done),
      recheckMerge = vi.fn(done),
      read = vi.fn(async () => detail);
    render(
      <CardDetailPage
        client={fakeClient({ card: read, recordDecision, recheckMerge })}
        projectId="p-1"
        cardId="C-1"
      />,
    );
    // C-697: the controls are the “下一步” panel; words go in a dialog.
    const panel = await screen.findByRole("region", { name: "下一步" });
    const controls = within(panel);
    expect(controls.getByText("断言失败")).toBeTruthy();
    const label = {
      merge: "确认合并",
      hold: "暂不合并",
      request_changes: "退回修改",
      recheck: "重新检查",
    }[option];
    // A failed check puts 重新检查 first; the rest sit in ⋯.
    if (option === "merge") await selectMenu(/^更多合并操作$/, "确认合并");
    else if (option === "hold") await selectMenu(/^更多合并操作$/, "暂不合并…");
    else fireEvent.click(controls.getByRole("button", { name: label }));
    if (option === "request_changes") {
      const dialog = within(await screen.findByRole("dialog"));
      expect(
        dialog
          .getByRole("button", { name: "确认退回修改" })
          .hasAttribute("disabled"),
      ).toBe(true);
      fireEvent.change(dialog.getByLabelText("Q-115 退回原因"), {
        target: { value: "请修复断言失败" },
      });
      fireEvent.click(dialog.getByRole("button", { name: "确认退回修改" }));
    }
    if (option === "hold") {
      const dialog = within(await screen.findByRole("dialog"));
      expect(
        dialog
          .getByRole("button", { name: "登记暂缓" })
          .hasAttribute("disabled"),
      ).toBe(true);
      fireEvent.change(dialog.getByLabelText("暂缓原因（必填）"), {
        target: { value: "等待核对" },
      });
      fireEvent.change(
        dialog.getByLabelText("暂缓到期时间（可选，不填按项目默认时长）"),
        {
          target: { value: "2035-01-01T12:30" },
        },
      );
      fireEvent.click(dialog.getByRole("button", { name: "登记暂缓" }));
    }
    if (option === "recheck")
      expect(recheckMerge).toHaveBeenCalledWith(
        "p-1",
        "C-1",
        "D-115",
        expect.any(String),
      );
    else
      expect(recordDecision).toHaveBeenCalledWith(
        "p-1",
        "Q-115",
        option,
        option === "request_changes"
          ? "请修复断言失败"
          : option === "hold"
            ? "等待核对"
            : "",
        expect.any(String),
        ...(option === "hold"
          ? [false, new Date("2035-01-01T12:30").toISOString()]
          : []),
      );
    await waitFor(() =>
      expect(screen.queryByRole("group", { name: "合并处理操作" })).toBeNull(),
    );
    expect(read).toHaveBeenCalledTimes(2);
  },
);

test("C-115: confirmed failure exposes return/recheck only, and stale targets keep the error visible", async () => {
  const detail = fixture(true);
  const recheckMerge = vi.fn(async () => {
    throw new ApiError(409, "stale_target", "完成申请已更新，请刷新后重试");
  });
  const read = vi.fn(async () => detail);
  render(
    <CardDetailPage
      client={fakeClient({ card: read, recheckMerge })}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  const controls = within(
    await screen.findByRole("region", { name: "下一步" }),
  );
  expect(controls.queryByRole("button", { name: "确认合并" })).toBeNull();
  expect(controls.queryByRole("button", { name: "暂不合并" })).toBeNull();
  expect(controls.getByRole("button", { name: "退回修改" })).toBeTruthy();
  fireEvent.click(controls.getByRole("button", { name: "重新检查" }));
  expect(await screen.findByText(/完成申请已更新/)).toBeTruthy();
  expect(read).toHaveBeenCalledTimes(1);
  expect(recheckMerge).toHaveBeenCalledWith(
    "p-1",
    "C-1",
    "D-115",
    expect.any(String),
  );
});

test("C-115: a verified noop keeps human confirmation without claiming a passed or queued check", async () => {
  const detail = fixture();
  const q = detail.merge_confirmations?.[0];
  if (!q?.merge_confirmation) throw new Error("Missing confirmation");
  const merge = q.merge_confirmation;
  const client = fakeClient({
    card: async () => ({
      ...detail,
      merge_confirmations: [
        {
          ...q,
          merge_confirmation: {
            ...merge,
            merge_noop: true,
            merge_check: null,
          },
        },
      ],
    }),
  });
  render(<CardDetailPage client={client} projectId="p-1" cardId="C-1" />);
  const controls = within(
    await screen.findByRole("region", { name: "下一步" }),
  );
  expect(controls.getByText(/交付均在基线中/)).toBeTruthy();
  expect(controls.getByRole("button", { name: "确认合并" })).toBeTruthy();
  expect(controls.queryByRole("region", { name: "合并检查" })).toBeNull();
  expect(controls.queryByRole("button", { name: "重新检查" })).toBeNull();
});

test("C-182: the card merge block shows an accessible snoozed tag, reason and local expiry", async () => {
  const detail = fixture();
  const until = "2035-01-01T04:30:00.000Z";
  const snoozed = {
    ...detail,
    merge_confirmations: detail.merge_confirmations?.map((q) => ({
      ...q,
      status: "snoozed",
      snooze: {
        reason: "等待核对",
        until,
        at: "2035-01-01T00:30:00.000Z",
        by: "human",
      },
    })),
  };
  render(
    <CardDetailPage
      client={fakeClient({ card: async () => snoozed })}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  const status = await screen.findByRole("region", { name: "下一步" });
  expect(status.textContent).toContain("已暂缓至");
  expect(status.querySelector("time")?.dateTime).toBe(until);
  expect(status.textContent).toContain("等你处理");
  expect(screen.getByText("暂缓原因：等待核对")).toBeTruthy();
});

test("C-196: a rejected hold shows the cap without the preference key and preserves the reason", async () => {
  const recordDecision = vi
    .fn()
    .mockRejectedValue(
      new ApiError(
        400,
        "validation_failed",
        "暂缓到期时间距现在不能超过 90 分钟（merge-confirm-snooze-max）",
      ),
    );
  render(
    <CardDetailPage
      client={fakeClient({ card: async () => fixture(), recordDecision })}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  await screen.findByRole("region", { name: "下一步" });
  await selectMenu(/^更多合并操作$/, "暂不合并…");
  const dialog = await screen.findByRole("dialog");
  const controls = within(dialog);
  fireEvent.change(controls.getByLabelText("暂缓原因（必填）"), {
    target: { value: "等待核对" },
  });
  fireEvent.click(controls.getByRole("button", { name: "登记暂缓" }));
  // The failure stays in the dialog with the reason kept.
  const alert = (await controls.findByRole("alert")).textContent ?? "";
  expect(alert).toContain(
    "暂缓到期时间距现在不能超过 90 分钟（可在项目设置的“合并确认最长暂缓时长”中调整）",
  );
  expect(alert).not.toContain("merge-confirm-snooze-max");
  expect(
    (controls.getByLabelText("暂缓原因（必填）") as HTMLInputElement).value,
  ).toBe("等待核对");
});

function ready(): CardDetail {
  const detail = fixture();
  const q = detail.merge_confirmations?.[0];
  if (!q?.merge_confirmation?.merge_check) throw new Error("Missing fixture");
  const passed: NeedsDecision = {
    ...q,
    merge_confirmation: {
      ...q.merge_confirmation,
      merge_check: { ...q.merge_confirmation.merge_check, status: "passed" },
    },
  };
  return { ...detail, decisions: [passed], merge_confirmations: [passed] };
}

test("C-697: 退回修改 confirms in a dialog; closing it writes nothing and returns focus", async () => {
  const recordDecision = vi
    .fn()
    .mockRejectedValueOnce(new ApiError(409, "stale_target", "交付已更新"))
    .mockResolvedValue(undefined);
  render(
    <CardDetailPage
      client={fakeClient({ card: async () => ready(), recordDecision })}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  const panel = within(await screen.findByRole("region", { name: "下一步" }));
  const trigger = panel.getByRole("button", { name: "退回修改" });
  fireEvent.click(trigger);
  let dialog = within(await screen.findByRole("dialog"));
  const reason = dialog.getByLabelText("Q-115 退回原因");
  await waitFor(() => expect(document.activeElement).toBe(reason));
  fireEvent.change(reason, { target: { value: "草稿" } });
  fireEvent.click(dialog.getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(trigger);
  expect(recordDecision).not.toHaveBeenCalled();
  fireEvent.click(trigger);
  dialog = within(await screen.findByRole("dialog"));
  fireEvent.change(dialog.getByLabelText("Q-115 退回原因"), {
    target: { value: "请补截图" },
  });
  const submit = dialog.getByRole("button", { name: "确认退回修改" });
  expect(submit.className).toContain("ui-button-emphasis");
  fireEvent.click(submit);
  // A failure stays in the dialog with the words kept; retrying reuses the key.
  expect((await dialog.findByRole("alert")).textContent).toContain(
    "交付已更新",
  );
  expect(
    (dialog.getByLabelText("Q-115 退回原因") as HTMLTextAreaElement).value,
  ).toBe("请补截图");
  fireEvent.click(submit);
  await waitFor(() => expect(recordDecision).toHaveBeenCalledTimes(2));
  expect(recordDecision.mock.calls[1]).toEqual(recordDecision.mock.calls[0]);
  expect(recordDecision).toHaveBeenCalledWith(
    "p-1",
    "Q-115",
    "request_changes",
    "请补截图",
    expect.any(String),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("C-697: 其他（自己填写） is in ⋯ and needs the human's own words", async () => {
  const recordDecision = vi.fn(async () => {});
  render(
    <CardDetailPage
      client={fakeClient({ card: async () => ready(), recordDecision })}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  const panel = within(await screen.findByRole("region", { name: "下一步" }));
  expect(
    panel
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label") ?? b.textContent),
  ).toEqual(["合并详情", "确认合并", "暂不合并", "退回修改", "更多合并操作"]);
  await selectMenu(/^更多合并操作$/, `${decisionOtherOption.description}…`);
  const dialog = within(await screen.findByRole("dialog"));
  const submit = dialog.getByRole("button", { name: "提交" });
  expect(submit.hasAttribute("disabled")).toBe(true);
  fireEvent.change(dialog.getByLabelText("Q-115 其他决定"), {
    target: { value: "先合到预发分支" },
  });
  fireEvent.click(submit);
  await waitFor(() =>
    expect(recordDecision).toHaveBeenCalledWith(
      "p-1",
      "Q-115",
      DECISION_OTHER_OPTION,
      "先合到预发分支",
      expect.any(String),
    ),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "更多合并操作" }),
  );
});
