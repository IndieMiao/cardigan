// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { attachment, cardDetail, timelineEntry } from "../testing/fixtures.js";
import { Timeline } from "./Timeline.js";

const css = readFileSync(new NodeURL("../styles.css", import.meta.url), "utf8");
afterEach(cleanup);
function fixture() {
  const detail = cardDetail({
    deliveries: [
      {
        id: "D-8",
        work_item_id: "W-1",
        kind: "code",
        status: "accepted",
        summary: "中文计词交付摘要",
        subject: { kind: "git_head", value: "f".repeat(40) },
      },
    ],
    reviews: [
      {
        id: "V-12",
        delivery_id: "D-8",
        work_item_id: "W-2",
        verdict: "pass",
        blocking: false,
      },
    ],
    decisions: [
      {
        id: "Q-8",
        question: "确认合并？",
        status: "resolved",
        blocking: true,
        decider: "human",
        options: [{ key: "merge", description: "确认合并", impact: "发布" }],
        recommended: "merge",
      },
    ],
    timeline: [
      timelineEntry({
        id: "delivery",
        type: "delivery",
        delivery_id: "D-8",
        author_role: "coder",
      }),
      timelineEntry({
        id: "review",
        type: "review",
        review_id: "V-12",
        author_role: "tester",
      }),
      timelineEntry({
        id: "decision",
        type: "decision_resolved",
        decision_id: "Q-8",
        decision_option: "merge",
        author: "human",
        body: "同意合并",
      }),
      timelineEntry({
        id: "comment",
        type: "comment",
        author_role: "tester",
        body: "### 检查结果\n\n中文English 123正文。\n\n`inline code`\n\n```text\n代码块\n```",
      }),
      timelineEntry({
        id: "instruction",
        type: "instruction",
        body: "请继续验证",
      }),
      timelineEntry({
        id: "system",
        type: "system",
        event_type: "card_merged",
        author: "system",
        body: "card_merged",
      }),
    ],
  });
  return render(
    <Timeline
      projectId="p-1"
      cardId="C-1"
      entries={detail.timeline}
      attachments={[
        attachment({ attach_to: { kind: "timeline_entry", id: "comment" } }),
      ]}
      detail={detail}
    />,
  );
}
function sheet() {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  return style;
}
// jsdom can retain CSS custom-property references; Chromium measures the actual pixels in the audit.
function size(element: Element) {
  return getComputedStyle(element).fontSize.replace(
    /var\((--[\w-]+)\)/g,
    (_, key: string) =>
      getComputedStyle(document.documentElement).getPropertyValue(key).trim(),
  );
}

test("U6c each structural result is in the right header cell, appears once and comments leave that cell empty", () => {
  const style = sheet();
  try {
    fixture();
    for (const [entry, type, id, result] of [
      ["delivery", "交付", "D-8", "已接受"],
      ["review", "审核", "V-12", "已通过"],
      ["decision", "拍板", "Q-8", "已拍板"],
    ]) {
      const row = document.getElementById(`entry-${entry}`) as HTMLElement;
      const heading = within(row).getByRole("heading", {
        name: `${id} ${type} ${result}`,
      });
      expect(heading.parentElement?.classList).toContain("timeline-head");
      expect(getComputedStyle(heading).flexWrap).toBe("wrap");
      expect(
        getComputedStyle(heading.parentElement as Element).alignItems,
      ).toBe("center");
      expect(row.querySelectorAll(".timeline-conclusion")).toHaveLength(1);
      expect(
        row.querySelector(".structured-entry > .timeline-conclusion"),
      ).toBeNull();
      expect(row.textContent?.split(id)).toHaveLength(2);
      const status = heading.querySelector(".status") as Element;
      expect(status.textContent).toBe(result);
      expect(size(status)).toBe("13px");
      // jsdom does not evaluate color-mix; Chromium also verifies the painted background.
      expect(css).toContain(
        "background: color-mix(in srgb, currentColor 12%, var(--timeline-card));",
      );
    }
    for (const id of ["comment", "instruction"])
      expect(
        document
          .getElementById(`entry-${id}`)
          ?.querySelector(".timeline-conclusion"),
      ).toBeNull();
  } finally {
    style.remove();
  }
});

