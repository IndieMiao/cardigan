// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { SettingsGroup, SettingsRow } from "./SettingsLayout.js";

afterEach(cleanup);

test("a collapsible group starts folded and its title toggles the rows", () => {
  render(
    <SettingsGroup title="高级" collapsible>
      <SettingsRow label="重试次数" />
    </SettingsGroup>,
  );
  const toggle = screen.getByRole("button", { name: "高级" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  const rows = document.getElementById(
    toggle.getAttribute("aria-controls") ?? "",
  );
  expect(rows?.hidden).toBe(true);
  expect(screen.getByRole("region", { name: "高级" })).toBeTruthy();
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(rows?.hidden).toBe(false);
  expect(screen.getByText("重试次数")).toBeTruthy();
  fireEvent.click(toggle);
  expect(rows?.hidden).toBe(true);
});

test("plain groups have no disclosure and may start open when collapsible", () => {
  render(
    <>
      <SettingsGroup title="状态">
        <SettingsRow label="绑定状态" />
      </SettingsGroup>
      <SettingsGroup title="高级" collapsible defaultOpen>
        <SettingsRow label="重试次数" />
      </SettingsGroup>
    </>,
  );
  expect(screen.queryByRole("button", { name: "状态" })).toBeNull();
  expect(
    screen.getByRole("button", { name: "高级" }).getAttribute("aria-expanded"),
  ).toBe("true");
  expect(screen.getByText("重试次数").closest("[hidden]")).toBeNull();
});
