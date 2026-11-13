// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { lazy } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { PageLoader } from "./PageLoader.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("a pending page keeps the shell usable and renders when its chunk arrives", async () => {
  let resolve!: (module: { default: () => React.JSX.Element }) => void;
  const View = lazy(
    () =>
      new Promise<{ default: () => React.JSX.Element }>((done) => {
        resolve = done;
      }),
  );
  render(
    <>
      <a href="#/p/p-1/cards">卡片</a>
      <PageLoader>
        <View />
      </PageLoader>
    </>,
  );
  expect(screen.getByRole("link", { name: "卡片" })).toBeTruthy();
  expect(screen.queryByRole("heading")).toBeNull();
  await act(async () => {
    resolve({ default: () => <h1>按需页面</h1> });
  });
  expect(screen.getByRole("heading", { name: "按需页面" })).toBeTruthy();
});

test("a missing deployment chunk offers a visible reload action", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const View = lazy(() => Promise.reject(new Error("chunk missing")));
  render(
    <PageLoader>
      <View />
    </PageLoader>,
  );
  expect(await screen.findByRole("button", { name: "重新加载" })).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain("页面加载失败");
});
