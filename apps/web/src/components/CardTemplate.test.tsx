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
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "../App.js";
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
  vi.unstubAllGlobals();
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

test.each([false, true])(
  "card page and drawer show fixed template title/version and human completion (drawer=%s)",
  async (inDrawer) => {
    if (inDrawer) window.location.hash = "#/p/p-1/cards?card=C-1";
    const client = fakeClient({ card: async () => detail() });
    render(
      inDrawer ? (
        <App client={client} />
      ) : (
        <CardDetailPage client={client} projectId="p-1" cardId="C-1" />
      ),
    );
    expect(
      await screen.findByRole("button", { name: "模板：通用任务 · v3" }),
    ).toBeTruthy();
    const marker = screen.getByRole("button", { name: "模板：通用任务 · v3" });
    expect(
      marker.closest(inDrawer ? ".drawer-actions" : ".card-header"),
    ).toBeTruthy();
    if (inDrawer) expect(document.querySelector(".card-header h1")).toBeNull();
    expect(screen.queryByText("模板：通用任务 · v3")).toBeNull();
    expect(
      screen.getByRole("button", { name: "标记完成", exact: true }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "更换模板" })).toBeNull();
  },
);

test("review templates have no mark-done action; denied human completion shows the server reason", async () => {
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
    // C-695: refused stays focusable; the reason is the tooltip, not a hint.
    const button = screen.getByRole("button", { name: "标记完成" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(button);
    expect(screen.queryByLabelText("完成结果")).toBeNull();
    expect(document.querySelector(".hint")).toBeNull();
    act(() => button.focus());
    expect((await screen.findByRole("tooltip")).textContent).toBe(reason);
    act(() => button.blur());
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  }
});

const openDialog = () => {
  fireEvent.click(
    screen.getByRole("button", { name: "标记完成", exact: true }),
  );
  return screen.getByRole("dialog");
};

test("required result and selected evidence survive failure, same request retries once with the original key", async () => {
  const markCardDone = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("offline"))
    .mockResolvedValue(undefined);
  const onSaved = vi.fn();
  const onDone = vi.fn();
  render(
    <CardTemplate
      detail={detail()}
      client={fakeClient({ markCardDone })}
      projectId="p-1"
      onSaved={onSaved}
      onDone={onDone}
    />,
  );
  const dialog = openDialog();
  expect(within(dialog).getByRole("heading").textContent).toBe("标记完成 C-1");
  expect(document.activeElement).toBe(screen.getByLabelText("完成结果"));
  const submit = screen.getByRole("button", { name: "确认完成" });
  expect((submit as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("完成结果"), {
    target: { value: "  " },
  });
  expect((submit as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("完成结果"), {
    target: { value: "结果符合预期" },
  });
  expect(within(dialog).getByText("已选 0/1")).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: /evidence\.txt/ }));
  expect(within(dialog).getByText("已选 1/1")).toBeTruthy();
  fireEvent.click(submit);
  const alert = await within(dialog).findByRole("alert");
  // The failure stays in the dialog with the draft and the choice.
  expect(alert.closest("[role=dialog]")).toBe(dialog);
  expect((screen.getByLabelText("完成结果") as HTMLTextAreaElement).value).toBe(
    "结果符合预期",
  );
  expect(
    screen
      .getByRole("checkbox", { name: /evidence\.txt/ })
      .getAttribute("aria-checked"),
  ).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "确认完成" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(markCardDone).toHaveBeenCalledTimes(2);
  expect(markCardDone.mock.calls[0]?.slice(0, 4)).toEqual([
    "p-1",
    "C-1",
    "结果符合预期",
    ["F-1"],
  ]);
  expect(markCardDone.mock.calls[1]?.[4]).toBe(markCardDone.mock.calls[0]?.[4]);
  expect(onSaved).toHaveBeenCalledTimes(1);
  expect(onDone).toHaveBeenCalledWith("C-1 已完成");
  // Focus is back on the entry.
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "标记完成", exact: true }),
  );
});

const discardAsk = async (button: string) => {
  const title = await screen.findByText("放弃未提交的完成结果？");
  const ask = title.closest<HTMLElement>("[role=dialog]");
  if (!ask) throw new Error("no discard dialog");
  return within(ask).getByRole("button", { name: button });
};

test("closing with a draft asks first; keeping returns to the draft, discarding clears it", async () => {
  render(
    <CardTemplate
      detail={detail()}
      client={fakeClient()}
      projectId="p-1"
      onSaved={vi.fn()}
    />,
  );
  // Nothing typed: closes at once.
  openDialog();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  openDialog();
  fireEvent.click(screen.getByRole("checkbox", { name: /evidence\.txt/ }));
  fireEvent.keyDown(screen.getByLabelText("完成结果"), { key: "Escape" });
  fireEvent.click(await discardAsk("继续编辑"));
  await waitFor(() =>
    expect(screen.queryByText("放弃未提交的完成结果？")).toBeNull(),
  );
  expect(
    screen
      .getByRole("checkbox", { name: /evidence\.txt/ })
      .getAttribute("aria-checked"),
  ).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  fireEvent.click(await discardAsk("放弃修改"));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  openDialog();
  expect(
    screen
      .getByRole("checkbox", { name: /evidence\.txt/ })
      .getAttribute("aria-checked"),
  ).toBe("false");
});

