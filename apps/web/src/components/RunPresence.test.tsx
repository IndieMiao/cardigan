// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { AuthorView } from "../api.js";
import {
  runPresence,
  runPresenceLabel,
  runPresenceText,
  runRing,
} from "../run-presence.js";
import { EmployeeIdentity, ProduceOwners } from "./EmployeeIdentity.js";

// C-531: avatars show what this person does for this card (scheme A).

const person = (n: number, name: string): AuthorView => ({
  employee: {
    id: `E-${n}`,
    name,
    title: "工程师",
    role_id: "coder",
    avatar: null,
  },
  author: `assignment:A-${n}`,
  author_role: "coder",
  author_display: name,
});

afterEach(cleanup);

describe("state copy and ring", () => {
  test.each([
    [{ state: "running" }, "赵云，正在为这张卡运行", "running"],
    [{ state: "queued" }, "晴雯，已排队，等待机器", "queued"],
    [{ state: "waiting", waiting: "precheck" }, "林黛玉，等待预检", null],
    [{ state: "waiting", waiting: "decision" }, "林黛玉，等待拍板", null],
    [{ state: "waiting", waiting: "blocked" }, "林黛玉，已阻塞", null],
    [{ state: "idle" }, "张良，已指派，当前无运行", null],
    [{ state: "unknown" }, "张良，运行状态未知", null],
  ] as const)("%o reads “%s”", (value, label, ring) => {
    const presence = runPresence(value);
    expect(runPresenceLabel(label.split("，")[0] ?? "", presence)).toBe(label);
    expect(runRing(presence)).toBe(ring);
  });

  test("missing or malformed facts are unknown, never idle", () => {
    for (const value of [
      undefined,
      null,
      "running",
      {},
      { state: "sleeping" },
      { state: "waiting" },
      { state: "waiting", waiting: "lunch" },
    ])
      expect(runPresenceText(runPresence(value))).toBe("运行状态未知");
  });
});

describe("board participants", () => {
  const owners = [
    { ...person(1, "赵云"), run_presence: { state: "running" } },
    { ...person(2, "晴雯"), run_presence: { state: "queued" } },
    {
      ...person(3, "林黛玉"),
      run_presence: { state: "waiting", waiting: "precheck" },
    },
    { ...person(4, "张良"), run_presence: { state: "idle" } },
    { ...person(5, "关羽"), run_presence: { state: "running" } },
    person(6, "无名"),
  ];

  test("names are “姓名，状态”, and only running and queued avatars get a ring", () => {
    const { container } = render(
      <ProduceOwners owners={owners} label="参与员工" presence />,
    );
    const group = screen.getByRole("group", { name: "参与员工" });
    for (const name of [
      "赵云，正在为这张卡运行",
      "晴雯，已排队，等待机器",
      "林黛玉，等待预检",
    ])
      expect(within(group).getByRole("button", { name })).toBeTruthy();
    const rings = [...container.querySelectorAll("[data-run]")];
    expect(rings.map((ring) => ring.getAttribute("data-run"))).toStrictEqual([
      "running",
      "queued",
    ]);
    // The ring is decoration: hidden, never focusable.
    for (const ring of rings) {
      expect(ring.getAttribute("aria-hidden")).toBe("true");
      expect(ring.querySelector("[tabindex]")).toBeNull();
    }
    // +N keeps its slot, does not spin and names hidden runners.
    const more = within(group).getByRole("button", {
      name: "另有 3 位参与员工，其中正在为这张卡运行：关羽",
    });
    expect(more.textContent).toBe("+3");
    expect(more.querySelector("[data-run]")).toBeNull();
  });

  test("other hosts keep the plain avatar and original names", () => {
    const { container } = render(
      <ProduceOwners owners={owners.slice(0, 2)} label="产出负责人" />,
    );
    expect(container.querySelector("[data-run]")).toBeNull();
    expect(screen.getByRole("button", { name: "赵云的员工卡片" })).toBeTruthy();
  });

  test("an avatar without a profile uses the same string for hover and name", () => {
    render(
      <EmployeeIdentity
        author="assignment:A-9"
        author_role="coder"
        author_display="未命名的 coder"
        avatarOnly
        presence={{ state: "running" }}
      />,
    );
    expect(
      screen.getByRole("img", { name: "未命名的 coder，正在为这张卡运行" }),
    ).toBeTruthy();
  });
});

test("only the running disc animates, by transform, and both fallbacks stop it", () => {
  const css = readFileSync(
    new NodeURL("./layout/RunRingLayout.module.css", import.meta.url),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  const animated = [...css.matchAll(/([^{}]+)\{[^{}]*animation:\s*orbit/g)];
  expect(animated.map((m) => m[1]?.trim())).toStrictEqual([
    '.ring[data-run="running"] > .disc::after',
  ]);
  // The keyframes only rotate; no size, border, filter or shadow per frame.
  expect(css).toMatch(
    /@keyframes orbit \{\s*to \{\s*transform: rotate\(1turn\);\s*\}\s*\}/,
  );
  expect(css).not.toMatch(/will-change/);
  for (const query of [
    "prefers-reduced-motion: reduce",
    "forced-colors: active",
  ]) {
    const block = css.slice(css.indexOf(`@media (${query})`));
    expect(block.slice(0, block.indexOf("@media", 10))).toMatch(
      /disc::after \{\s*display: none;\s*animation: none;/,
    );
  }
  expect(css).toMatch(/border-color: var\(--status-progress\)/);
  expect(css).toMatch(/border-color: Highlight/);
  const theme = readFileSync(
    new NodeURL("./ui/theme.css", import.meta.url),
    "utf8",
  );
  expect(theme).toMatch(/--ui-run-cycle: 2\.8s;/);
});
