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

test.each([
  {
    name: "drawer",
    Harness: DrawerHarness,
    triggerName: "打开抽屉",
    closeName: "关闭抽屉",
    buttonNames: ["关闭抽屉"],
  },
  {
    name: "lightbox",
    Harness: LightboxHarness,
    triggerName: "打开图片",
    closeName: "关闭预览",
    buttonNames: ["关闭预览", "上一张", "下一张"],
  },
])(
  "$name controls have at least 44px targets and close back to their trigger",
  async ({ Harness, triggerName, closeName, buttonNames }) => {
    const style = document.createElement("style");
    style.textContent = readFileSync(
      new NodeURL("../styles.css", import.meta.url),
      "utf8",
    );
    document.head.append(style);
    try {
      render(<Harness />);
      const trigger = screen.getByRole("button", { name: triggerName });
      fireEvent.click(trigger);
      await screen.findByRole("dialog");
      for (const name of buttonNames) {
        const button = screen.getByRole("button", { name });
        const computed = getComputedStyle(button);
        expect(parseFloat(computed.minWidth), name).toBeGreaterThanOrEqual(44);
        expect(parseFloat(computed.minHeight), name).toBeGreaterThanOrEqual(44);
      }
      fireEvent.click(screen.getByRole("button", { name: closeName }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(document.activeElement).toBe(trigger);
    } finally {
      style.remove();
    }
  },
);

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
  expect(open.getAttribute("aria-checked")).toBe("true");
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

test("U6a a preview opened over the drawer owns the only mask in the viewport", async () => {
  render(
    <Drawer open onOpenChange={() => {}} title="卡片详情">
      <LightboxHarness />
    </Drawer>,
  );
  expect(document.body.getAttribute("data-lightbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "打开图片" }));
  await screen.findByRole("dialog", { name: "第一张" });
  expect(document.body.getAttribute("data-lightbox")).toBe("open");
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() =>
    expect(document.body.getAttribute("data-lightbox")).toBeNull(),
  );
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
  expect(css).toContain('.view-switch-item[aria-pressed="true"]');
  expect(css).toContain(".drawer-divider");
  expect(css).toContain("@keyframes drawer-slide-in");
  // §9 U6a: layers are ordered and a preview mask replaces the drawer mask.
  const layer = (selector: string) => {
    const start = css.indexOf(`${selector} {`);
    expect(start).toBeGreaterThanOrEqual(0);
    return css.slice(start, css.indexOf("}", start) + 1);
  };
  expect(layer(".drawer-content")).toContain("z-index: 101;");
  expect(layer(".lightbox-overlay")).toContain("z-index: 200;");
  expect(layer(".lightbox-content")).toContain("z-index: 201;");
  const close = layer(".lightbox-close");
  expect(close).toContain("position: absolute;");
  expect(close).toContain("top: 20px;");
  expect(close).toContain("right: 24px;");
  // Keep the full close target above the later, positioned image stage.
  expect(close).toContain("z-index: 1;");
  expect(close).toContain("background: var(--surface);");
  expect(close).toContain("color: var(--text);");
  expect(layer(".tooltip-content")).toContain("z-index: 120;");
  const tooltip = layer(".tooltip-content");
  expect(tooltip).toContain("background: var(--tooltip-bg);");
  expect(tooltip).toContain("color: var(--tooltip-text);");
  expect(tooltip).toContain("border: 1px solid var(--tooltip-border);");
  expect(tooltip).toContain("box-shadow:");
  expect(tooltip).toContain(
    "max-width: min(280px, calc(100vw - var(--gap) * 2));",
  );
  expect(layer(".tooltip-arrow")).toContain("fill: var(--tooltip-bg);");
  expect(css).toContain('body[data-lightbox="open"] .drawer-overlay {');
});

test("tooltip colors remain dark with AA text contrast and a visible edge in both themes", () => {
  const css = readFileSync(
    new NodeURL("../styles.css", import.meta.url),
    "utf8",
  );
  const themes = [...css.matchAll(/:root\s*\{([^}]+)\}/g)];
  expect(themes).toHaveLength(2);
  for (const theme of themes) {
    const luminance = (token: string) => {
      const hex = new RegExp(`--${token}: #([0-9a-f]{6});`).exec(
        theme[1] ?? "",
      )?.[1];
      expect(hex).toBeDefined();
      const channels = [0, 2, 4].map((offset) => {
        const value =
          Number.parseInt(hex?.slice(offset, offset + 2) ?? "", 16) / 255;
        return value <= 0.04045
          ? value / 12.92
          : ((value + 0.055) / 1.055) ** 2.4;
      });
      return channels.reduce(
        (sum, channel, index) =>
          sum + channel * ([0.2126, 0.7152, 0.0722][index] ?? 0),
        0,
      );
    };
    const background = luminance("tooltip-bg");
    const text = luminance("tooltip-text");
    const border = luminance("tooltip-border");
    expect(background).toBeLessThan(0.1);
    expect(text).toBeGreaterThan(0.8);
    expect((text + 0.05) / (background + 0.05)).toBeGreaterThanOrEqual(4.5);
    expect((border + 0.05) / (background + 0.05)).toBeGreaterThanOrEqual(3);
    if (theme[1]?.includes("color-scheme: dark"))
      expect((border + 0.05) / (luminance("bg") + 0.05)).toBeGreaterThanOrEqual(
        3,
      );
  }
});
