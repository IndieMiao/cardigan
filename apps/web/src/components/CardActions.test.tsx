// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ApiError, type CardiganClient, HttpCardiganClient } from "../api.js";
import { cardDetail, fakeClient } from "../testing/fixtures.js";
import { selectMenu } from "../testing/menu.js";
import { writeFailures } from "../testing/write-errors.js";
import { CardDetailPage } from "../views/CardDetailPage.js";
import { CardActions } from "./CardActions.js";
import { Drawer } from "./Drawer.js";

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
  window.history.replaceState(null, "", "/");
});

test.each(
  writeFailures.flatMap((failure) =>
    ["edit", "cancel", "supersede"].map((mode) => ({ ...failure, mode })),
  ),
)(
  "$mode shows the right write failure for $label",
  async ({ mode, error, uncertain, reason }) => {
    const card = cardDetail().card;
    const fail = async () => {
      throw error;
    };
    render(
      <CardActions
        card={mode === "supersede" ? { ...card, status: "done" } : card}
        client={fakeClient({
          updateCard: fail,
          cancelCard: fail,
          supersedeCard: fail,
        })}
        projectId="p-1"
        onSaved={() => {}}
      />,
    );
    if (mode === "edit")
      fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    else
      await selectMenu(/^更多$/, mode === "cancel" ? "取消卡片" : "标记被取代");
    if (mode === "supersede")
      fireEvent.change(screen.getByLabelText("被哪张卡取代"), {
        target: { value: "C-2" },
      });
    fireEvent.click(
      screen.getByRole("button", {
        name:
          mode === "edit"
            ? "保存修改"
            : mode === "cancel"
              ? "确认取消卡片"
              : "标记被取代",
      }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent?.includes("可能已经成功")).toBe(uncertain);
    expect(alert.textContent).toContain(
      mode === "cancel" &&
        error instanceof ApiError &&
        error.code === "illegal_transition"
        ? "已完成卡片不能取消"
        : reason,
    );
  },
);

test.each([false, true])(
  "K2 edits all fields and criteria in shared detail (drawer=%s)",
  async (inDrawer) => {
    let detail = cardDetail();
    const updateCard = vi
      .fn<CardiganClient["updateCard"]>()
      .mockImplementation(async (_p, _c, input) => {
        detail = { ...detail, card: { ...detail.card, ...input } };
      });
    const read = vi.fn(async () => detail);
    const client = fakeClient({ card: read, updateCard });
    const page = (revision = 0) => (
      <CardDetailPage
        client={client}
        projectId="p-1"
        cardId="C-1"
        inDrawer={inDrawer}
        revision={revision}
      />
    );
    const display = (revision = 0) =>
      inDrawer ? (
        <Drawer open onOpenChange={() => {}} title="C-1 准备发布">
          {page(revision)}
        </Drawer>
      ) : (
        page(revision)
      );
    const view = render(display());
    fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
    fireEvent.change(screen.getByLabelText("标题"), {
      target: { value: "修改后的标题" },
    });
    fireEvent.change(screen.getByLabelText("目标"), {
      target: { value: "新的目标" },
    });
    fireEvent.change(screen.getByLabelText("验收标准 1"), {
      target: { value: "修改标准" },
    });
    fireEvent.click(screen.getByRole("button", { name: "删除验收标准 2" }));
    expect(
      (
        screen.getByRole("button", {
          name: "删除验收标准 1",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "添加验收标准" }));
    expect(
      (screen.getByRole("button", { name: "保存修改" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.change(screen.getByLabelText("验收标准 2"), {
      target: { value: "新增标准" },
    });
    fireEvent.click(screen.getByRole("button", { name: "优先级：低" }));
    fireEvent.click(screen.getByRole("option", { name: "紧急" }));
    view.rerender(display(1));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect((screen.getByLabelText("标题") as HTMLInputElement).value).toBe(
      "修改后的标题",
    );
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await screen.findByText("卡片已更新。");
    expect(updateCard).toHaveBeenCalledWith(
      "p-1",
      "C-1",
      {
        title: "修改后的标题",
        goal: "新的目标",
        acceptance_criteria: ["修改标准", "新增标准"],
        priority: 4,
      },
      expect.any(String),
    );
    const overview = screen.getByRole("region", { name: "目标和验收标准" });
    expect(overview.textContent).toContain("新的目标");
    expect(overview.textContent).toContain("新增标准");
    expect(overview.textContent).not.toContain("文档更新");
    const nav = screen.getByRole("tablist", { name: "卡片区块导航" });
    expect(nav.querySelector(".card-nav-identity")).toBeNull();
    expect(within(nav).queryByRole("button", { name: "写评论" })).toBeNull();
  },
);

test("K2 cancellation requires a second action, can be dismissed, and sends the reason", async () => {
  let detail = cardDetail();
  let finish: () => void = () => {};
  const cancelCard = vi.fn<CardiganClient["cancelCard"]>().mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => {
          detail = { ...detail, card: { ...detail.card, status: "cancelled" } };
          resolve();
        };
      }),
  );
  render(
    <CardDetailPage
      client={fakeClient({ card: async () => detail, cancelCard })}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  await screen.findByRole("button", { name: "更多" });
  await selectMenu(/^更多$/, "取消卡片");
  expect(cancelCard).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByLabelText("取消原因（可选）"),
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "暂不取消" }));
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "更多" }),
  );
  expect(cancelCard).not.toHaveBeenCalled();
  await screen.findByRole("button", { name: "更多" });
  await selectMenu(/^更多$/, "取消卡片");
  fireEvent.change(screen.getByLabelText("取消原因（可选）"), {
    target: { value: "范围已调整" },
  });
  const form = screen.getByRole("form", { name: "确认取消卡片" });
  fireEvent.submit(form);
  fireEvent.submit(form);
  expect(cancelCard).toHaveBeenCalledTimes(1);
  expect(cancelCard).toHaveBeenCalledWith(
    "p-1",
    "C-1",
    "范围已调整",
    expect.any(String),
  );
  finish();
  await screen.findByText("卡片已取消。");
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "取消卡片" })).toBeNull(),
  );
});

