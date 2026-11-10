// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { flowLayout, installLayoutStyles } from "../../test-support/layout.js";
import { Drawer } from "./Drawer.js";
import { RequestFeedback, RequestFeedbackScope } from "./RequestFeedback.js";

let removeStyles: () => void;
beforeAll(() => {
  removeStyles = installLayoutStyles();
});
afterAll(() => removeStyles());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test("background requests stay silent until 1 second; fast completion cancels the timer", () => {
  vi.useFakeTimers();
  const view = render(<RequestFeedback pending />);
  const live = screen.getByRole("status");
  expect(live.getAttribute("aria-live")).toBe("polite");
  expect(live.textContent).toBe("");
  act(() => vi.advanceTimersByTime(999));
  expect(live.textContent).toBe("");
  view.rerender(<RequestFeedback pending={false} />);
  act(() => vi.advanceTimersByTime(1000));
  expect(live.textContent).toBe("");
  view.rerender(<RequestFeedback pending />);
  act(() => vi.advanceTimersByTime(999));
  expect(live.textContent).toBe("");
  act(() => vi.advanceTimersByTime(1));
  expect(live.textContent).toBe("正在加载…");
  view.rerender(<RequestFeedback />);
  expect(live.textContent).toBe("");
});

test("writes, errors and results share an out-of-flow stack, with a working retry and polite announcements", () => {
  const retry = vi.fn();
  const content = (pending: boolean, error?: string) => (
    <>
      <h1>标题</h1>
      <RequestFeedback
        interactive
        pending={pending}
        pendingMessage="保存中…"
        error={error}
        retry={retry}
        message="已保存"
      />
      <section>第一块内容</section>
    </>
  );
  const view = render(content(false));
  const before = flowLayout(view.container);
  view.rerender(content(true));
  expect(screen.getByRole("status").textContent).toBe("保存中…");
  expect(flowLayout(view.container)).toEqual(before);
  view.rerender(content(false, "保存失败"));
  const alert = screen.getByRole("alert");
  expect(alert.getAttribute("aria-live")).toBe("polite");
  expect(alert.classList.contains("request-feedback-error")).toBe(true);
  expect(getComputedStyle(alert.parentElement as Element).position).toBe(
    "fixed",
  );
  expect(flowLayout(view.container)).toEqual(before);
  fireEvent.click(within(alert).getByRole("button", { name: "重试" }));
  expect(retry).toHaveBeenCalledOnce();
  view.rerender(content(false));
  expect(screen.getByRole("status").textContent).toBe("已保存");
  expect(flowLayout(view.container)).toEqual(before);
});

test("concurrent messages stack and release their shared region, including StrictMode and pending timers", () => {
  vi.useFakeTimers();
  const view = render(
    <StrictMode>
      <RequestFeedback pending />
      <RequestFeedback message="已提交" />
    </StrictMode>,
  );
  const region = document.querySelector(
    ".request-feedback-region",
  ) as HTMLElement;
  expect(document.querySelectorAll(".request-feedback-region")).toHaveLength(1);
  expect(getComputedStyle(region).display).toBe("flex");
  expect(getComputedStyle(region).flexDirection).toBe("column");
  expect(region.children).toHaveLength(2);
  view.unmount();
  expect(document.querySelector(".request-feedback-region")).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

test("drawer feedback remains inside the accessible dialog and retry stays in its focus scope", () => {
  const retry = vi.fn();
  render(
    <Drawer open onOpenChange={() => {}} title="卡片详情">
      <RequestFeedback error="读取失败" retry={retry} />
    </Drawer>,
  );
  const dialog = screen.getByRole("dialog");
  const alert = within(dialog).getByRole("alert");
  expect(getComputedStyle(alert.parentElement as Element).position).toBe(
    "fixed",
  );
  fireEvent.click(within(alert).getByRole("button", { name: "重试" }));
  expect(retry).toHaveBeenCalledOnce();
});

test("hidden scopes suppress portals, announcements and timers, including nested visible scopes", () => {
  vi.useFakeTimers();
  const content = (hidden: boolean, error?: string) => (
    <RequestFeedbackScope hidden={hidden}>
      <RequestFeedbackScope hidden={false}>
        <input aria-label="草稿" defaultValue="保留草稿" />
        <RequestFeedback pending={!error} error={error} retry={() => {}} />
      </RequestFeedbackScope>
    </RequestFeedbackScope>
  );
  const view = render(content(false));
  const draft = screen.getByLabelText("草稿");
  expect(vi.getTimerCount()).toBe(1);
  view.rerender(content(true));
  expect(vi.getTimerCount()).toBe(0);
  expect(screen.queryByRole("status")).toBeNull();
  view.rerender(content(true, "迟到的错误"));
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(document.querySelector("[aria-live]")).toBeNull();
  expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
  view.rerender(content(false, "迟到的错误"));
  expect(screen.getByRole("alert").textContent).toContain("迟到的错误");
  expect(screen.getByRole("alert").getAttribute("aria-live")).toBe("polite");
  expect(screen.getByLabelText("草稿")).toBe(draft);
});
