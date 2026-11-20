// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ApiError, type FeishuBindingView } from "../api.js";
import { fakeClient } from "../testing/fixtures.js";
import { FeishuSettings } from "./FeishuSettings.js";
import { SettingsPage } from "./SettingsPage.js";
import { resetSettingWrites, SettingsSaveNotice } from "./useSettingWrite.js";

afterEach(() => {
  cleanup();
  resetSettingWrites();
  window.location.hash = "";
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
  expect(screen.getByText("未绑定")).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "绑定飞书" }));
  });
  expect(screen.getByText("FIXTURE123")).toBeTruthy();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4001);
  });
  expect(screen.getByText("绑定码已过期")).toBeTruthy();
  bound = true;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(screen.getByText("已绑定")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "解除绑定" }));
  expect(api).not.toHaveBeenCalledWith("unbind");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "确认解绑" }));
  });
  expect(api).toHaveBeenCalledWith("unbind");
  expect(screen.getByText("未绑定")).toBeTruthy();
});
test("shows the server's recovery reason in the feedback stack and retires it after binding", async () => {
  vi.useFakeTimers();
  let bound = false;
  const api = vi.fn(async (action?: string) => {
    if (action) throw new ApiError(403, "owner_required", "请重新登录");
    return { state: "connected", bound };
  });
  await act(async () => {
    render(<FeishuSettings client={fakeClient({ feishuBinding: api })} />);
  });
  await act(async () => {
    fireEvent.click(screen.getByText("绑定飞书"));
  });
  const alert = screen.getByRole("alert");
  expect(alert.textContent).toContain("未能生成飞书绑定码：请重新登录");
  expect(alert.closest(".request-feedback-region")).not.toBeNull();
  bound = true;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(screen.getByText("已绑定")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

test.each(["panel", "page"])(
  "reports a late unlink failure once after leaving the %s, with a way back",
  async (leave) => {
    let fail!: (cause: Error) => void;
    const api = vi.fn(async (action?: string) => {
      if (action)
        await new Promise<never>((_, reject) => {
          fail = reject;
        });
      return { state: "connected", bound: true };
    });
    window.location.hash = "#/p/p-1/settings?tab=feishu";
    const client = fakeClient({ feishuBinding: api });
    const view = (settings: boolean) => (
      <>
        <SettingsSaveNotice />
        {settings && <SettingsPage projectId="p-1" client={client} />}
      </>
    );
    const { rerender } = render(view(true));
    fireEvent.click(await screen.findByRole("button", { name: "解除绑定" }));
    expect(document.activeElement?.textContent).toBe("取消");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(document.activeElement?.textContent).toBe("解除绑定");
    fireEvent.click(screen.getByText("解除绑定"));
    const submit = screen.getByRole("button", { name: "确认解绑" });
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(api.mock.calls.filter(([a]) => a === "unbind")).toHaveLength(1);
    if (leave === "panel")
      fireEvent.click(screen.getByRole("button", { name: "偏好" }));
    else {
      rerender(view(false));
      window.location.hash = "#/p/p-1/cards";
    }
    await act(async () => {
      fail(
        new ApiError(
          409,
          "binding_unavailable",
          "当前不能执行绑定操作，请刷新",
        ),
      );
    });
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByText("未能解除飞书绑定，请回到设置重试")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "回到设置" }));
    if (leave === "page") {
      expect(window.location.hash).toContain("settings?tab=feishu");
      rerender(view(true));
    }
    expect(
      await screen.findByText(
        /未能解除飞书绑定：.*当前不能执行绑定操作，请刷新/,
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "回到设置" })).toBeNull();
  },
);

test("canceling an unlink confirmation clears the last attempt's failure", async () => {
  const api = vi.fn(async (a?: string) => {
    if (a) throw new Error("请刷新");
    return { state: "connected", bound: true };
  });
  render(<FeishuSettings client={fakeClient({ feishuBinding: api })} />);
  fireEvent.click(await screen.findByRole("button", { name: "解除绑定" }));
  fireEvent.click(screen.getByRole("button", { name: "确认解绑" }));
  expect(await screen.findByText("未能解除飞书绑定：请刷新")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("alert")).toBeNull();
});

test("an older poll cannot restore the binding after unlinking", async () => {
  vi.useFakeTimers();
  let bound = true;
  let release: (() => void) | undefined;
  const api = vi.fn(async (action?: string) => {
    if (action === "unbind") bound = false;
    return { state: "connected", bound };
  });
  await act(async () => {
    render(<FeishuSettings client={fakeClient({ feishuBinding: api })} />);
  });
  api.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ state: "connected", bound: true });
      }),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(release).toBeTypeOf("function");
  fireEvent.click(screen.getByText("解除绑定"));
  await act(async () => {
    fireEvent.click(screen.getByText("确认解绑"));
  });
  expect(screen.getByText("未绑定")).toBeTruthy();
  await act(async () => {
    release?.();
  });
  expect(screen.getByText("未绑定")).toBeTruthy();
});