test.each(
  [false, true].flatMap((inDrawer) =>
    ["hold", "completion", "both"].map((openForm) => ({ inDrawer, openForm })),
  ),
)(
  "cancel focus is scoped even with other mounted forms ($openForm, drawer=$inDrawer)",
  async ({ inDrawer, openForm }) => {
    const cancelCard = vi.fn();
    const page = (
      <CardActions
        card={cardDetail().card}
        client={fakeClient({ cancelCard })}
        projectId="p-1"
        onSaved={() => {}}
        primaryActions={
          <>
            {openForm !== "completion" && (
              <form>
                <label>
                  暂停原因
                  <textarea defaultValue="保留暂停草稿" />
                </label>
              </form>
            )}
            {openForm !== "hold" && (
              <form>
                <label>
                  完成结果
                  <textarea defaultValue="保留完成草稿" />
                </label>
              </form>
            )}
          </>
        }
      />
    );
    render(
      inDrawer ? (
        <Drawer open onOpenChange={() => {}} title="C-1 准备发布">
          {page}
        </Drawer>
      ) : (
        page
      ),
    );
    const drafts = [
      ...document.querySelectorAll<HTMLTextAreaElement>("textarea"),
    ];
    const values = drafts.map((field) => field.value);
    await selectMenu(/^更多$/, "取消卡片");
    const reason =
      screen.getByLabelText<HTMLTextAreaElement>("取消原因（可选）");
    await waitFor(() => expect(document.activeElement).toBe(reason));
    fireEvent.change(document.activeElement as HTMLTextAreaElement, {
      target: { value: "仅写入取消原因" },
    });
    expect(reason.value).toBe("仅写入取消原因");
    expect(drafts.map((field) => field.value)).toEqual(values);
    fireEvent.keyDown(reason, { key: "Escape" });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "更多" }),
    );
    expect(drafts.map((field) => field.value)).toEqual(values);
    if (inDrawer) expect(screen.getByRole("dialog")).toBeTruthy();
    expect(cancelCard).not.toHaveBeenCalled();
  },
);

