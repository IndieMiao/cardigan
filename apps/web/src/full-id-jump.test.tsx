// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { ResolvedReference } from "./api.js";
import { fullIdHref } from "./full-id-jump.js";
import { fakeClient } from "./testing/fixtures.js";
import { CardListPage } from "./views/CardListPage.js";

if (!globalThis.ResizeObserver) {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
}

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

const found: Record<string, ResolvedReference> = {
  "SEN-C-34": {
    kind: "card",
    id: "SEN-C-34",
    local_id: "C-34",
    exists: true,
    status: "in_progress",
    project_id: "sensen-godot",
    card_id: "C-34",
  },
  "SEN-Q-12": {
    kind: "decision",
    id: "SEN-Q-12",
    local_id: "Q-12",
    exists: true,
    status: "open",
    project_id: "sensen-godot",
    card_id: "C-34",
  },
  "SEN-H-46": {
    kind: "human_action",
    id: "SEN-H-46",
    local_id: "H-46",
    exists: true,
    status: "open",
    project_id: "sensen-godot",
  },
};
const resolveFullId = vi.fn(async (id: string) => found[id] ?? null);

test("C-675: a full number leads to its card, decision or human action in its own project", async () => {
  const client = { resolveFullId };
  expect(await fullIdHref(client, " SEN-C-34 ")).toBe(
    "#/p/sensen-godot/cards/C-34",
  );
  expect(await fullIdHref(client, "SEN-Q-12")).toBe(
    "#/p/sensen-godot/cards/C-34?at=decision-Q-12",
  );
  // No card to anchor on: that project's Needs You.
  expect(await fullIdHref(client, "SEN-H-46")).toBe(
    "#/p/sensen-godot/needs-you",
  );
  resolveFullId.mockClear();
  // Short numbers and text never ask the server; unknown numbers lead nowhere.
  for (const value of ["C-34", "部署", "SEN-C-34 x"])
    expect(await fullIdHref(client, value)).toBeUndefined();
  expect(resolveFullId).not.toHaveBeenCalled();
  expect(await fullIdHref(client, "SEN-C-99")).toBeUndefined();
  expect(await fullIdHref({}, "SEN-C-34")).toBeUndefined();
});

test("C-675: Enter on a full number in the card search opens it across projects", async () => {
  render(
    <CardListPage
      client={fakeClient({ resolveFullId })}
      projectId="cardigan"
      view="list"
    />,
  );
  const search = screen.getByLabelText("搜索标题或编号");
  fireEvent.change(search, { target: { value: "SEN-C-34" } });
  fireEvent.keyDown(search, { key: "Enter" });
  await waitFor(() =>
    expect(window.location.hash).toBe("#/p/sensen-godot/cards/C-34"),
  );
});
