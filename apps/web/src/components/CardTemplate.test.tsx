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
import { ApiError, type TemplateView } from "../api.js";
import { attachment, cardDetail, fakeClient } from "../testing/fixtures.js";
import { CardDetailPage } from "../views/CardDetailPage.js";
import { CardTemplate } from "./CardTemplate.js";

const template: TemplateView = {
  id: "general",
  title: "通用任务",
  description: "",
  version: 3,
  builtin: true,
  status: "active",
  requires_repo: false,
  merge: "none",
  require_acceptance_criteria: false,
  work_items: [],
  primary_work_item_key: null,
  completion: { mode: "human_mark_done" },
};
const detail = () =>
  cardDetail({
    card: {
      ...cardDetail().card,
      template: template.id,
      template_version: template.version,
    },
    template,
    mark_done: { allowed: true, reason: null },
    attachments: [attachment({ original_filename: "evidence.txt" })],
  });
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

test.each([false, true])(
  "card page and drawer show fixed template title/version and human completion (drawer=%s)",
  async (inDrawer) => {
    render(
      <CardDetailPage
        client={fakeClient({ card: async () => detail() })}
        projectId="p-1"
        cardId="C-1"
        inDrawer={inDrawer}
      />,
    );
    expect(
      await screen.findByRole("button", { name: "模板：通用任务 · v3" }),
    ).toBeTruthy();
    expect(screen.queryByText("模板：通用任务 · v3")).toBeNull();
    expect(
      screen.getByRole("button", { name: "标记完成", exact: true }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "更换模板" })).toBeNull();
  },
);

test("review templates have no mark-done action; denied human completion shows the server reason", () => {
  const data = detail();
  const props = { client: fakeClient(), projectId: "p-1", onSaved: vi.fn() };
  const view = render(
    <CardTemplate
      {...props}
      detail={{
        ...data,
        template: {
          ...template,
          completion: { mode: "review", reviewer: "role:pm" },
        },
        mark_done: null,
      }}
    />,
  );
  expect(screen.queryByRole("button", { name: "标记完成" })).toBeNull();
  for (const reason of [
    "必需工作项尚未全部完成",
    "当前卡片状态不允许标记完成。",
    "只有人能标记卡片完成",
  ]) {
    view.rerender(
      <CardTemplate
        {...props}
        detail={{ ...data, mark_done: { allowed: false, reason } }}
      />,
    );
    expect(
      (screen.getByRole("button", { name: "标记完成" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText(reason)).toBeTruthy();
  }
});

test("required result and selected evidence survive failure, same request retries once with the original key", async () => {
  const markCardDone = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("offline"))
    .mockResolvedValue(undefined);
  const onSaved = vi.fn();
  render(
    <CardTemplate
      detail={detail()}
      client={fakeClient({ markCardDone })}
      projectId="p-1"
      onSaved={onSaved}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "标记完成", exact: true }),
  );
  const submit = screen.getByRole("button", { name: "确认标记完成" });
  expect((submit as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("完成结果"), {
    target: { value: "  " },
  });
  expect((submit as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("完成结果"), {
    target: { value: "结果符合预期" },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: "F-1 · evidence.txt" }));
  fireEvent.click(submit);
  await screen.findByRole("alert");
  expect((screen.getByLabelText("完成结果") as HTMLTextAreaElement).value).toBe(
    "结果符合预期",
  );
  fireEvent.click(screen.getByRole("button", { name: "暂不完成" }));
  fireEvent.click(
    screen.getByRole("button", { name: "标记完成", exact: true }),
  );
  fireEvent.click(screen.getByRole("button", { name: "确认标记完成" }));
  await screen.findByText("卡片已标记完成。");
  expect(markCardDone).toHaveBeenCalledTimes(2);
  expect(markCardDone.mock.calls[0]?.slice(0, 4)).toEqual([
    "p-1",
    "C-1",
    "结果符合预期",
    ["F-1"],
  ]);
  expect(markCardDone.mock.calls[1]?.[4]).toBe(markCardDone.mock.calls[0]?.[4]);
  expect(onSaved).toHaveBeenCalledTimes(1);
});

test("fresh eligibility disables an open draft, server rejection is shown and submission is locked in flight", async () => {
  let reject: ((reason: unknown) => void) | undefined;
  const markCardDone = vi.fn(
    () =>
      new Promise<void>((_resolve, fail) => {
        reject = fail;
      }),
  );
  const data = detail(),
    client = fakeClient({ markCardDone }),
    onSaved = vi.fn();
  const view = render(
    <CardTemplate
      detail={data}
      client={client}
      projectId="p-1"
      onSaved={onSaved}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "标记完成" }));
  fireEvent.change(screen.getByLabelText("完成结果"), {
    target: { value: "已确认" },
  });
  fireEvent.click(screen.getByRole("button", { name: "确认标记完成" }));
  fireEvent.submit(screen.getByRole("form", { name: "标记完成" }));
  expect(markCardDone).toHaveBeenCalledTimes(1);
  reject?.(new ApiError(409, "invariant_violation", "必需工作项尚未全部完成"));
  await screen.findByRole("alert");
  expect(
    within(screen.getByRole("alert")).getByText(/必需工作项尚未全部完成/),
  ).toBeTruthy();
  view.rerender(
    <CardTemplate
      detail={{
        ...data,
        mark_done: { allowed: false, reason: "必需工作项尚未全部完成" },
      }}
      client={client}
      projectId="p-1"
      onSaved={onSaved}
    />,
  );
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "确认标记完成",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true),
  );
  expect((screen.getByLabelText("完成结果") as HTMLTextAreaElement).value).toBe(
    "已确认",
  );
  expect(onSaved).not.toHaveBeenCalled();
});
