// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { DeliveryView, ReviewView } from "../api.js";
import { cardDetail } from "../testing/fixtures.js";
import { CardRecords } from "./CardRecords.js";
import { EmployeeIdentity } from "./EmployeeIdentity.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const sha = "0bc333734004d76ecddedff4b22456592742aa11";
const employee = {
  id: "E-3",
  name: "赵云",
  title: "开发工程师",
  avatar: null,
  role_id: "coder",
};
const delivery = (
  id: string,
  status: string,
  minute: number,
  extra: Partial<DeliveryView> = {},
): DeliveryView => ({
  id,
  work_item_id: "W-1",
  kind: "code",
  summary: `${id} 说明；已合入基线 ${sha}，补齐测试`,
  subject: { kind: "git_head", value: `${minute}`.padStart(7, "a") },
  status,
  employee,
  author: "assignment:A-1",
  author_role: "coder",
  submitted_at: `2026-11-12T10:${String(minute).padStart(2, "0")}:00.000Z`,
  ...extra,
});
const review = (
  id: string,
  delivery_id: string,
  verdict: string,
  minute: number,
): ReviewView => ({
  id,
  delivery_id,
  work_item_id: "W-2",
  verdict,
  blocking: verdict !== "pass",
  author_display: "林黛玉",
  author_role: "reviewer",
  submitted_at: `2026-11-12T10:${String(minute).padStart(2, "0")}:30.000Z`,
});

function renderC85Like() {
  // A card redone several times: three superseded deliveries, then the
  // current code delivery and its completion request (PM acceptance).
  const detail = cardDetail({
    deliveries: [
      delivery("D-290", "superseded", 1),
      delivery("D-296", "superseded", 2),
      delivery("D-303", "superseded", 3, { kind: "card_completion" }),
      delivery("D-339", "accepted", 4),
      delivery("D-353", "submitted", 5, { kind: "card_completion" }),
    ],
    reviews: [
      review("V-283", "D-290", "reject", 1),
      review("V-293", "D-303", "pass", 3),
      review("V-325", "D-339", "pass", 4),
      review("V-340", "D-353", "pass", 5),
    ],
  });
  render(<CardRecords detail={detail} projectId="p-1" onLocate={undefined} />);
}

const ids = (list: HTMLElement) =>
  [...list.querySelectorAll<HTMLElement>("li[data-delivery-id]")].map(
    (li) => li.dataset.deliveryId,
  );

