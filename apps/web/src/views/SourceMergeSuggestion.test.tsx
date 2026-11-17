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
import { ApiError } from "../api.js";
import { cardDetail, fakeClient, NOW } from "../testing/fixtures.js";
import { sourceMergeFixture } from "../testing/source-merge-fixture.js";
import { CardDetailPage } from "./CardDetailPage.js";
import { MergeConfirmation } from "./NeedsYouPage.js";

afterEach(cleanup);

test.each(["needs", "card"])(
  "C-311: %s confirms only the displayed source, leaving merge approval and other blockers intact",
  async (surface) => {
    const q = sourceMergeFixture();
    const confirmSourceUnrelated = vi.fn(async () => {});
    const recordDecision = vi.fn(async () => {});
    const client = fakeClient({
      confirmSourceUnrelated,
      recordDecision,
      card: async () => cardDetail({ merge_confirmations: [q] }),
    });
    render(
      surface === "card" ? (
        <CardDetailPage client={client} projectId="p-1" cardId="C-1" />
      ) : (
        <MergeConfirmation
          q={q}
          client={client}
          projectId="p-1"
          elapsed={0}
          done={() => {}}
        />
      ),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "确认来源无关" }),
    );
    await waitFor(() =>
      expect(confirmSourceUnrelated).toHaveBeenCalledWith(
        "p-1",
        "Q-2",
        "C-1",
        "Q-1",
        1,
        expect.any(String),
      ),
    );
    expect(recordDecision).not.toHaveBeenCalled();
    expect(
      screen.getAllByText("敏感卡片的合并须由人亲自确认。").length,
    ).toBeGreaterThan(0);
  },
);

test("C-311: pending writes deduplicate, errors retain the retry key, success focuses the audit", async () => {
  let finish: (error?: Error) => void = () => {};
  const confirmSourceUnrelated = vi.fn(
    () =>
      new Promise<void>((resolve, reject) => {
        finish = (error) => (error ? reject(error) : resolve());
      }),
  );
  const client = fakeClient({ confirmSourceUnrelated });
  const q = sourceMergeFixture();
  const done = vi.fn();
  const props = { client, projectId: "p-1", elapsed: 0, done };
  const view = render(<MergeConfirmation {...props} q={q} />);
  const button = screen.getByRole("button", { name: "确认来源无关" });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(confirmSourceUnrelated).toHaveBeenCalledTimes(1);
  finish(new ApiError(409, "stale_target", "来源建议已变化，请刷新"));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "请求失败：来源建议已变化，请刷新",
  );
  fireEvent.click(button);
  expect(confirmSourceUnrelated.mock.calls[1]).toEqual(
    confirmSourceUnrelated.mock.calls[0],
  );
  finish();
  await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
  view.rerender(
    <MergeConfirmation
      {...props}
      q={{
        ...q,
        source_unrelated_suggestion: {
          ...q.source_unrelated_suggestion,
          confirmed: {
            by: "human",
            at: NOW,
            event_id: "synthetic-confirmation",
          },
        },
      }}
    />,
  );
  const audit = screen.getByRole("region", { name: "来源拍板与合并的关系" });
  await waitFor(() => expect(document.activeElement).toBe(audit));
  expect(within(audit).queryByRole("button")).toBeNull();
  expect(within(audit).getByRole("status").textContent).toContain("由本人确认");
});

test("C-311: stale proposals have no confirmation action; absent proposals add no content", () => {
  const q = sourceMergeFixture();
  const client = fakeClient();
  const props = { client, projectId: "p-1", elapsed: 0, done: () => {} };
  const view = render(
    <MergeConfirmation
      {...props}
      q={{
        ...q,
        source_unrelated_suggestion: {
          ...q.source_unrelated_suggestion,
          stale: true,
        },
      }}
    />,
  );
  expect(screen.queryByRole("button", { name: "确认来源无关" })).toBeNull();
  expect(screen.getByText("建议已失效，请 PM 重新核对")).toBeTruthy();
  const { source_unrelated_suggestion: _source, ...ordinary } = q;
  view.rerender(<MergeConfirmation {...props} q={ordinary} />);
  expect(
    screen.queryByRole("region", { name: "来源拍板与合并的关系" }),
  ).toBeNull();
});