test("select all toggles every attachment; no attachments says only that", async () => {
  const files = Array.from({ length: 14 }, (_, i) =>
    attachment({
      id: `F-${i + 1}`,
      original_filename: `photo-${i + 1}.png`,
    }),
  );
  const view = render(
    <CardTemplate
      detail={{ ...detail(), attachments: files }}
      client={fakeClient()}
      projectId="p-1"
      onSaved={vi.fn()}
    />,
  );
  const dialog = openDialog();
  expect(within(dialog).getAllByRole("checkbox")).toHaveLength(14);
  fireEvent.click(within(dialog).getByRole("button", { name: "全选" }));
  expect(within(dialog).getByText("已选 14/14")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "全不选" }));
  expect(within(dialog).getByText("已选 0/14")).toBeTruthy();
  view.unmount();
  render(
    <CardTemplate
      detail={{ ...detail(), attachments: [] }}
      client={fakeClient()}
      projectId="p-1"
      onSaved={vi.fn()}
    />,
  );
  const empty = openDialog();
  expect(within(empty).getByText("没有附件")).toBeTruthy();
  expect(within(empty).queryByRole("button", { name: "全选" })).toBeNull();
  expect(within(empty).getByRole("button", { name: "上传" })).toBeTruthy();
});

test("files added with 上传 are sent on confirm, attached to one evidence comment, and marked with the result", async () => {
  const addComment = vi.fn(async () => ({
    id: "C-1#9",
    body: "完成证据",
    created_at: "2026-01-01T00:00:00Z",
  }));
  const uploadAttachment = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("offline"))
    .mockResolvedValue({ id: "F-9" });
  const markCardDone = vi.fn(async () => {});
  render(
    <CardTemplate
      detail={detail()}
      client={fakeClient({ addComment, uploadAttachment, markCardDone })}
      projectId="p-1"
      onSaved={vi.fn()}
    />,
  );
  const dialog = openDialog();
  fireEvent.change(screen.getByLabelText("完成结果"), {
    target: { value: "照片见附件" },
  });
  const input = dialog.querySelector<HTMLInputElement>("input[type=file]");
  if (!input) throw new Error("no file input");
  fireEvent.change(input, {
    target: {
      files: [new File(["png"], "site.png", { type: "image/png" })],
    },
  });
  expect(within(dialog).getByText("site.png")).toBeTruthy();
  expect(within(dialog).getByText("已选 1/2")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "确认完成" }));
  await within(dialog).findByRole("alert");
  expect(markCardDone).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "确认完成" }));
  await waitFor(() => expect(markCardDone).toHaveBeenCalledTimes(1));
  // A retry reuses the comment and the file's key.
  expect(addComment).toHaveBeenCalledTimes(1);
  expect(addComment.mock.calls[0]?.[2]).toEqual({ body: "完成证据" });
  expect(uploadAttachment).toHaveBeenCalledTimes(2);
  expect(uploadAttachment.mock.calls[1]?.[2]).toMatchObject({
    attach_to: { kind: "timeline_entry", id: "C-1#9" },
    kind: "evidence",
    original_filename: "site.png",
  });
  expect(uploadAttachment.mock.calls[1]?.[3]).toBe(
    uploadAttachment.mock.calls[0]?.[3],
  );
  expect(markCardDone.mock.calls[0]?.slice(0, 4)).toEqual([
    "p-1",
    "C-1",
    "照片见附件",
    ["F-9"],
  ]);
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
  openDialog();
  fireEvent.change(screen.getByLabelText("完成结果"), {
    target: { value: "已确认" },
  });
  fireEvent.click(screen.getByRole("button", { name: "确认完成" }));
  fireEvent.submit(screen.getByRole("form", { name: "标记完成" }));
  await waitFor(() => expect(markCardDone).toHaveBeenCalledTimes(1));
  // In flight: the confirm says so, nothing closes the dialog, fields are fixed.
  const busy = screen.getByRole("button", { name: "正在提交…" });
  expect(busy.getAttribute("aria-disabled")).toBe("true");
  expect(
    (screen.getByRole("button", { name: "取消" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    (screen.getByLabelText("完成结果") as HTMLTextAreaElement).readOnly,
  ).toBe(true);
  fireEvent.keyDown(screen.getByLabelText("完成结果"), { key: "Escape" });
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(screen.queryByText("放弃未提交的完成结果？")).toBeNull();
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
          name: "确认完成",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true),
  );
  expect((screen.getByLabelText("完成结果") as HTMLTextAreaElement).value).toBe(
    "已确认",
  );
  expect(onSaved).not.toHaveBeenCalled();
});