test("current deliveries come first and stand out; superseded ones are folded", () => {
  renderC85Like();
  const section = screen.getByRole("region", { name: "交付与审核" });
  const current = within(section).getByRole("list", { name: "当前交付" });
  expect(ids(current)).toEqual(["D-353", "D-339"]);
  for (const li of current.querySelectorAll("li[data-delivery-id]"))
    expect(li.classList).toContain("record-delivery-current");
  // The current list precedes the folded history in the document.
  const folded = section.querySelector("details.record-superseded");
  if (!folded) throw new Error("missing superseded group");
  expect(
    current.compareDocumentPosition(folded) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect((folded as HTMLDetailsElement).open).toBe(false);
  expect(folded.querySelector("summary")?.textContent).toBe(
    "已取代的交付 3 条",
  );
});

test("expanded history lists superseded deliveries newest first, reviews nested", () => {
  renderC85Like();
  fireEvent.click(screen.getByText("已取代的交付 3 条"));
  const history = screen.getByRole("list", { name: "已取代的交付" });
  expect(ids(history)).toEqual(["D-303", "D-296", "D-290"]);
  const reviews = screen.getByRole("list", { name: "D-290 的审核与验收" });
  expect(within(reviews).getByRole("link", { name: "V-283" })).toBeTruthy();
  expect(reviews.textContent).toContain("已驳回");
  expect(reviews.textContent).toContain("审核");
});

test("PM acceptance hangs under the completion request with its own time", () => {
  renderC85Like();
  const acceptance = screen.getByRole("list", { name: "D-353 的审核与验收" });
  const row = acceptance.querySelector("li.record-row");
  expect(row?.querySelector(".record-id")?.textContent).toBe("V-340");
  expect(row?.querySelector(".record-commit")?.textContent).toBe("验收");
  expect(
    row?.querySelector(".record-time time")?.getAttribute("datetime"),
  ).toBe("2026-11-12T10:05:30.000Z");
  const current = screen.getByRole("list", { name: "当前交付" });
  expect(current.querySelector(".record-kind")?.textContent).toBe("完成申请");
});

test("each delivery row preserves the order: who, id, status, short commit, time", () => {
  renderC85Like();
  const current = screen.getByRole("list", { name: "当前交付" });
  const row = current.querySelector(
    "li[data-delivery-id='D-339'] > .record-row",
  );
  expect([...(row?.children ?? [])].map((cell) => cell.className)).toEqual([
    "record-who",
    "record-id",
    "record-status",
    "record-commit",
    "record-time",
  ]);
  expect(row?.querySelector(".record-commit")?.textContent).toContain(
    "提交 aaaaaa4",
  );
  expect(
    row?.querySelector(".record-time time")?.getAttribute("datetime"),
  ).toBe("2026-11-12T10:04:00.000Z");
});

test("summaries show 7-character SHAs with the full value on hover", () => {
  renderC85Like();
  const current = screen.getByRole("list", { name: "当前交付" });
  const summary = current.querySelector(
    "li[data-delivery-id='D-339'] .record-summary p",
  );
  expect(summary?.textContent).toBe("D-339 说明；已合入基线 0bc3337，补齐测试");
  const abbr = summary?.querySelector("abbr.record-sha");
  expect(abbr?.textContent).toBe("0bc3337");
  expect(abbr?.getAttribute("title")).toBe(sha);
  expect(summary?.classList).toContain("record-summary-clamped");
});

test("long summaries clamp to two lines and expand on request", () => {
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(120);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(40);
  renderC85Like();
  const current = screen.getByRole("list", { name: "当前交付" });
  const item = current.querySelector<HTMLElement>(
    "li[data-delivery-id='D-339']",
  );
  if (!item) throw new Error("missing D-339");
  const more = within(item).getByRole("button", { name: "展开全文" });
  expect(more.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(more);
  const less = within(item).getByRole("button", { name: "收起" });
  expect(less.getAttribute("aria-expanded")).toBe("true");
  expect(item.querySelector(".record-summary p")?.classList).not.toContain(
    "record-summary-clamped",
  );
});

test("short summaries get no expand control", () => {
  renderC85Like();
  expect(screen.queryByRole("button", { name: "展开全文" })).toBeNull();
});

test("records CSS clamps summaries, never scrolls sideways and stacks at narrow widths", () => {
  const css = readFileSync(
    new NodeURL("./layout/CardDetailLayout.module.css", import.meta.url),
    "utf8",
  );
  const legacy = readFileSync(
    new NodeURL("../styles.css", import.meta.url),
    "utf8",
  );
  const source = `${css}\n${legacy}`.replace(/^ +/gm, "");
  const rule = (selector: string) => {
    // Match the whole top-level selector, not the tail of a compound selector.
    const start = source.indexOf(`\n${selector} {`);
    if (start < 0) throw new Error(`missing ${selector}`);
    return source.slice(start, source.indexOf("}", start));
  };
  expect(rule(".page :global(.record-summary-clamped)")).toContain(
    "-webkit-line-clamp: 2",
  );
  expect(rule(".page :global(.record-summary p)")).toContain(
    "overflow-wrap: anywhere",
  );
  expect(rule(".identity-row")).toContain("flex-wrap: wrap");
  expect(rule(".identity-row")).toContain("align-items: center");
  // Light/dark both come from the theme tokens; no hard-coded colors here.
  const records = css;
  expect(records).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
});

test("hover profiles open above their row so they do not cover it", async () => {
  vi.useFakeTimers();
  render(
    <EmployeeIdentity
      employee={employee}
      author="assignment:A-1"
      author_role="coder"
    />,
  );
  fireEvent.pointerEnter(
    screen.getByRole("button", { name: "赵云的员工卡片" }),
    { pointerType: "mouse" },
  );
  await act(async () => {
    vi.advanceTimersByTime(1000);
  });
  const profile = screen.getByRole("dialog", { name: "赵云的员工卡片" });
  expect(profile.getAttribute("data-side")).toBe("top");
});
