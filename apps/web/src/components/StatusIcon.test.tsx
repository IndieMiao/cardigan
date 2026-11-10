// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { STATUS_LABELS } from "../status.js";
import { StatusTag } from "./Foundation.js";
import { StatusIcon } from "./StatusIcon.js";

afterEach(cleanup);

// Expected semantic groups include all existing vocabulary and merge checks.
const groups = {
  backlog: ["backlog"],
  pending: ["todo", "ready", "queued", "pending", "not_provisioned"],
  dispatched: ["dispatched", "acked", "belled"],
  progress: ["in_progress", "running", "provisioning"],
  review: [
    "review",
    "submitted",
    "delivered",
    "conditional",
    "waiting_decision",
    "open",
    "provisional",
  ],
  merge: ["awaiting_merge"],
  success: [
    "done",
    "completed",
    "accepted",
    "passed",
    "pass",
    "approve",
    "resolved",
    "active",
    "online",
  ],
  error: [
    "blocked",
    "failed",
    "timed_out",
    "changes_requested",
    "rejected",
    "reject",
    "lost",
    "offline",
    "degraded",
    "delivery_failed",
  ],
  cancelled: [
    "cancelled",
    "superseded",
    "withdrawn",
    "revoked",
    "released",
    "not_run",
  ],
  idle: ["idle"],
  paused: ["suspended", "draining", "interrupted"],
  unknown: ["unknown", "needs_attention"],
};
const states = Object.entries(groups).flatMap(([shape, statuses]) =>
  statuses.map((status) => [status, shape] as const),
);

test.each(states)(
  "%s has the expected shape, visible Chinese label and accessible icon name",
  (status, shape) => {
    const label = STATUS_LABELS[status as keyof typeof STATUS_LABELS];
    const { container } = render(
      <>
        <StatusIcon status={status} />
        <StatusTag status={status} />
      </>,
    );
    const icon = screen.getByRole("img", { name: label });
    expect(icon.classList.contains(`status-shape-${shape}`)).toBe(true);
    expect(icon.querySelector("circle, path")).not.toBeNull();
    expect(screen.getByText(label).classList.contains("status")).toBe(true);
    const decorative = container.querySelector(".status svg");
    expect(decorative?.getAttribute("aria-hidden")).toBe("true");
    expect(decorative?.getAttribute("aria-label")).toBeNull();
    expect(decorative?.innerHTML).toBe(icon.innerHTML);
  },
);

test("every known status is covered and semantic categories differ without colour", () => {
  expect(states.map(([status]) => status).sort()).toEqual(
    Object.keys(STATUS_LABELS).sort(),
  );
  const geometry = Object.values(groups).map(([status]) => {
    const { container, unmount } = render(<StatusIcon status={status ?? ""} />);
    const markup = container.querySelector("svg")?.innerHTML;
    unmount();
    return markup;
  });
  expect(new Set(geometry).size).toBe(Object.keys(groups).length);
});

test.each(["future_status", "__proto__", "constructor"])(
  "unknown value %s has a named, visible fallback",
  (status) => {
    render(
      <>
        <StatusIcon status={status} />
        <StatusTag status={status} />
      </>,
    );
    expect(
      screen
        .getByRole("img", { name: "状态未知" })
        .classList.contains("status-shape-unknown"),
    ).toBe(true);
    expect(screen.getByText("状态未知")).toBeTruthy();
  },
);

test("custom labels stay visible and normal Assignment status can be subdued", () => {
  const { container } = render(
    <>
      <StatusTag status="resolved" label="自动合并（代批）" />
      <StatusTag status="active" subdued />
    </>,
  );
  expect(
    screen.getByText("自动合并（代批）").querySelector("svg"),
  ).not.toBeNull();
  expect(screen.getByText("有效").classList.contains("status-subdued")).toBe(
    true,
  );
  expect(container.querySelector(".status-subdued svg")).toBeNull();
});

const css = readFileSync(new NodeURL("../styles.css", import.meta.url), "utf8");
function declarations(block: string): Record<string, string> {
  return Object.fromEntries(
    [...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((match) => [
      match[1],
      match[2],
    ]),
  );
}
const roots = [...css.matchAll(/:root\s*\{([^}]+)\}/g)];
type RGB = readonly number[];
function rgb(hex: string): RGB {
  expect(hex).toMatch(/^#[0-9a-f]{6}$/i);
  return [1, 3, 5].map(
    (start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255,
  );
}
function luminance(color: RGB): number {
  return color.reduce(
    (sum, value, index) =>
      sum +
      (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4) *
        ([0.2126, 0.7152, 0.0722][index] ?? 0),
    0,
  );
}
function contrast(a: RGB, b: RGB): number {
  const values = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return ((values[1] ?? 0) + 0.05) / ((values[0] ?? 0) + 0.05);
}

test.each([0, 1])(
  "theme %i gives every status at least 3:1 contrast on all status surfaces",
  (theme) => {
    expect(roots).toHaveLength(2);
    const light = declarations(roots[0]?.[1] ?? "");
    const palette = { ...light, ...declarations(roots[theme]?.[1] ?? "") };
    const themeValues = declarations(roots[theme]?.[1] ?? "");
    for (const shape of Object.keys(groups)) {
      const rule = new RegExp(
        `\\.status-shape-${shape}\\s*\\{[^}]*--status-color: var\\((--[\\w-]+)\\)`,
      ).exec(css);
      expect(rule, shape).not.toBeNull();
      const variable = rule?.[1] ?? "";
      expect(
        themeValues[variable],
        `${shape} has an explicit theme colour`,
      ).toBeDefined();
      const foreground = rgb(palette[variable] ?? "");
      const surfaces = [
        "--bg",
        "--surface",
        "--surface-muted",
        "--timeline-card",
      ];
      for (const surface of surfaces) {
        expect(
          contrast(foreground, rgb(palette[surface] ?? "")),
          `${shape} on ${surface}`,
        ).toBeGreaterThanOrEqual(3);
      }
      // Timeline chips mix 12% of the status foreground into their background.
      const tinted = rgb(palette["--timeline-card"] ?? "").map(
        (channel, i) => channel * 0.88 + (foreground[i] ?? 0) * 0.12,
      );
      expect(
        contrast(foreground, tinted),
        `${shape} on tinted timeline chip`,
      ).toBeGreaterThanOrEqual(3);
      if (shape === "success" || shape === "error") {
        expect(
          contrast(foreground, rgb(palette["--status-cutout"] ?? "")),
          `${shape} cutout`,
        ).toBeGreaterThanOrEqual(3);
      }
    }
    expect(css).not.toMatch(/\.status[^{}]*::before/);
    expect(css.match(/\.timeline-retracted\s*\{([^}]+)\}/)?.[1]).not.toContain(
      "opacity",
    );
  },
);
