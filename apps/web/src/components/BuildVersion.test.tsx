// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { BuildVersion } from "./BuildVersion.js";

const sha = "60eb95489d5361cca6040ab9517a05289eb7ab03";
const builtAt = new Date(2026, 10, 17, 6, 56).toISOString();
const build = { sha, built_at: builtAt, development: false };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("renders browser-local build time, exposes full details on focus and copies full SHA", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  render(<BuildVersion build={build} />);
  const button = screen.getByRole("button", { name: `复制完整版本 ${sha}` });
  expect(button.textContent).toBe("60eb954 · 11-17 06:56");
  fireEvent.focus(button);
  expect((await screen.findByRole("tooltip")).textContent).toContain(sha);
  expect(screen.getByRole("tooltip").textContent).toContain(
    new Date(builtAt).toLocaleString(),
  );
  fireEvent.click(button);
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(sha));
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toBe("已复制"),
  );
});

test("clipboard failure is reported truthfully", async () => {
  vi.stubGlobal("navigator", {
    clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
  });
  render(<BuildVersion build={build} />);
  fireEvent.click(screen.getByRole("button"));
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toContain("复制失败"),
  );
});

test("source-only and git-free development have usable fallbacks", () => {
  const { rerender } = render(
    <BuildVersion build={{ ...build, development: true, built_at: null }} />,
  );
  expect(screen.getByRole("button").textContent).toBe("dev 60eb954");
  rerender(
    <BuildVersion build={{ sha: null, built_at: null, development: true }} />,
  );
  expect(screen.getByText("dev")).toBeDefined();
  expect(screen.queryByRole("button")).toBeNull();
});
