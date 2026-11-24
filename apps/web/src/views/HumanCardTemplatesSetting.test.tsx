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
import type { PreferencesView, TemplateView } from "../api.js";
import { fakeClient } from "../testing/fixtures.js";
import { SettingsPage } from "./SettingsPage.js";
import { resetSettingWrites } from "./useSettingWrite.js";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);
afterEach(() => {
  cleanup();
  resetSettingWrites();
});

const template = (id: string, title: string): TemplateView => ({
  id,
  title,
  description: "",
  version: 1,
  builtin: true,
  status: "active",
  requires_repo: false,
  merge: "none",
  require_acceptance_criteria: false,
  primary_work_item_key: null,
  work_items: [],
  completion: { mode: "human_mark_done" },
});

/** C-684: the list saves from one dialog but sends only what changed. */
function setup() {
  let stored = ["story"];
  const writes: Record<string, boolean>[] = [];
  const client = fakeClient({
    preferences: async (): Promise<PreferencesView> => ({
      auto_merge_after_minutes: null,
      merge_gate_enabled: true,
      human_card_templates: [...stored],
    }),
    templates: async () => ({
      templates: [
        template("story", "需求卡"),
        template("dev", "开发卡"),
        template("general", "通用卡"),
      ],
    }),
    setHumanCardTemplates: async (_project, changes) => {
      writes.push(changes);
      for (const [id, open] of Object.entries(changes))
        stored = open
          ? [...stored.filter((x) => x !== id), id]
          : stored.filter((x) => x !== id);
    },
  });
  render(<SettingsPage client={client} projectId="p-1" />);
  return {
    writes,
    set stored(next: string[]) {
      stored = next;
    },
  };
}
const row = () =>
  screen.getByText("人可开的卡片模板").closest("[data-settings-row]");
async function edit() {
  fireEvent.click(
    await screen.findByRole("button", { name: "编辑人可开的卡片模板" }),
  );
  return within(
    await screen.findByRole("dialog", { name: "人可开的卡片模板" }),
  );
}

test("the caution group lists what people may open and only the human's ticks are sent", async () => {
  const f = setup();
  await waitFor(() => expect(row()?.textContent).toContain("需求卡"));
  expect(row()?.closest("section")?.textContent).toContain("需谨慎");
  let dialog = await edit();
  const story = dialog.getByRole("checkbox", { name: "需求卡" });
  expect(story.getAttribute("aria-checked")).toBe("true");
  expect((story as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(dialog.getByRole("checkbox", { name: "开发卡" }));
  fireEvent.click(dialog.getByRole("button", { name: "保存可开模板" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(f.writes).toEqual([{ dev: true }]);
  await waitFor(() => expect(row()?.textContent).toContain("需求卡、开发卡"));
  // Someone else opened 通用卡 meanwhile; clearing 开发卡 leaves it alone.
  f.stored = ["story", "dev", "general"];
  fireEvent.click(screen.getByRole("button", { name: "偏好" }));
  dialog = await edit();
  fireEvent.click(dialog.getByRole("checkbox", { name: "开发卡" }));
  fireEvent.click(dialog.getByRole("button", { name: "保存可开模板" }));
  await waitFor(() => expect(f.writes).toHaveLength(2));
  expect(f.writes[1]).toEqual({ dev: false });
});

test("saving without a change sends nothing", async () => {
  const f = setup();
  const dialog = await edit();
  fireEvent.click(dialog.getByRole("button", { name: "保存可开模板" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(f.writes).toEqual([]);
});
