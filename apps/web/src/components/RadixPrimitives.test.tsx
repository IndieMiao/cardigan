// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { Drawer } from "./Drawer.js";
import { Lightbox } from "./Lightbox.js";
import { Menu } from "./Menu.js";
import { MultiSelect } from "./MultiSelect.js";
import { Tooltip } from "./Tooltip.js";
import { ViewSwitch } from "./ViewSwitch.js";

afterEach(cleanup);

class ResizeObserverMock {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (globalThis.ResizeObserver === undefined)
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: ResizeObserverMock,
  });
if (globalThis.PointerEvent === undefined)
  Object.defineProperty(globalThis, "PointerEvent", {
    configurable: true,
    value: MouseEvent,
  });
for (const method of [
  "hasPointerCapture",
  "setPointerCapture",
  "releasePointerCapture",
] as const)
  if (!(method in Element.prototype))
    Object.defineProperty(Element.prototype, method, {
      configurable: true,
      value: () => false,
    });

function DrawerHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button">页面别处</button>
      <Drawer
        open={open}
        onOpenChange={setOpen}
        title="卡片详情"
        description="抽屉内容"
        trigger={<button type="button">打开抽屉</button>}
      >
        <p>抽屉正文</p>
      </Drawer>
    </>
  );
}

test("drawer moves focus inside, closes on Escape/outside and returns focus", async () => {
  render(<DrawerHarness />);
  const trigger = screen.getByRole("button", { name: "打开抽屉" });
  fireEvent.click(trigger);
  const dialog = await screen.findByRole("dialog", { name: "卡片详情" });
  expect(dialog.textContent).toContain("抽屉正文");
  expect(dialog.contains(document.activeElement)).toBe(true);
  expect(document.activeElement?.textContent).toBe("卡片详情");

  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "卡片详情" })).toBeNull(),
  );
  expect(document.activeElement).toBe(trigger);

  fireEvent.click(trigger);
  await screen.findByRole("dialog", { name: "卡片详情" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const outside = screen.getByText("页面别处").closest("button");
  if (outside === null) throw new Error("Missing outside button");
  fireEvent.pointerDown(outside, { button: 0, pointerType: "mouse" });
  fireEvent.click(outside, { button: 0 });
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "卡片详情" })).toBeNull(),
  );
  expect(document.activeElement).toBe(trigger);
});

function LightboxHarness() {
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  return (
    <Lightbox
      open={open}
      onOpenChange={setOpen}
      index={index}
      onIndexChange={setIndex}
      images={[
        { src: "/one.png", alt: "第一张", caption: "图一" },
        { src: "/two.png", alt: "第二张", caption: "图二" },
      ]}
      trigger={<button type="button">打开图片</button>}
    />
  );
}

test("lightbox switches images with arrows and closes back to its trigger", async () => {
  render(<LightboxHarness />);
  const trigger = screen.getByRole("button", { name: "打开图片" });
  fireEvent.click(trigger);
  const dialog = await screen.findByRole("dialog", { name: "第一张" });
  expect(screen.getByRole("img", { name: "第一张" }).getAttribute("src")).toBe(
    "/one.png",
  );
  fireEvent.keyDown(dialog, { key: "ArrowRight" });
  await screen.findByRole("dialog", { name: "第二张" });
  expect(screen.getByRole("img", { name: "第二张" }).getAttribute("src")).toBe(
    "/two.png",
  );
  fireEvent.click(screen.getByRole("button", { name: "上一张" }));
  await screen.findByRole("dialog", { name: "第一张" });
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(trigger);
});

function MenuHarness() {
  const [checked, setChecked] = useState(false);
  const select = vi.fn();
  return (
    <>
      <output>{String(checked)}</output>
      <Menu
        label="显示设置"
        trigger={<button type="button">显示</button>}
        items={[
          {
            id: "number",
            kind: "checkbox",
            label: "编号",
            checked,
            onCheckedChange: setChecked,
          },
          { id: "open", label: "打开完整页面", onSelect: select },
          { id: "disabled", label: "不可用", disabled: true },
        ]}
      />
    </>
  );
}

