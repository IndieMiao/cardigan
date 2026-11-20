// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { HttpCardiganClient } from "../api.js";
import { changeControl } from "../testing/controls.js";
import { LaunchProfileSelect } from "./LaunchProfileSelect.js";

afterEach(cleanup);

function setup(value: string | null, roleProfile?: string) {
  const onChange = vi.fn();
  render(
    <LaunchProfileSelect
      aria-label="启动配置"
      value={value}
      profiles={["claude-opus", "codex-sol"]}
      roleProfile={roleProfile}
      onChange={onChange}
    />,
  );
  return {
    onChange,
    select: screen.getByRole("combobox", { name: /启动配置/ }),
  };
}
const options = () => {
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
  return screen.getAllByRole("option").map((option) => option.textContent);
};

test("offers the valid profiles and following the role", () => {
  const { select, onChange } = setup(null, "claude-opus");
  expect(select.textContent).toContain("跟随角色（claude-opus）");
  changeControl(select, { target: { value: "codex-sol" } });
  expect(onChange).toHaveBeenLastCalledWith("codex-sol");
  expect(options()).toEqual([
    "跟随角色（claude-opus）",
    "claude-opus",
    "codex-sol",
  ]);
});

test("clearing a pinned profile follows the role", () => {
  const { select, onChange } = setup("codex-sol");
  expect(select.textContent).toContain("codex-sol");
  changeControl(select, { target: { value: "" } });
  expect(onChange).toHaveBeenLastCalledWith(null);
});

test("a saved profile the host no longer accepts stays visible as invalid", () => {
  const { select } = setup("removed");
  expect(select.textContent).toContain("removed（已失效）");
  changeControl(select, { target: { value: "removed" } });
  expect(options()).toEqual([
    "跟随角色",
    "removed（已失效）",
    "claude-opus",
    "codex-sol",
  ]);
});

test("the client reads the valid profile names from the global endpoint", async () => {
  const fetch = vi.fn(
    async () =>
      new Response(JSON.stringify({ profiles: ["claude-opus"] }), {
        status: 200,
      }),
  );
  const client = new HttpCardiganClient(
    fetch as unknown as typeof globalThis.fetch,
  );
  expect(await client.launchProfileNames()).toEqual({
    profiles: ["claude-opus"],
  });
  expect(fetch.mock.calls[0]?.[0]).toBe("/api/launch-settings/profiles");
});
