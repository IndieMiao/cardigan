// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { cardDetail, fakeClient } from "../testing/fixtures.js";
import { CardDetailPage } from "../views/CardDetailPage.js";

afterEach(cleanup);
test.each([false, true])(
  "detail panels expose their content without redundant disclosures (drawer=%s)",
  async (inDrawer) => {
    const base = cardDetail();
    render(
      <CardDetailPage
        client={fakeClient({
          card: async () => ({
            ...base,
            card: { ...base.card, source: { kind: "quote", text: "背景原话" } },
          }),
        })}
        projectId="p-1"
        cardId="C-1"
        inDrawer={inDrawer}
      />,
    );
    const nav = await screen.findByRole("tablist", { name: "卡片区块导航" });
    const purpose = screen.getByRole("region", { name: "目标和验收标准" });
    expect(purpose.closest("details")).toBeNull();
    expect(screen.getByText("背景原话").closest("details")).toBeNull();
    expect(
      screen
        .getByRole("heading", { name: "卡片索引与关联" })
        .closest("details"),
    ).toBeNull();
    for (const label of ["概览", "工作项", "交付与审核", "时间线", "附件"]) {
      fireEvent.click(
        within(nav).getByRole("tab", { name: new RegExp(`^${label}`) }),
      );
      const panel = screen.getByRole("tabpanel", {
        name: new RegExp(`^${label}`),
      });
      expect(panel.tagName).not.toBe("DETAILS");
      expect(panel.closest("[hidden]")).toBeNull();
      expect(
        within(panel).queryByRole("heading", { name: label, exact: true }),
      ).toBeNull();
      if (label === "工作项") {
        const item = panel.querySelector(".work-item details");
        expect(item?.hasAttribute("open")).toBe(false);
        fireEvent.click(item?.querySelector("summary") as HTMLElement);
        expect(item?.hasAttribute("open")).toBe(true);
      }
    }
  },
);
