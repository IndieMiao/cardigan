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
import { ApiError, type CardiganClient, HttpCardiganClient } from "../api.js";
import { cardDetail, fakeClient } from "../testing/fixtures.js";
import { writeFailures } from "../testing/write-errors.js";
import { CardDetailPage } from "../views/CardDetailPage.js";
import { CardActions } from "./CardActions.js";
import { Drawer } from "./Drawer.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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
    fireEvent.click(
      screen.getByRole("button", {
        name:
          mode === "edit"
            ? "编辑"
            : mode === "cancel"
              ? "取消卡片"
              : "标记被取代",
      }),
    );
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
    fireEvent.change(screen.getByLabelText("优先级"), {
      target: { value: "5" },
    });
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
        priority: 5,
      },
      expect.any(String),
    );
    const overview = screen.getByRole("region", { name: "目标和验收标准" });
    expect(overview.textContent).toContain("新的目标");
    expect(overview.textContent).toContain("新增标准");
    expect(overview.textContent).not.toContain("文档更新");
    const nav = screen.getByRole("navigation", { name: "卡片区块导航" });
    const scrollRoot = inDrawer
      ? document.querySelector(".drawer-body")
      : window;
    if (!scrollRoot) throw new Error("Missing drawer body");
    fireEvent.scroll(scrollRoot);
    expect(nav.querySelector(".card-nav-identity") === null).toBe(inDrawer);
    if (!inDrawer) expect(nav.textContent).toContain("修改后的标题");
    expect(within(nav).getByRole("button", { name: "写评论" })).toBeTruthy();
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
  fireEvent.click(await screen.findByRole("button", { name: "取消卡片" }));
  expect(cancelCard).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "暂不取消" }));
  expect(cancelCard).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "取消卡片" }));
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
  fireEvent.click(await screen.findByRole("button", { name: "取消卡片" }));
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
    fireEvent.click(await screen.findByRole("button", { name: "标记被取代" }));
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
        client={new HttpCardiganClient(fetcher)}
        projectId="p/a"
        cardId="C-1"
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: entry }));
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
