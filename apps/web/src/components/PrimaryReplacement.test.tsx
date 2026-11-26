// @vitest-environment jsdom
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
import {
  ApiError,
  type CardDetail,
  type TemplateView,
  type WorkItemView,
} from "../api.js";
import { cardDetail, fakeClient } from "../testing/fixtures.js";
import { CardWorkItems } from "./CardSidebar.js";

afterEach(cleanup);

const template = {
  id: "dev",
  title: "开发卡",
  version: 2,
  description: "",
  builtin: true,
  status: "active",
  requires_repo: true,
  merge: "confirm",
  require_acceptance_criteria: true,
  work_items: [],
  primary_work_item_key: "development",
  completion: { mode: "review", reviewer: "role:pm" },
} as TemplateView;

function detail(patch: Partial<CardDetail["card"]> = {}): CardDetail {
  const base = cardDetail();
  const [primary, verifier] = base.work_items as [WorkItemView, WorkItemView];
  return {
    ...base,
    card: { ...base.card, ...patch },
    template,
    work_items: [
      { ...primary, template_key: "development" },
      { ...verifier, template_key: "code_review" },
      {
        id: "W-5",
        card_id: "C-1",
        title: "重做迁移脚本",
        kind: "produce",
        role_id: "artist_3d",
        required: true,
        status: "accepted",
        depends_on: [],
        completion_criteria: [],
      },
      {
        id: "W-6",
        card_id: "C-1",
        title: "已取消的产出",
        kind: "produce",
        role_id: "coder",
        required: false,
        status: "cancelled",
        depends_on: [],
        completion_criteria: [],
      },
    ],
  };
}

function show(d: CardDetail, client = fakeClient(), changed = vi.fn()) {
  render(
    <CardWorkItems
      detail={d}
      projectId="p-1"
      cardId="C-1"
      client={client}
      changed={changed}
    />,
  );
  return changed;
}

const row = (id: string) =>
  document.getElementById(`work-item-${id}`) as HTMLElement;

async function openDialog() {
  const trigger = within(row("W-1")).getByRole("button", {
    name: "W-1 工作项操作",
  });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole("menuitem", { name: "替换为…" }));
  return screen.findByRole("form", { name: "替换主产出项 W-1" });
}

test("C-778: only the primary producer offers “替换为…”, and only while the card is open", () => {
  show(detail());
  expect(
    within(row("W-1")).getByRole("button", { name: "W-1 工作项操作" }),
  ).toBeTruthy();
  for (const id of ["W-2", "W-5", "W-6"])
    expect(within(row(id)).queryByRole("button", { name: /工作项操作/ })).toBe(
      null,
    );
  cleanup();
  for (const status of ["done", "cancelled", "awaiting_merge"]) {
    show(detail({ status }));
    expect(screen.queryByRole("button", { name: /工作项操作/ })).toBe(null);
    cleanup();
  }
  // Without the template's primary key there is nothing to transfer.
  show({ ...detail(), template: null });
  expect(screen.queryByRole("button", { name: /工作项操作/ })).toBe(null);
});

test("C-778: the dialog writes only after the second confirmation and lists open producers only", async () => {
  const replacePrimaryWorkItem = vi.fn(async () => {});
  const changed = show(detail(), fakeClient({ replacePrimaryWorkItem }));
  const form = await openDialog();
  const choices = within(form).getAllByRole("radio");
  expect(choices.map((c) => c.closest("label")?.textContent)).toEqual([
    "W-5 重做迁移脚本（artist_3d）",
  ]);
  const confirm = within(form).getByRole("button", { name: "确认替换" });
  expect((confirm as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(choices[0] as HTMLElement);
  expect((confirm as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(within(form).getByRole("textbox", { name: "替换原因" }), {
    target: { value: "  派错角色  " },
  });
  expect(replacePrimaryWorkItem).not.toHaveBeenCalled();
  await act(async () => {
    fireEvent.click(confirm);
  });
  expect(replacePrimaryWorkItem).toHaveBeenCalledWith(
    "p-1",
    "W-1",
    {
      replacement_work_item_id: "W-5",
      card_id: "C-1",
      template_key: "development",
      reason: "派错角色",
    },
    expect.any(String),
  );
  expect(changed).toHaveBeenCalledOnce();
  await waitFor(() =>
    expect(screen.queryByRole("form", { name: "替换主产出项 W-1" })).toBe(null),
  );
});

test("C-778: cancelling writes nothing; a refusal stays in the dialog and a retry reuses the key", async () => {
  const replacePrimaryWorkItem = vi
    .fn()
    .mockRejectedValueOnce(
      new ApiError(
        409,
        "illegal_transition",
        "原主产出项仍有未释放的 Assignment，请先结束其 Run 并释放",
      ),
    )
    .mockResolvedValueOnce(undefined);
  const changed = show(detail(), fakeClient({ replacePrimaryWorkItem }));
  let form = await openDialog();
  fireEvent.click(within(form).getByRole("button", { name: "取消" }));
  await waitFor(() =>
    expect(screen.queryByRole("form", { name: "替换主产出项 W-1" })).toBe(null),
  );
  form = await openDialog();
  fireEvent.click(within(form).getByRole("radio"));
  fireEvent.change(within(form).getByRole("textbox", { name: "替换原因" }), {
    target: { value: "派错角色" },
  });
  await act(async () => {
    fireEvent.click(within(form).getByRole("button", { name: "确认替换" }));
  });
  expect(within(form).getByRole("alert").textContent).toContain(
    "未释放的 Assignment",
  );
  expect(changed).not.toHaveBeenCalled();
  await act(async () => {
    fireEvent.click(within(form).getByRole("button", { name: "确认替换" }));
  });
  const keys = replacePrimaryWorkItem.mock.calls.map((call) => call[3]);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  expect(changed).toHaveBeenCalledOnce();
});