test.each(
  [false, true].flatMap((inDrawer) =>
    ["hold", "completion"].map((action) => ({ inDrawer, action })),
  ),
)(
  "primary $action form stays below the toolbar and excludes other actions (drawer=$inDrawer)",
  async ({ inDrawer, action }) => {
    const detail = cardDetail({
      template: {
        id: "general",
        title: "通用任务",
        description: "",
        version: 1,
        builtin: true,
        status: "active",
        requires_repo: false,
        merge: "none",
        require_acceptance_criteria: false,
        work_items: [],
        primary_work_item_key: null,
        completion: { mode: "human_mark_done" },
      },
      mark_done: { allowed: true, reason: null },
    });
    const cancelCard = vi.fn(),
      updateCard = vi.fn(),
      markCardDone = vi.fn();
    const page = (
      <CardDetailPage
        client={fakeClient({
          card: async () => detail,
          cancelCard,
          updateCard,
          markCardDone,
        })}
        projectId="p-1"
        cardId="C-1"
        inDrawer={inDrawer}
      />
    );
    const changeDrawer = vi.fn();
    render(
      inDrawer ? (
        <Drawer open onOpenChange={changeDrawer} title="C-1 准备发布">
          {page}
        </Drawer>
      ) : (
        page
      ),
    );
    const name = action === "hold" ? "暂停卡片" : "标记完成";
    const trigger = await screen.findByRole("button", { name, exact: true });
    fireEvent.click(trigger);
    const field = screen.getByLabelText(
      action === "hold" ? "暂停原因" : "完成结果",
    );
    await waitFor(() => expect(document.activeElement).toBe(field));
    expect(field.closest(".card-action-buttons")).toBeNull();
    expect(field.closest(".card-primary-panels")).toBeTruthy();
    for (const label of [
      "编辑",
      "更多",
      action === "hold" ? "标记完成" : "暂停卡片",
    ])
      expect(
        screen.getByRole<HTMLButtonElement>("button", {
          name: label,
          exact: true,
        }).disabled,
      ).toBe(true);
    expect(document.querySelectorAll(".card-header form")).toHaveLength(1);
    fireEvent.keyDown(field, { key: "Escape" });
    expect(document.querySelector(".card-primary-panels form")).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name, exact: true }),
    );
    if (inDrawer) expect(screen.getByRole("dialog")).toBeTruthy();
    await selectMenu(/^更多$/, "取消卡片");
    const reason = screen.getByLabelText("取消原因（可选）");
    await waitFor(() => expect(document.activeElement).toBe(reason));
    fireEvent.keyDown(reason, { key: "Escape" });
    if (inDrawer) expect(screen.getByRole("dialog")).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "更多" }),
    );
    expect(cancelCard).not.toHaveBeenCalled();
    expect(updateCard).not.toHaveBeenCalled();
    expect(markCardDone).not.toHaveBeenCalled();
    expect(changeDrawer).not.toHaveBeenCalled();
  },
);

