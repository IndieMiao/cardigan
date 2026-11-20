// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { FeishuBindingView } from "../api.js";
import { fakeClient } from "../testing/fixtures.js";
import { FeishuSettings } from "./FeishuSettings.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
test("shows pending code, notices expiry, refreshes the binding then confirms unlink", async () => {
  vi.useFakeTimers();
  let bound = false;
  const api = vi.fn(
    async (action?: "code" | "unbind"): Promise<FeishuBindingView> => {
      if (action === "unbind") bound = false;
      return {
        state: "connected",
        bound,
        ...(action === "code"
          ? { code: "FIXTURE123", expires: Date.now() + 4000 }
          : {}),
      };
    },
  );
  await act(async () => {
    render(<FeishuSettings client={fakeClient({ feishuBinding: api })} />);
  });
  expect(screen.getByRole("status").textContent).toBe("未绑定");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "绑定飞书" }));
  });
  expect(screen.getByText("FIXTURE123")).toBeTruthy();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4001);
  });
  expect(screen.getByRole("status").textContent).toBe("绑定码已过期");
  bound = true;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(screen.getByRole("status").textContent).toBe("已绑定");
  fireEvent.click(screen.getByRole("button", { name: "解除绑定" }));
  expect(api).not.toHaveBeenCalledWith("unbind");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "确认解绑" }));
  });
  expect(api).toHaveBeenCalledWith("unbind");
  expect(screen.getByRole("status").textContent).toBe("未绑定");
});
test("reports failure without showing a usable code", async () => {
  const api = vi.fn(async (a?: string) => {
    if (a) throw Error();
    return { state: "connected", bound: false };
  });
  render(<FeishuSettings client={fakeClient({ feishuBinding: api })} />);
  await screen.findByText("未绑定");
  fireEvent.click(screen.getByRole("button", { name: "绑定飞书" }));
  expect((await screen.findByRole("alert")).textContent).toBe("未能生成绑定码");
});