test("menu supports checkbox items, Escape and focus return", async () => {
  render(<MenuHarness />);
  const trigger = screen.getByRole("button", { name: "显示" });
  fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
  const item = await screen.findByRole("menuitemcheckbox", { name: "编号" });
  expect(item.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(item);
  await waitFor(() => expect(screen.getByText("true")).toBeTruthy());
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(document.activeElement).toBe(trigger);
});

function MultiSelectHarness() {
  const [values, setValues] = useState<string[]>([]);
  return (
    <>
      <button type="button">页面别处</button>
      <MultiSelect
        label="状态"
        options={[
          { value: "open", label: "进行中" },
          { value: "review", label: "审核中" },
        ]}
        values={values}
        onChange={setValues}
      />
    </>
  );
}

test("multiselect toggles checkbox values, closes outside and returns focus", async () => {
  render(<MultiSelectHarness />);
  const trigger = screen.getByRole("button", { name: "状态：全部" });
  fireEvent.click(trigger);
  const open = await screen.findByRole("checkbox", { name: "进行中" });
  fireEvent.click(open);
  await screen.findByRole("button", { name: "状态：进行中" });
  expect((open as HTMLInputElement).checked).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 10));

  const outside = screen.getByRole("button", { name: "页面别处" });
  fireEvent.pointerDown(outside, { button: 0, pointerType: "mouse" });
  fireEvent.click(outside, { button: 0 });
  await waitFor(() =>
    expect(screen.queryByRole("checkbox", { name: "进行中" })).toBeNull(),
  );
  expect(document.activeElement).toBe(trigger);
});

function ViewSwitchHarness() {
  const [value, setValue] = useState("list");
  return (
    <ViewSwitch
      label="视图"
      value={value}
      onChange={setValue}
      options={[
        { value: "list", label: "列表", icon: "☷" },
        { value: "board", label: "看板", icon: "▦" },
      ]}
    />
  );
}

test("view switch exposes pressed state and keeps one selection", async () => {
  render(<ViewSwitchHarness />);
  const list = screen.getByRole("button", { name: "列表" });
  const board = screen.getByRole("button", { name: "看板" });
  expect(list.getAttribute("aria-pressed")).toBe("true");
  expect(board.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(board);
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "看板" }).getAttribute("aria-pressed"),
    ).toBe("true"),
  );
  expect(
    screen.getByRole("button", { name: "列表" }).getAttribute("aria-pressed"),
  ).toBe("false");
});

test("tooltip appears on keyboard focus and disappears on blur", async () => {
  render(
    <Tooltip content="在完整页面打开">
      <button type="button">打开</button>
    </Tooltip>,
  );
  const trigger = screen.getByRole("button", { name: "打开" });
  trigger.focus();
  expect(await screen.findByRole("tooltip")).toBeTruthy();
  expect(screen.getByRole("tooltip").textContent).toContain("在完整页面打开");
  trigger.blur();
  await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
});

test("radix primitive styles use shared tokens, focus styles and the dark theme", () => {
  const css = readFileSync(
    new NodeURL("../styles.css", import.meta.url),
    "utf8",
  );
  for (const selector of [
    ".drawer-content",
    ".lightbox-content",
    ".menu-content",
    ".multiselect-content",
    ".view-switch",
    ".tooltip-content",
  ])
    expect(css).toContain(selector);
  expect(css).toContain(":focus-visible");
  expect(css).toContain("@media (prefers-color-scheme: dark)");
  expect(css).toContain("--overlay: rgba(0, 0, 0, 0.55);");
  const drawer = css.slice(
    css.indexOf(".drawer-content {"),
    css.indexOf("}", css.indexOf(".drawer-content {")),
  );
  expect(drawer).toContain("background: var(--surface);");
  expect(drawer).toContain("color: var(--text);");
  const menu = css.slice(
    css.indexOf(".menu-content"),
    css.indexOf("}", css.indexOf(".menu-content")),
  );
  expect(menu).toContain("background: var(--surface);");
  expect(css).toContain('.view-switch-item[data-state="on"]');
  expect(css).toContain(".drawer-divider");
  expect(css).toContain("@keyframes drawer-slide-in");
});
