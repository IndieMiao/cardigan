// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { ID_TYPES, UNKNOWN_ID_TYPE } from "../id-types.js";
import { linkifyReferences } from "../refs.js";
import { EmployeeIdentity } from "./EmployeeIdentity.js";
import { IdentityRow } from "./IdentityRow.js";
import { IdBadge, IdTag } from "./IdTag.js";
import { Markdown } from "./Operations.js";

afterEach(cleanup);

test("all number types keep the full prefix and a Chinese explanation without inventing links", () => {
  const { container } = render(
    <>
      {ID_TYPES.map(({ prefix }) => (
        <IdTag key={prefix} id={`${prefix}-12`} />
      ))}
      <IdTag id="C-12#34" />
      <IdTag id="ZZ-9" />
      <IdTag id="local" />
      <IdBadge id="f52c6f33a2232ff9aea852d76a42c8321fc459ed" />
    </>,
  );
  for (const { prefix, label, token } of ID_TYPES) {
    const badge = screen.getByText(`${prefix}-12`);
    expect(badge.className).toBe(`id-badge id-type-${token}`);
    expect(badge.parentElement?.textContent).toBe(`${prefix}-12 ${label}`);
  }
  expect(screen.getByText("C-12#34").parentElement?.textContent).toBe(
    "C-12#34 时间线条目",
  );
  expect(screen.getByText("ZZ-9").parentElement?.textContent).toBe(
    "ZZ-9 未知类型",
  );
  expect(container.querySelectorAll(".id-plain")).toHaveLength(2);
  expect(screen.queryByRole("link")).toBeNull();
});

test("resolved prose links share the palette, preserving historical spelling and unlinked text", () => {
  const body = linkifyReferences(
    "C-12#34 Q-8 q(8) 未解析 W-9 和 C-999。`C-12#34` [Q-8 <img src=x>](#/p/p/cards/C-12?at=decision-Q-8)",
    [
      { kind: "timeline_entry", id: "C-12#34" },
      { kind: "decision", id: "Q-8" },
    ],
    "p",
    "C-12",
  );
  const { container } = render(<Markdown body={body} />);
  expect(container.querySelectorAll("a")).toHaveLength(4);
  expect(container.querySelector(".id-type-card")?.textContent).toBe("C-12#34");
  expect(container.querySelectorAll(".id-type-decision")).toHaveLength(3);
  expect(screen.getByText("q(8)")).toBeTruthy();
  expect(container.textContent).toContain("未解析 W-9 和 C-999");
  expect(container.querySelector("code")?.textContent).toBe("C-12#34");
  expect(container.querySelector("code .id-badge, img, a a")).toBeNull();
  expect(container.querySelector("a")?.getAttribute("href")).toContain(
    "entry-C-12%2334",
  );
});

test("an identity row keeps the person and destination separately operable and the full profile available", () => {
  const employee = {
    id: "E-1",
    name: "孙悟空",
    title: "开发工程师",
    role_id: "coder",
    avatar: null,
  };
  const { container } = render(
    <IdentityRow>
      <EmployeeIdentity employee={employee} />
      <IdTag
        id="W-586"
        label="开发"
        href="#/p/p/cards/C-1?at=work-item-W-586"
      />
      <code>d9cf21d630b1</code>
      <a href="#/p/p/cards/C-1?at=delivery-D-1">查看改动</a>
    </IdentityRow>,
  );
  expect(
    container.querySelector<HTMLElement>(".employee-avatar")?.style.width,
  ).toBe("24px");
  expect(screen.queryByText("开发工程师")).toBeNull();
  expect(screen.getAllByRole("link")).toHaveLength(2);
  const person = screen.getByRole("button", { name: "孙悟空的员工卡片" });
  fireEvent.click(person);
  expect(screen.getByText("开发工程师")).toBeTruthy();
  expect(
    document.querySelector<HTMLElement>(".employee-card > .employee-avatar")
      ?.style.width,
  ).toBe("64px");
  expect(container.querySelector("button a, a button")).toBeNull();
});

test("every shared palette meets normal-text AA in both themes", () => {
  const css = readFileSync(
    new NodeURL("../styles.css", import.meta.url),
    "utf8",
  );
  const boundary = css.indexOf("@media (prefers-color-scheme: dark)");
  const light = css.slice(0, boundary);
  const dark = css.slice(boundary, css.indexOf("\n* {", boundary));
  const vars = (text: string) =>
    new Map(
      [...text.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2]]),
    );
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map(
      (i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255,
    );
    return channels.reduce(
      (sum, c, i) =>
        sum +
        (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) *
          ([0.2126, 0.7152, 0.0722][i] ?? 0),
      0,
    );
  };
  for (const theme of [light, dark]) {
    const values = new Map([...vars(light), ...vars(theme)]);
    const resolve = (key: string): string => {
      const value = values.get(key) ?? "";
      return value.startsWith("var(") ? resolve(value.slice(4, -1)) : value;
    };
    for (const { token } of [...ID_TYPES, UNKNOWN_ID_TYPE]) {
      const fg = luminance(resolve(`--id-${token}-fg`));
      const bg = luminance(resolve(`--id-${token}-bg`));
      expect(
        (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05),
        token,
      ).toBeGreaterThanOrEqual(4.5);
    }
  }
});
