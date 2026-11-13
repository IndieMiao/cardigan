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
import { App } from "../App.js";
import { HelpMarkdown } from "../components/HelpMarkdown.js";
import {
  collectHelpDocuments,
  findHelpDocument,
  helpDocuments,
} from "../help-content.js";
import { ID_TYPES, idBadgeClass } from "../id-types.js";
import { parseRoute, routeHash } from "../route.js";
import { fakeClient, loggedIn } from "../testing/fixtures.js";
import { HelpPage } from "./HelpPage.js";

afterEach(() => {
  cleanup();
  window.location.hash = "";
});

test("new Markdown files join the ordered directory without a code manifest", () => {
  const docs = collectHelpDocuments({
    "./help/03-new.md": "# 新帮助\n\n正文",
    "./help/01-first.md": "# 第一篇",
    "./help/../../private.md": "# Private",
    "./elsewhere/private.md": "# Private",
  });
  expect(docs.map((doc) => [doc.slug, doc.title])).toEqual([
    ["01-first", "第一篇"],
    ["03-new", "新帮助"],
  ]);
  expect(findHelpDocument(docs)?.title).toBe("第一篇");
  expect(findHelpDocument(docs, "03-new")?.source).toContain("正文");
});

test("help opens from the shell, marks the sidebar and restores article navigation", async () => {
  window.location.hash = "#/p/p-1/cards";
  render(<App client={fakeClient({ session: loggedIn })} />);
  fireEvent.click(await screen.findByRole("link", { name: "帮助" }));
  const article = await screen.findByRole("article", { name: "编号和标记" });
  expect(
    within(article).getByRole("heading", { name: "编号和标记" }),
  ).toBeTruthy();
  const sidebar = screen.getByRole("navigation", { name: "工具" });
  expect([...sidebar.children].map((child) => child.textContent)).toEqual([
    "设置",
    "帮助",
    "登出",
  ]);
  expect(
    within(sidebar)
      .getByRole("link", { name: "帮助" })
      .getAttribute("aria-current"),
  ).toBe("page");
  const directory = screen.getByRole("navigation", { name: "帮助目录" });
  fireEvent.click(
    within(directory).getByRole("link", { name: "查找工作和记录" }),
  );
  await screen.findByRole("article", { name: "查找工作和记录" });
  expect(parseRoute(window.location.hash)).toEqual({
    kind: "help",
    projectId: "p-1",
    filters: { doc: "02-navigation" },
  });
  // Browser history uses the same hashchange path as directory clicks.
  window.location.hash = routeHash({
    kind: "help",
    projectId: "p-1",
    filters: { doc: "01-identifiers" },
  });
  await screen.findByRole("article", { name: "编号和标记" });
  expect(
    within(directory)
      .getByRole("link", { name: "编号和标记" })
      .getAttribute("aria-current"),
  ).toBe("page");
});

test("the shipped guide covers every registered prefix using real tags and statuses", () => {
  const { container } = render(<HelpPage projectId="p-1" />);
  for (const type of ID_TYPES) {
    const id = `${type.prefix}-1`;
    const badge = container.querySelector(`.id-type-${type.token}`);
    expect(badge?.textContent).toBe(id);
    expect(badge?.closest(".id-tag")).toBeTruthy();
  }
  expect(screen.getByText("C-1#2").className).toBe(idBadgeClass("C-1#2"));
  for (const status of ["blocked", "snoozed", "running", "passed"]) {
    expect(container.querySelector(`.status-${status} svg`)).toBeTruthy();
  }
  expect(helpDocuments.length).toBeGreaterThanOrEqual(2);
});

test.each([
  "../private",
  "../../development-plan",
  "%2e%2e%2fprivate",
  "/etc/passwd",
  "__proto__",
  "constructor",
  "file:///private",
  "unknown",
])("document lookup rejects %s without fetching", async (doc) => {
  const fetch = vi.spyOn(globalThis, "fetch");
  window.location.hash = routeHash({
    kind: "help",
    projectId: "p-1",
    filters: { doc },
  });
  render(<HelpPage projectId="p-1" />);
  await waitFor(() =>
    expect(screen.getByText("找不到这篇帮助文档，请从目录选择。")).toBeTruthy(),
  );
  expect(findHelpDocument(helpDocuments, doc)).toBeUndefined();
  expect(fetch).not.toHaveBeenCalled();
  fetch.mockRestore();
});

test("Markdown escapes raw HTML and renders common syntax with no injected DOM", () => {
  const { container } = render(
    <HelpMarkdown
      source={
        '# 标题\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n<iframe srcdoc="bad"></iframe>\n\n**强调**和*斜体*\n\n- 列表\n\n> 引用\n\n```html\n<button onclick="bad()">原样</button>\n```\n\n![image](https://example.com/track.png)'
      }
    />,
  );
  expect(
    container.querySelector(
      "script, img, iframe, button, [onclick], [onerror]",
    ),
  ).toBeNull();
  expect(container.textContent).toContain("<script>alert(1)</script>");
  expect(container.querySelector("strong")?.textContent).toBe("强调");
  expect(container.querySelector("em")?.textContent).toBe("斜体");
  expect(container.querySelector("li")?.textContent).toBe("列表");
  expect(container.querySelector("blockquote")?.textContent).toContain("引用");
  expect(container.querySelector("pre code")?.textContent).toContain(
    '<button onclick="bad()">原样</button>',
  );
});

test.each([
  "javascript:alert(1)",
  "JaVaScRiPt:alert(1)",
  "javascript&#58;alert(1)",
  "jav&#x61;script:alert(1)",
  "java&#x09;script:alert(1)",
  "data:text/html,evil",
  "data:image/png;base64,AAAA",
  "vbscript:evil",
  "file:///etc/passwd",
  "//evil.example",
  "/\\evil.example",
  "%6aavascript:evil",
])("Markdown rejects unsafe link %s", (href) => {
  const { container } = render(<HelpMarkdown source={`[click](${href})`} />);
  expect(container.querySelector("a")).toBeNull();
});

test("safe links keep labels, isolate external windows and avoid nested interactive tags", () => {
  const { container } = render(
    <HelpMarkdown
      source={
        "[external](https://example.com) [internal](/help) [`C-1`](#/p/p-1/cards/C-1)"
      }
    />,
  );
  const external = screen.getByRole("link", { name: "external" });
  expect(external.getAttribute("rel")).toBe("noopener noreferrer");
  expect(external.getAttribute("target")).toBe("_blank");
  expect(
    screen.getByRole("link", { name: "internal" }).getAttribute("href"),
  ).toBe("/help");
  expect(container.querySelector("a .id-type-card")?.textContent).toBe("C-1");
  expect(container.querySelector("a a, a [tabindex]")).toBeNull();
});