test("U6c timeline prose is 15, speakers and subheadings 14, and secondary information 13", () => {
  const style = sheet();
  try {
    fixture();
    for (const selector of [
      ".entry-summary",
      ".timeline-body",
      ".structured-entry blockquote p",
    ])
      for (const el of document.querySelectorAll(selector))
        expect(size(el), selector).toBe("15px");
    for (const selector of [
      ".timeline-head .employee-identity",
      ".timeline-body h3",
    ])
      for (const el of document.querySelectorAll(selector))
        expect(size(el), selector).toBe("14px");
    for (const selector of [
      ".timeline-when",
      ".timeline-role",
      ".entry-meta",
      ".timeline-day > h3",
      ".system-line",
      ".system-line .employee-identity",
      ".timeline-conclusion",
      ".status",
      ".structured-entry summary",
      ".timeline-entry .id-tag",
      ".attachment",
      ".timeline-entry pre",
    ])
      for (const el of document.querySelectorAll(selector))
        expect(size(el), selector).toBe("13px");
    for (const el of document.querySelectorAll(".timeline-days *")) {
      if (el.closest("svg, code, .employee-avatar, .timeline-version"))
        continue;
      expect(["12px", "16px"]).not.toContain(size(el));
    }
    expect(screen.getByText("中文English 123正文。")).toBeTruthy();
  } finally {
    style.remove();
  }
});

test("U6c site typography uses tokens, bundled fonts with system fallbacks, autospace and scoped tabular figures", () => {
  const style = sheet();
  try {
    const root = getComputedStyle(document.documentElement);
    expect(
      root
        .getPropertyValue("--font")
        .replace(/\s+/g, " ")
        .replace(/,\s*/g, ", ")
        .trim(),
    ).toBe(
      '"Inter Variable", "Noto Sans SC Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
    );
    expect(
      root
        .getPropertyValue("--font-code")
        .replace(/\s+/g, " ")
        .replace(/,\s*/g, ", ")
        .trim(),
    ).toBe(
      '"JetBrains Mono Variable", "Noto Sans SC Variable", ui-monospace, Menlo, Consolas, monospace',
    );
    expect(root.getPropertyValue("--text-code-inline").trim()).toBe("0.92em");
    for (const [, value] of css.matchAll(/font-size:\s*([^;]+);/g))
      expect(value).toMatch(/^(?:var\(--[\w-]+\)|inherit)$/);
    for (const [, value] of css.matchAll(/font-weight:\s*([^;]+);/g))
      expect(["400", "500", "600"]).toContain(value);
    expect(css).toContain("text-autospace: normal;");
    render(
      <>
        <p>English 中文 123</p>
        <table>
          <tbody>
            <tr>
              <td>123</td>
            </tr>
          </tbody>
        </table>
        <time>12:30</time>
        <span className="timeline-count">20 / 61</span>
        <code>inline</code>
        <pre>
          <code>block</code>
        </pre>
      </>,
    );
    expect(getComputedStyle(document.body).fontVariantNumeric).not.toContain(
      "tabular-nums",
    );
    expect(
      getComputedStyle(screen.getByText("English 中文 123")).fontVariantNumeric,
    ).not.toContain("tabular-nums");
    for (const selector of ["table", "time", ".timeline-count"])
      expect(
        getComputedStyle(document.querySelector(selector) as Element)
          .fontVariantNumeric,
      ).toBe("tabular-nums");
    expect(size(document.querySelector("pre") as Element)).toBe("13px");
  } finally {
    style.remove();
  }
});

test("U6c font imports are pinned, Noto keeps Unicode slices, and the distribution includes exact OFL notices", () => {
  const main = readFileSync(
    new NodeURL("../main.tsx", import.meta.url),
    "utf8",
  );
  const pkg = JSON.parse(
    readFileSync(new NodeURL("../../package.json", import.meta.url), "utf8"),
  );
  for (const name of ["inter", "noto-sans-sc", "jetbrains-mono"]) {
    expect(main).toContain(`import "@fontsource-variable/${name}";`);
    expect(pkg.dependencies[`@fontsource-variable/${name}`]).toMatch(
      /^\d+\.\d+\.\d+$/,
    );
    const license = readFileSync(
      new NodeURL(
        `../../node_modules/@fontsource-variable/${name}/LICENSE`,
        import.meta.url,
      ),
      "utf8",
    );
    expect(license).toContain("SIL OPEN FONT LICENSE Version 1.1");
    expect(
      readFileSync(
        new NodeURL(`../../public/licenses/${name}-OFL.txt`, import.meta.url),
        "utf8",
      ),
    ).toBe(license);
  }
  const noto = readFileSync(
    new NodeURL(
      "../../node_modules/@fontsource-variable/noto-sans-sc/index.css",
      import.meta.url,
    ),
    "utf8",
  );
  expect(noto.match(/unicode-range:/g)?.length).toBeGreaterThan(10);
  expect(noto).not.toMatch(/url\(https?:/);
});
