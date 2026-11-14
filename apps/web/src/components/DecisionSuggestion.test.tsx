// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { DecisionSuggestionView } from "../api.js";
import { DecisionSuggestion } from "./DecisionSuggestion.js";

afterEach(cleanup);
const suggestion: DecisionSuggestionView = {
  option: "yes",
  rationale: "已核对",
  by: "human",
  at: "2026-01-01T00:00:00Z",
  stale: false,
  progress: {
    count: 1,
    token: "first",
    entries: [
      {
        id: "e1",
        card_id: "C-1",
        at: "2026-01-01T00:00:01Z",
        author_display: "证据作者",
        summary: "新日志指出偶发失败",
      },
    ],
  },
};
test("C-303: show evidence, require confirmation, focus cancel and restore focus", () => {
  const onApply = vi.fn();
  render(
    <DecisionSuggestion
      id="Q-1"
      suggestion={suggestion}
      label="继续"
      busy={false}
      reason=""
      onReason={vi.fn()}
      onApply={onApply}
    />,
  );
  expect(screen.getByText("建议生成后有 1 条新进展")).toBeTruthy();
  const details = screen
    .getByText("建议生成后有 1 条新进展")
    .closest("details");
  expect(details?.open).toBe(false);
  fireEvent.click(screen.getByText("建议生成后有 1 条新进展"));
  expect(screen.getByText("证据作者")).toBeTruthy();
  expect(screen.getByText("新日志指出偶发失败")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "按建议处理" }));
  expect(onApply).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "取消" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "按建议处理" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "按建议处理" }));
  fireEvent.click(
    screen.getByRole("button", { name: "已查看新进展，仍按建议处理" }),
  );
  expect(onApply).toHaveBeenCalledTimes(1);
});

test("C-303: new evidence invalidates an open confirmation; hard stale hides apply", () => {
  const onApply = vi.fn();
  if (!suggestion.progress) throw new Error("Missing fixture progress");
  const props = {
    id: "Q-1",
    label: "继续",
    busy: false,
    reason: "",
    onReason: vi.fn(),
    onApply,
  };
  const { rerender } = render(
    <DecisionSuggestion {...props} suggestion={suggestion} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "按建议处理" }));
  rerender(
    <DecisionSuggestion
      {...props}
      suggestion={{
        ...suggestion,
        progress: { ...suggestion.progress, count: 2, token: "second" },
      }}
    />,
  );
  expect(
    screen.queryByRole("button", { name: "已查看新进展，仍按建议处理" }),
  ).toBeNull();
  expect(screen.getByText("建议生成后有 2 条新进展")).toBeTruthy();
  rerender(
    <DecisionSuggestion
      {...props}
      suggestion={{ ...suggestion, stale: true }}
    />,
  );
  expect(screen.queryByRole("button", { name: "按建议处理" })).toBeNull();
  expect(onApply).not.toHaveBeenCalled();
  const { progress: _progress, ...refreshed } = suggestion;
  rerender(<DecisionSuggestion {...props} suggestion={refreshed} />);
  expect(screen.queryByText(/建议生成后有/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "按建议处理" }));
  expect(onApply).toHaveBeenCalledTimes(1);
});