test("K2 a stale cancellation displays a Chinese reason and the new-card instruction", async () => {
  render(
    <CardDetailPage
      client={fakeClient({
        cancelCard: async () => {
          throw new ApiError(
            409,
            "illegal_transition",
            "Cannot transition card from done via cancel",
          );
        },
      })}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  await screen.findByRole("button", { name: "更多" });
  await selectMenu(/^更多$/, "取消卡片");
  fireEvent.click(screen.getByRole("button", { name: "确认取消卡片" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "已完成卡片不能取消；请建新卡，再把旧卡标记为被取代。",
  );
});

test.each(["done", "cancelled"] as const)(
  "K2 closed card %s offers superseding, never cancellation",
  async (status) => {
    let detail = cardDetail();
    detail = { ...detail, card: { ...detail.card, status } };
    const supersedeCard = vi
      .fn<CardiganClient["supersedeCard"]>()
      .mockImplementation(async (_p, _c, target) => {
        detail = {
          ...detail,
          card: {
            ...detail.card,
            superseded_by: target,
            resolution: "superseded",
          },
        };
      });
    render(
      <CardDetailPage
        client={fakeClient({ card: async () => detail, supersedeCard })}
        projectId="p-1"
        cardId="C-1"
      />,
    );
    await screen.findByRole("button", { name: "更多" });
    await selectMenu(/^更多$/, "标记被取代");
    expect(screen.queryByRole("button", { name: "取消卡片" })).toBeNull();
    const input = screen.getByLabelText("被哪张卡取代");
    for (const value of ["C-1", "other/C-2", "bad"]) {
      fireEvent.change(input, { target: { value } });
      expect(
        (
          screen.getByRole("button", {
            name: "标记被取代",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
    }
    fireEvent.change(input, { target: { value: "C-2" } });
    fireEvent.click(screen.getByRole("button", { name: "标记被取代" }));
    await screen.findByText("卡片已更新。");
    expect(supersedeCard).toHaveBeenCalledWith(
      "p-1",
      "C-1",
      "C-2",
      expect.any(String),
    );
    expect(
      (await screen.findByRole("link", { name: "已被 C-2 取代" })).getAttribute(
        "href",
      ),
    ).toBe("#/p/p-1/cards/C-2");
  },
);

test.each([
  { entry: "编辑", submit: "保存修改", operation: "update" },
  { entry: "取消卡片", submit: "确认取消卡片", operation: "cancel" },
  { entry: "标记被取代", submit: "标记被取代", operation: "supersede" },
])(
  "K2 $operation retries the exact HTTP request and keeps its idempotency key",
  async ({ entry, submit, operation }) => {
    const detail = cardDetail();
    const data =
      operation === "supersede"
        ? { ...detail, card: { ...detail.card, status: "done" } }
        : detail;
    let failed = false;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async (_url, init) => {
        if (init?.method === "GET") return new Response(JSON.stringify(data));
        if (!failed) {
          failed = true;
          throw new TypeError("Lost response");
        }
        return new Response("{}");
      });
    render(
      <CardDetailPage
        client={
          // Automatic retries off: this exercises the person's manual retry.
          new HttpCardiganClient(fetcher, undefined, { delaysMs: [] })
        }
        projectId="p/a"
        cardId="C-1"
      />,
    );
    if (entry === "编辑")
      fireEvent.click(await screen.findByRole("button", { name: entry }));
    else {
      await screen.findByRole("button", { name: "更多" });
      await selectMenu(/^更多$/, entry);
    }
    if (operation === "supersede")
      fireEvent.change(screen.getByLabelText("被哪张卡取代"), {
        target: { value: "C-2" },
      });
    fireEvent.click(screen.getByRole("button", { name: submit }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "重试不会重复提交",
    );
    fireEvent.click(screen.getByRole("button", { name: submit }));
    await screen.findByText(
      operation === "cancel" ? "卡片已取消。" : "卡片已更新。",
    );
    const writes = fetcher.mock.calls.filter(
      ([, init]) => init?.method === "POST",
    );
    expect(writes).toHaveLength(2);
    expect(writes[0]).toEqual(writes[1]);
    expect(writes[0]?.[0]).toBe(`/api/projects/p%2Fa/cards/C-1/${operation}`);
    const init = writes[0]?.[1];
    expect(init?.credentials).toBe("same-origin");
    const key = new Headers(init?.headers).get("Idempotency-Key");
    expect(key).toMatch(/^[0-9a-f-]{36}$/u);
    if (operation === "update") {
      fireEvent.click(screen.getByRole("button", { name: "编辑" }));
      fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
      await screen.findByText("卡片已更新。");
      expect(
        new Headers(
          fetcher.mock.calls.filter(([, i]) => i?.method === "POST").at(-1)?.[1]
            ?.headers,
        ).get("Idempotency-Key"),
      ).not.toBe(key);
    }
  },
);

test("the human marks and unmarks a card sensitive from the card detail", async () => {
  const setCardSensitive = vi
    .fn()
    .mockResolvedValue({ changed: true, auto_merge_due_at: null });
  const onSaved = vi.fn();
  const card = cardDetail().card;
  const { rerender } = render(
    <CardActions
      card={card}
      client={fakeClient({ setCardSensitive })}
      projectId="p-1"
      onSaved={onSaved}
    />,
  );
  await screen.findByRole("button", { name: "更多" });
  await selectMenu(/^更多$/, "标为敏感");
  await waitFor(() =>
    expect(setCardSensitive).toHaveBeenCalledWith(
      "p-1",
      card.id,
      true,
      expect.any(String),
    ),
  );
  expect(await screen.findByRole("status")).toHaveProperty(
    "textContent",
    "已标为敏感：合并确认将由你亲自处理。",
  );
  expect(onSaved).toHaveBeenCalled();
  rerender(
    <CardActions
      card={{ ...card, sensitive: true }}
      client={fakeClient({ setCardSensitive })}
      projectId="p-1"
      onSaved={onSaved}
    />,
  );
  expect(screen.getByText("敏感卡片：合并确认由你亲自处理。")).toBeTruthy();
  await screen.findByRole("button", { name: "更多" });
  await selectMenu(/^更多$/, "取消敏感标记");
  await waitFor(() =>
    expect(setCardSensitive).toHaveBeenLastCalledWith(
      "p-1",
      card.id,
      false,
      expect.any(String),
    ),
  );
  // C-69: auto-merge is off in the fixture, so no timeout sentence.
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toBe("已取消敏感标记。"),
  );
});

test("C-69: unmarking says when the timeout will auto-merge, only if it is on", async () => {
  const card = { ...cardDetail().card, sensitive: true };
  const base = fakeClient();
  for (const [preferences, expected] of [
    [
      async () => ({
        ...(await base.preferences("p-1")),
        auto_merge_after_minutes: 15,
      }),
      "已取消敏感标记。如有等你处理的合并确认，从现在起重新计时，15 分钟内无人处理将按项目设置自动合并。",
    ],
    [
      async () => {
        throw new Error("offline");
      },
      "已取消敏感标记。",
    ],
  ] as const) {
    const { unmount } = render(
      <CardActions
        card={card}
        client={fakeClient({
          setCardSensitive: vi
            .fn()
            .mockResolvedValue({ changed: true, auto_merge_due_at: null }),
          preferences,
        })}
        projectId="p-1"
        onSaved={() => {}}
      />,
    );
    await screen.findByRole("button", { name: "更多" });
    await selectMenu(/^更多$/, "取消敏感标记");
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(expected),
    );
    unmount();
  }
});

test("the sensitive toggle posts to the human-only card route", async () => {
  const fetchImpl = vi.fn(
    async () => new Response("{}", { status: 200 }),
  ) as unknown as typeof fetch;
  await new HttpCardiganClient(fetchImpl).setCardSensitive(
    "p-1",
    "C-1",
    true,
    "k-1",
  );
  const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
    .calls[0] as [string, RequestInit];
  expect(url).toBe("/api/projects/p-1/cards/C-1/sensitive");
  expect(init.method).toBe("POST");
  expect(JSON.parse(String(init.body))).toEqual({ sensitive: true });
});

test("C-72: a repeated unmark does not promise a restarted timeout", async () => {
  const card = { ...cardDetail().card, sensitive: true };
  const base = fakeClient();
  const due = "2030-01-01T00:15:00.000Z";
  const time = new Date(due).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  for (const [auto_merge_due_at, expected] of [
    [
      due,
      `该卡本来就没有敏感标记，这次没有改动，合并确认的超时计时也没有重新开始。当前合并确认将于 ${time} 按项目设置自动合并。`,
    ],
    [
      null,
      "该卡本来就没有敏感标记，这次没有改动，合并确认的超时计时也没有重新开始。",
    ],
  ] as const) {
    const { unmount } = render(
      <CardActions
        card={card}
        client={fakeClient({
          setCardSensitive: vi
            .fn()
            .mockResolvedValue({ changed: false, auto_merge_due_at }),
          preferences: async () => ({
            ...(await base.preferences("p-1")),
            auto_merge_after_minutes: 15,
          }),
        })}
        projectId="p-1"
        onSaved={() => {}}
      />,
    );
    await screen.findByRole("button", { name: "更多" });
    await selectMenu(/^更多$/, "取消敏感标记");
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(expected),
    );
    expect(screen.getByRole("status").textContent).not.toContain("重新计时，");
    unmount();
  }
});

test("C-72: the client reads whether the flag changed", async () => {
  const reply = (body: unknown) =>
    vi.fn(
      async () => new Response(JSON.stringify(body), { status: 200 }),
    ) as unknown as typeof fetch;
  expect(
    await new HttpCardiganClient(
      reply({ card: {}, changed: false, auto_merge_due_at: "x" }),
    ).setCardSensitive("p-1", "C-1", false, "k-1"),
  ).toEqual({ changed: false, auto_merge_due_at: "x" });
  expect(
    await new HttpCardiganClient(reply({})).setCardSensitive(
      "p-1",
      "C-1",
      false,
      "k-2",
    ),
  ).toEqual({ changed: true, auto_merge_due_at: null });
});
