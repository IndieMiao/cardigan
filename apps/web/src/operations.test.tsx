// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { HttpCardiganClient } from "./api.js";
import { CopyCommand, cliCommand, Markdown } from "./components/Operations.js";
import { useResource } from "./useResource.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("Needs You client writes the right routes and JSON with the browser session", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response("{}", { headers: { "content-type": "application/json" } }),
    );
  const client = new HttpCardiganClient(async (...args) =>
    (await fetcher(...args)).clone(),
  );
  await client.needsYou("p/a");
  await client.recordDecision("p/a", "q(1)", "merge", "  好  ");
  await client.decisionComment("p/a", "q(1)", "request_information", "说明");
  await client.decisionComment("p/a", "q(1)", "explain", "");
  await client.completeAction("p/a", "h(2)", "已执行");
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    "/api/projects/p%2Fa/needs-you",
    "/api/projects/p%2Fa/decisions/q(1)/resolve",
    "/api/projects/p%2Fa/decisions/q(1)/comments",
    "/api/projects/p%2Fa/decisions/q(1)/comments",
    "/api/projects/p%2Fa/human-actions/h(2)/complete",
  ]);
  expect(
    fetcher.mock.calls
      .slice(1)
      .map(([, init]) => JSON.parse(String(init?.body))),
  ).toEqual([
    { option: "merge", raw_quote: "  好  " },
    { action: "request_information", body: "说明" },
    { action: "explain" },
    { text: "已执行" },
  ]);
  for (const [, init] of fetcher.mock.calls)
    expect(init?.credentials).toBe("same-origin");
});

test("resource changes ignore slow old responses and retain data on a failed refresh", async () => {
  let settle: (value: string) => void = () => {};
  const old = () =>
    new Promise<string>((resolve) => {
      settle = resolve;
    });
  const next = vi.fn<() => Promise<string>>().mockResolvedValue("new project");
  const { result, rerender } = renderHook(({ load }) => useResource(load), {
    initialProps: { load: old },
  });
  rerender({ load: next });
  await waitFor(() => expect(result.current.data).toBe("new project"));
  await act(async () => settle("abandoned"));
  expect(result.current.data).toBe("new project");
  next.mockRejectedValueOnce(new Error("offline"));
  act(() => result.current.reload());
  await waitFor(() => expect(result.current.error).toBe("offline"));
  expect(result.current.data).toBe("new project");
  act(() => result.current.reload());
  await waitFor(() => expect(result.current.error).toBeUndefined());
});

test("commands quote project values, copy explicitly and fall back to visible text", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const command = cliCommand("p'$(echo injected)", "worktree diff", "A-1");
  expect(command).toBe(
    "cardigan worktree diff 'A-1' --project 'p'\\''$(echo injected)'",
  );
  render(<CopyCommand label="查看 Diff" command={command} />);
  expect(
    screen.getByText("deploy/install-cli.sh").parentElement?.textContent,
  ).toBe("需要先用 deploy/install-cli.sh 安装 cardigan 命令。");
  fireEvent.click(screen.getByRole("button", { name: "复制查看 Diff" }));
  await screen.findByText("已复制");
  expect(writeText).toHaveBeenCalledWith(command);
  writeText.mockRejectedValueOnce(new Error("denied"));
  fireEvent.click(screen.getByRole("button", { name: "复制查看 Diff" }));
  await screen.findByText("复制失败，请选中命令手动复制。");
  expect(screen.getByText(command)).toBeTruthy();
});

test("operation bodies use the established safe Markdown renderer", () => {
  const { container } = render(
    <Markdown
      body={
        '<img src=x onerror="alert(1)"> [危险](javascript:alert(1)) **说明**'
      }
    />,
  );
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
  expect(container.querySelector("strong")?.textContent).toBe("说明");
});
