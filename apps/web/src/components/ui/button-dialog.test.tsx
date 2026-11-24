// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { Button } from "./button.js";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./dialog.js";

afterEach(cleanup);
const theme = readFileSync(new NodeURL("./theme.css", import.meta.url), "utf8");
const rule = (selector: string) => {
  const start = theme.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThan(-1);
  return theme.slice(start, theme.indexOf("}", start));
};

test("emphasis is its own variant; primary keeps the selected fill", () => {
  render(
    <>
      <Button variant="emphasis">确认</Button>
      <Button variant="primary">保存</Button>
    </>,
  );
  const emphasis = screen.getByRole("button", { name: "确认" });
  const primary = screen.getByRole("button", { name: "保存" });
  expect(emphasis.className).toContain("ui-button-emphasis");
  expect(emphasis.className).not.toContain("ui-button-primary");
  expect(primary.className).toContain("ui-button-primary");
  expect(primary.className).not.toContain("ui-button-emphasis");
  expect(rule(".ui-button-emphasis")).toMatch(
    /background: var\(--accent\);\s+color: var\(--accent-contrast\);/,
  );
  expect(rule(".ui-button-primary")).toMatch(
    /background: var\(--ui-selected\);\s+color: var\(--ui-selected-text\);/,
  );
  expect(theme).toMatch(/--accent: #525252;\s+--accent-hover: #3d3d3d;/);
  expect(theme).toMatch(/--accent-contrast: #ffffff;/);
  expect(theme).toMatch(/--accent: #c2c2c2;\s+--accent-hover: #d9d9d9;/);
  expect(theme).toMatch(/--accent-contrast: #181818;/);
});

test("DialogFooter sits after the scrolling body, in the panel or in one form", () => {
  render(
    <Dialog open>
      <DialogContent aria-describedby={undefined}>
        <form>
          <DialogHeader>
            <DialogTitle>标记完成</DialogTitle>
          </DialogHeader>
          <DialogBody>内容</DialogBody>
          <DialogFooter>
            <Button size="regular">取消</Button>
            <Button size="regular" variant="emphasis" type="submit">
              确认完成
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>,
  );
  const dialog = screen.getByRole("dialog", { name: "标记完成" });
  const form = dialog.querySelector(":scope > form");
  const parts = [...(form?.children ?? [])].map((e) => e.className);
  expect(parts).toEqual([
    "ui-dialog-header",
    "ui-dialog-body",
    "ui-dialog-footer",
  ]);
  expect(
    screen.getByRole("button", { name: "确认完成" }).closest("div")?.className,
  ).toBe("ui-dialog-footer");
  // Layout: the panel stops scrolling, the body scrolls, the footer stays.
  expect(theme).toMatch(
    /\.ui-dialog:not\(\.ui-sheet\):has\(\s*> \.ui-dialog-footer,\s*> form > \.ui-dialog-footer\s*\)/,
  );
  expect(rule(".ui-dialog-body")).toMatch(/min-height: 0;\s+overflow-y: auto;/);
  expect(rule(".ui-dialog-footer")).toMatch(/flex: none;/);
});
