// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { CardListItem } from "../api.js";
import { DEFAULT_CARD_DISPLAY } from "../card-display.js";
import { card, cardDetail, fakeClient } from "../testing/fixtures.js";
import { CardDetailPage } from "../views/CardDetailPage.js";
import { CardListPage } from "../views/CardListPage.js";
import { BoardCard } from "./BoardCard.js";
import { CARD_LEGEND_GROUPS } from "./CardLegend.js";
import {
  TEMPLATE_GLYPHS,
  TemplateMarker,
  templateIdentity,
} from "./TemplateMarker.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
  localStorage.clear();
});
const dev = { id: "dev", title: "开发卡", version: 2, builtin: true };
const example: CardListItem = {
  ...card,
  template: "dev",
  template_version: 2,
  template_info: dev,
};

test("only a confirmed builtin dev v2 is omitted, including when the number is hidden", () => {
  const { rerender, container } = render(
    <BoardCard
      card={example}
      display={{ ...DEFAULT_CARD_DISPLAY, number: false }}
      projectId="p-1"
    />,
  );
  expect(screen.queryByRole("button", { name: /模板/ })).toBeNull();
  for (const info of [
    undefined,
    null,
    { ...dev, builtin: false },
    { ...dev, version: 1 },
  ]) {
    rerender(
      <BoardCard
        card={{ ...example, template_info: info }}
        display={{ ...DEFAULT_CARD_DISPLAY, number: false }}
        projectId="p-1"
      />,
    );
    expect(screen.getByRole("button", { name: /模板/ })).toBeTruthy();
    expect(
      container.querySelector('[data-template-glyph="custom"]'),
    ).toBeTruthy();
  }
  rerender(<TemplateMarker card={example} info={dev} force />);
  expect(
    screen.getByRole("button", { name: "模板：开发卡 · v2" }),
  ).toBeTruthy();
});

test("all builtin shapes have legend coverage; old, custom and missing templates keep their identity", () => {
  for (const kind of Object.keys(TEMPLATE_GLYPHS)) {
    expect(
      CARD_LEGEND_GROUPS.flatMap((g) => g.rows).some(
        (r) => r.id === `template-${kind}`,
      ),
    ).toBe(true);
    expect(
      templateIdentity(
        { template: kind, template_version: 1 },
        { ...dev, id: kind, version: 1 },
      ).kind,
    ).toBe(kind);
  }
  expect(
    templateIdentity(
      { template: "dev", template_version: 1 },
      { ...dev, version: 1 },
    ),
  ).toMatchObject({ omitted: false, label: "模板：开发卡 · v1" });
  expect(
    templateIdentity({ template: "dev", template_version: 3 }, dev),
  ).toMatchObject({
    omitted: false,
    kind: "custom",
    label: "模板：未识别模板（dev） · v3",
  });
  expect(templateIdentity({})).toMatchObject({
    omitted: false,
    label: "模板：未知模板 · 版本未记录",
  });
  expect(
    templateIdentity(
      { template: "custom", template_version: 3 },
      {
        ...dev,
        id: "custom",
        version: 3,
        builtin: false,
        title: "长名称".repeat(50),
      },
    ).label,
  ).toBe(`模板：${"长名称".repeat(50)} · v3`);
});

test("hover, focus and tap expose the name without duplicate screen-reader descriptions or opening the card", () => {
  const onOpenCard = vi.fn();
  const view = render(
    <BoardCard
      card={{
        ...example,
        template_version: 1,
        template_info: { ...dev, version: 1 },
      }}
      display={DEFAULT_CARD_DISPLAY}
      projectId="p-1"
      onOpenCard={onOpenCard}
    />,
  );
  const button = screen.getByRole("button", { name: "模板：开发卡 · v1" });
  expect(button.closest("a")).toBeNull();
  fireEvent.pointerEnter(button, { pointerType: "mouse" });
  expect(
    document.querySelector('.template-marker-tip[aria-hidden="true"]')
      ?.textContent,
  ).toBe(button.getAttribute("aria-label"));
  expect(button.hasAttribute("aria-describedby")).toBe(false);
  fireEvent.pointerLeave(button);
  expect(document.querySelector(".template-marker-tip")).toBeNull();
  act(() => button.focus());
  expect(button.getAttribute("aria-expanded")).toBe("true");
  fireEvent.keyDown(button, { key: "Escape" });
  expect(document.activeElement).toBe(button);
  expect(button.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(button);
  expect(onOpenCard).not.toHaveBeenCalled();
  fireEvent.pointerDown(document.body);
  expect(button.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(button);
  fireEvent.scroll(window);
  expect(button.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(button);
  fireEvent.blur(button);
  expect(button.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(button);
  view.rerender(
    <BoardCard
      card={{
        ...example,
        template: "unknown",
        template_version: 8,
        template_info: null,
      }}
      display={DEFAULT_CARD_DISPLAY}
      projectId="p-1"
      onOpenCard={onOpenCard}
    />,
  );
  expect(document.querySelector(".template-marker-tip")).toBeNull();
  fireEvent.click(screen.getByRole("link", { name: /准备发布/ }));
  expect(onOpenCard).toHaveBeenCalledOnce();
});

test.each([false, true])(
  "list marker has a single focus stop in visual order (narrow=%s), without detail fetches",
  async (narrow) => {
    vi.stubGlobal("matchMedia", () => ({
      matches: narrow,
      addEventListener() {},
      removeEventListener() {},
    }));
    const detailRead = vi.fn(async () => cardDetail());
    window.location.hash = "#/p/p-1/cards?view=list";
    const { container } = render(
      <CardListPage
        projectId="p-1"
        client={fakeClient({
          cards: async () => ({
            cards: [
              {
                ...example,
                template_version: 1,
                template_info: { ...dev, version: 1 },
              },
            ],
            counts: { total: 1, needs_me: 0, agent: 0 },
          }),
          card: detailRead,
        })}
      />,
    );
    const marker = await screen.findByRole("button", {
      name: "模板：开发卡 · v1",
    });
    expect(container.querySelectorAll(".template-marker")).toHaveLength(1);
    expect(marker.closest("td")?.className).toBe(
      narrow ? "card-table-number" : "card-table-template",
    );
    fireEvent.click(marker);
    expect(detailRead).not.toHaveBeenCalled();
  },
);

test("detail replaces the static text with a marker while preserving human completion", async () => {
  const definition = {
    ...dev,
    id: "general",
    version: 1,
    title: "通用任务",
    description: "",
    status: "active" as const,
    requires_repo: false,
    merge: "none" as const,
    require_acceptance_criteria: false,
    primary_work_item_key: null,
    work_items: [],
    completion: { mode: "human_mark_done" as const },
  };
  const detail = cardDetail({
    card: { ...card, template: "general", template_version: 1 },
    template: definition,
    mark_done: { allowed: true, reason: null },
  });
  render(
    <CardDetailPage
      projectId="p-1"
      cardId="C-1"
      client={fakeClient({ card: async () => detail })}
    />,
  );
  expect(
    await screen.findByRole("button", { name: "模板：通用任务 · v1" }),
  ).toBeTruthy();
  expect(screen.queryByText("模板：通用任务 · v1")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "标记完成" }));
  expect(screen.getByRole("textbox", { name: "完成结果" })).toBeTruthy();
});
