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
import { changeControl } from "../testing/controls.js";
import { cardDetail, fakeClient } from "../testing/fixtures.js";
import { CardDetailPage } from "../views/CardDetailPage.js";
import { NeedsYouPanel as NeedsYouPage } from "../views/NeedsYouPage.js";

afterEach(cleanup);

const hold = {
  id: "H-9",
  card_id: "C-1",
  instructions: "在 Google 后台配置账号",
  expected_return: "配置完成",
  why: "只有所有者有账号",
  triage: "human" as const,
  executor: "owner" as const,
  waited_ms: 0,
  due: null,
  blocked_work_items: [],
  blocks_merge: true,
  prerequisite: "external_account" as const,
};

test("C-760: Needs You lets the owner turn a credential/account hold into a follow-up", async () => {
  const setActionMergeBlocking = vi.fn(async () => undefined);
  render(
    <NeedsYouPage
      projectId="p-1"
      client={fakeClient({
        needsYou: async () => ({
          decisions: [],
          human_actions: [hold],
          incidents: [],
        }),
        setActionMergeBlocking,
      })}
    />,
  );
  const region = await screen.findByRole("region", { name: "H-9 合并前置" });
  expect(within(region).getByText("挡合并（外部账号）")).toBeTruthy();
  fireEvent.click(
    within(region).getByRole("button", { name: "改为合并后跟进" }),
  );
  await waitFor(() =>
    expect(setActionMergeBlocking).toHaveBeenCalledWith(
      "p-1",
      "H-9",
      { blocks_merge: false, reason: "所有者改为合并后跟进" },
      expect.any(String),
    ),
  );
});

test("C-760: the card page lets the owner turn a follow-up back into a hold", async () => {
  const setActionMergeBlocking = vi.fn(async () => undefined);
  const base = cardDetail();
  render(
    <CardDetailPage
      projectId="p-1"
      cardId="C-1"
      client={fakeClient({
        card: async () => ({
          ...base,
          human_actions: [
            {
              id: "H-9",
              card_id: "C-1",
              instructions: "在 Google 后台配置账号",
              why_human: "只有所有者有账号",
              expected_return: "配置完成",
              status: "open",
              blocks_merge: false,
            },
          ],
        }),
        setActionMergeBlocking,
      })}
    />,
  );
  const region = await screen.findByRole("region", { name: "H-9 合并前置" });
  expect(within(region).getByText("合并后跟进")).toBeTruthy();
  fireEvent.click(within(region).getByRole("button", { name: "改为挡合并" }));
  const submit = within(region).getByRole("button", { name: "确认挡合并" });
  expect(submit.hasAttribute("disabled")).toBe(true);
  changeControl(within(region).getByLabelText("H-9 前置类型"), {
    target: { value: "credential" },
  });
  fireEvent.click(submit);
  await waitFor(() =>
    expect(setActionMergeBlocking).toHaveBeenCalledWith(
      "p-1",
      "H-9",
      {
        blocks_merge: true,
        prerequisite: "credential",
        reason: "所有者改为挡合并（凭据前置）",
      },
      expect.any(String),
    ),
  );
});
