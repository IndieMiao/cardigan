import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const css = await readFile(
  new URL("../src/styles.css", import.meta.url),
  "utf8",
);
// C-136 intentionally redesigns the card records tab. Swap that one region of
// the baseline stylesheet for the current one in place (keeping cascade
// order), so every other desktop geometry is still compared unchanged. Once
// the baseline carries the redesign this is a no-op.
function recordsRegion(value) {
  const start = value.search(
    /\/\* C-136: records tab\.|\.card-main \.card-record-list p \{/,
  );
  const end = value.indexOf(".attachment-grid {", start);
  assert(start >= 0 && end > start, "records CSS region not found");
  return [start, end];
}
function withCurrentRecords(value) {
  const [start, end] = recordsRegion(value);
  const [from, to] = recordsRegion(css);
  return `${value.slice(0, start)}${css.slice(from, to)}${value.slice(end)}`;
}
// C-204 intentionally changes number tags and person rows. Compare unrelated
// desktop geometry against the baseline with only these shared rules updated.
function withCurrentIdentity(value) {
  // Keep each theme's unrelated variables from the baseline. Only the ID
  // palette is an intentional colour change in this comparison.
  for (const theme of [
    /^:root \{[^}]*\}/m,
    /@media \(prefers-color-scheme: dark\) \{\s*:root \{[^}]*\}/,
  ]) {
    const variables = /--id-[\w-]+-(?:fg|bg):[^;]+;/g;
    const declarations = css.match(theme)?.[0].match(variables);
    assert(declarations?.length && theme.test(value), "ID theme CSS not found");
    value = value.replace(
      theme,
      (block) =>
        `${block.slice(0, -1).replace(variables, "")}\n${declarations.join("\n")}\n}`,
    );
  }
  for (const [startPattern, end] of [
    [/\.id-tag(?:,| \{)/, ".filter-bar {"],
    [/\.entry-meta \{/, ".timeline-version {"],
  ]) {
    const start = value.search(startPattern),
      from = css.search(startPattern);
    value =
      value.slice(0, start) +
      css.slice(from, css.indexOf(end, from)) +
      value.slice(value.indexOf(end, start));
  }
  for (const selector of [
    ".identity-row > *",
    ".employee-inline .employee-label strong",
    ".needs-delivery-list p",
    ".needs-review-issues",
    ".decision-record-by .employee-identity",
  ]) {
    const start = css.indexOf(`${selector} {`);
    value += `\n${css.slice(start, css.indexOf("}", start) + 1)}`;
  }
  return (
    value + css.slice(css.indexOf("/* C-204: shared person/number/status rows"))
  );
}
// C-210 intentionally widens board lanes and changes card typography. Keep
// baseline comparisons for the rest of the page, replacing only board rules.
function withCurrentBoard(value) {
  for (const [pattern, end] of [
    [/\.board-scroll \{/, ".card-tile {"],
    [
      /\/\* C-(?:31: compact|210: readable) cards/,
      "/* V10b: template management",
    ],
  ]) {
    const start = value.search(pattern),
      from = css.search(pattern);
    assert(start >= 0 && from >= 0, "Board CSS region not found");
    value =
      value.slice(0, start) +
      css.slice(from, css.indexOf(end, from)) +
      value.slice(value.indexOf(end, start));
  }
  const priority = /\.board-card \.priority-badge \{[^}]+\}/;
  const currentPriority = css.match(priority)?.[0];
  assert(currentPriority, "Board priority target rule not found");
  value = priority.test(value)
    ? value.replace(priority, currentPriority)
    : `${value}\n${currentPriority}`;
  return value;
}
// C-242 intentionally drops the page-level max-width caps and lets the card
// detail main column flex beside a fixed sidebar. Apply just those rules to
// the baseline in place; once the baseline carries them this is a no-op.
function withFullWidth(value) {
  for (const [from, to] of [
    ["  width: 100%;\n  max-width: 1664px;\n", "  width: 100%;\n"],
    [".needs-page {\n  max-width: 980px;\n}\n", ""],
    [".execution-page {\n  max-width: 1600px;\n}\n", ""],
    [
      "grid-template-columns: minmax(0, 760px) minmax(280px, 360px);",
      "grid-template-columns: minmax(0, 1fr) 360px;",
    ],
    ["  width: 100%;\n  max-width: 1144px;\n}", "  width: 100%;\n}"],
    [
      "grid-template-columns: 180px minmax(0, 900px);",
      "grid-template-columns: 180px minmax(0, 1fr);",
    ],
    [
      "grid-template-columns: 8rem minmax(0, 40rem);",
      "grid-template-columns: 8rem minmax(0, 1fr);",
    ],
    [
      ".settings-layout form {\n  display: grid;\n  gap: 1rem;\n}\n",
      css.slice(
        css.indexOf(".settings-layout form {"),
        css.indexOf(".settings-layout input[type="),
      ),
    ],
  ])
    value = value.replace(from, to);
  return value;
}
const baseline = withFullWidth(
  withCurrentBoard(
    withCurrentIdentity(
      withCurrentRecords(
        execFileSync(
          "git",
          [
            "show",
            `${process.env.LAYOUT_BASELINE_REF ?? "origin/main"}:apps/web/src/styles.css`,
          ],
          { cwd: root, encoding: "utf8" },
        ),
      ),
    ),
  ),
);
// C-134 replaces the decision history cards with compact records.
const decisionHistoryAllowance = css.slice(
  css.indexOf("/* C-134 decision history: compact records. */"),
  css.indexOf("/* End C-134 decision history. */"),
);
const screenshots = process.env.LAYOUT_SCREENSHOTS;
if (screenshots) await mkdir(screenshots, { recursive: true });
const server = await createServer({
  root,
  server: { host: "localhost", port: 0 },
  plugins: [
    {
      name: "responsive-test-entry",
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (!request.url?.startsWith("/__layout")) return next();
          response.setHeader("Content-Type", "text/html");
          response.end(
            await server.transformIndexHtml(
              "/__layout",
              `<!doctype html>
          <html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
          <body><div id="root"></div><script type="module" src="/test-support/responsive-fixture.tsx"></script></body></html>`,
            ),
          );
        });
      },
    },
  ],
});
const routes = [
  ["card", "cards/C-1", ".timeline-load"],
  ["needs-you", "needs-you", ".needs-item"],
  ["execution", "execution?view=all", ".execution-row, .execution-card"],
  ["decision-history", "decision-history", ".decision-record"],
  ["snapshot", "snapshot", ".card-table"],
  ["settings", "settings", "#preferences form"],
  ["board", "cards?view=board", ".cards-page-board"],
];
let browser;
try {
  await server.listen();
  browser = await chromium();
  const { send, evaluate } = browser;
  const run = (fn, ...args) =>
    evaluate(`(${fn.toString()})(...${JSON.stringify(args)})`);
  async function until(expression) {
    const deadline = Date.now() + 15000;
    while (!(await evaluate(expression))) {
      assert(Date.now() < deadline, `Timed out: ${expression}`);
      await delay(40);
    }
  }
  async function setCss(value) {
    await run((value) => {
      document.querySelector(
        'style[data-vite-dev-id$="/src/styles.css"]',
      ).textContent = value;
      window.scrollTo(0, 0);
    }, value);
  }
  const geometry = () =>
    run(async () => {
      window.scrollTo({ top: 0, left: 0, behavior: "instant" });
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
      // C-209 redesigns the navigation itself, so only the page content is
      // compared, relative to its own box (the narrow top bar replaces the
      // stacked sidebar and shifts the content down).
      // A different page offset shifts sub-pixel snapping; ignore that noise.
      const round = (value) => Math.round(value * 100) / 100;
      const content = document
        .querySelector(".content")
        .getBoundingClientRect();
      return Array.from(
        document.querySelectorAll(".content, .content *"),
        (el) => {
          const rect = el.getBoundingClientRect(),
            style = getComputedStyle(el);
          return [
            el.tagName,
            el.className,
            // Hidden boxes report 0,0 regardless of the content offset.
            style.display === "none" ? 0 : round(rect.x - content.x),
            style.display === "none" ? 0 : round(rect.y - content.y),
            round(rect.width),
            round(rect.height),
            style.display,
            style.position,
            style.gridTemplateColumns,
            style.fontSize,
            style.lineHeight,
            style.padding,
            style.margin,
            style.color,
            style.backgroundColor,
          ];
        },
      );
    });
  async function capture(name, width, theme) {
    if (
      !screenshots ||
      (width !== 390 &&
        !(
          (name === "execution" || name === "decision-history") &&
          width === 1440
        ))
    )
      return;
    const { cssContentSize } = await send("Page.getLayoutMetrics");
    const { data } = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: {
        x: 0,
        y: 0,
        width,
        height: Math.ceil(cssContentSize.height),
        scale: 1,
      },
    });
    await writeFile(
      resolve(screenshots, `${name}-${width}-${theme}.png`),
      Buffer.from(data, "base64"),
    );
    if (name === "card") {
      await run(async () => {
        const controls = document.querySelector(".timeline-controls");
        const nav = document.querySelector(".card-section-nav");
        window.scrollTo({
          top:
            controls.getBoundingClientRect().y +
            window.scrollY -
            nav.clientHeight -
            80,
          behavior: "instant",
        });
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
      });
      const { data } = await send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
      });
      await writeFile(
        resolve(screenshots, `card-pagination-${width}-${theme}.png`),
        Buffer.from(data, "base64"),
      );
      await run(() =>
        window.scrollTo({ top: 0, left: 0, behavior: "instant" }),
      );
    }
  }
  for (const width of [390, 760, 768, 1280, 1440]) {
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height: 844,
      deviceScaleFactor: 1,
      mobile: false,
    });
    for (const theme of ["light", "dark"]) {
      await send("Emulation.setEmulatedMedia", {
        features: [
          { name: "prefers-color-scheme", value: theme },
          { name: "prefers-reduced-motion", value: "reduce" },
        ],
      });
      for (const [name, route, ready] of routes.filter(
        ([name]) =>
          !process.env.LAYOUT_CASES ||
          process.env.LAYOUT_CASES.split(",").includes(name),
      )) {
        const label = `${name} ${width}px ${theme}`;
        await send("Page.navigate", {
          url: `${server.resolvedUrls.local[0]}__layout?case=${name}#/p/p-1/${route}`,
        });
        await until(
          `Boolean(document.querySelector(${JSON.stringify(ready)}))`,
        );
        await evaluate("document.fonts.ready.then(() => true)");
        await run(() =>
          window.scrollTo({ top: 0, left: 0, behavior: "instant" }),
        );
        const layout = await run(() => {
          const rect = (selector) => {
            const r = document.querySelector(selector).getBoundingClientRect();
            return {
              x: r.x,
              y: r.y,
              width: r.width,
              height: r.height,
              bottom: r.bottom,
            };
          };
          return {
            width: innerWidth,
            scrollWidth: document.documentElement.scrollWidth,
            main: rect(".content"),
            sidebar: rect(".sidebar"),
            sidebarShown:
              getComputedStyle(document.querySelector(".sidebar")).display !==
              "none",
            header: document.querySelector(".mobile-header")
              ? rect(".mobile-header")
              : null,
            fixed:
              getComputedStyle(document.querySelector(".sidebar")).position ===
              "fixed",
          };
        });
        // C-207: below 760px the execution view renders cards, not a table.
        if (name === "execution" && width > 760) {
          const headers = await run(() =>
            Array.from(
              document.querySelectorAll(".execution-table th"),
              (th) => {
                const walker = document.createTreeWalker(
                  th,
                  NodeFilter.SHOW_TEXT,
                );
                const rects = [];
                while (walker.nextNode()) {
                  if (!walker.currentNode.textContent.trim()) continue;
                  const range = document.createRange();
                  range.selectNodeContents(walker.currentNode);
                  rects.push(...range.getClientRects());
                }
                const box = th.getBoundingClientRect();
                return {
                  text: th.textContent,
                  tops: rects.map((rect) => rect.top),
                  fits: rects.every(
                    (rect) => rect.left >= box.left && rect.right <= box.right,
                  ),
                };
              },
            ),
          );
          assert.equal(headers.length, 6, `${label}: missing column headers`);
          for (const header of headers) {
            assert(
              header.tops.length > 0,
              `${label}: empty header ${header.text}`,
            );
            assert(
              Math.max(...header.tops) - Math.min(...header.tops) <= 1,
              `${label}: wrapped header ${header.text}`,
            );
            assert(header.fits, `${label}: overflowing header ${header.text}`);
          }
          // C-159: status labels in the run status column stay on one line.
          const statuses = await run(() =>
            Array.from(
              document.querySelectorAll(".execution-state .status"),
              (el) => {
                const range = document.createRange();
                range.selectNodeContents(el);
                const rects = Array.from(range.getClientRects()).filter(
                  (r) => r.width,
                );
                const tops = rects.map((r) => r.top);
                // The text must stay inside its own cell's content box, not
                // spill into the neighbouring column.
                const cell = el.closest("td");
                const box = cell.getBoundingClientRect();
                const style = getComputedStyle(cell);
                const left = box.left + Number.parseFloat(style.paddingLeft);
                const right = box.right - Number.parseFloat(style.paddingRight);
                return {
                  text: el.textContent,
                  lines: Math.max(...tops) - Math.min(...tops),
                  fits: rects.every(
                    (r) => r.left >= left - 0.5 && r.right <= right + 0.5,
                  ),
                };
              },
            ),
          );
          assert.equal(statuses.length, 8, `${label}: missing status labels`);
          for (const status of statuses)
            assert(
              status.lines <= 1,
              `${label}: wrapped status ${status.text}`,
            );
          for (const status of statuses)
            assert(
              status.fits,
              `${label}: status ${status.text} overflows its cell`,
            );
        }
        if (name === "decision-history") {
          // C-134: compact records; a 1080px-high desktop screen shows at
          // least six from the top of the page, each in at most three lines.
          const records = await run(() =>
            Array.from(document.querySelectorAll(".decision-record"), (el) => {
              const r = el.getBoundingClientRect();
              const lines = Array.from(
                el.querySelectorAll(
                  ".decision-record-head, .decision-record-choice, .decision-record-summary",
                ),
                (line) => line.getBoundingClientRect().height,
              );
              return { bottom: r.bottom, lines };
            }),
          );
          assert.equal(records.length, 10, `${label}: first page is not 10`);
          if (width >= 1280) {
            assert(
              records.filter((r) => r.bottom <= 1080).length >= 6,
              `${label}: fewer than 6 records fit in 1080px`,
            );
            for (const record of records)
              assert(
                record.lines.length === 3 && record.lines.every((h) => h <= 32),
                `${label}: record wraps beyond three lines`,
              );
          }
          await until(
            "Array.from(document.querySelectorAll('button')).some((b) => b.textContent === '加载更多')",
          );
        }
        // C-159: nav counts keep a gap from their label at every width; on
        // narrow screens the count sits in the top bar shortcut (C-209).
        const counts = await run(() =>
          Array.from(document.querySelectorAll(".nav a"), (link) => {
            const count = link.querySelector(".nav-count");
            const label = link.querySelector(".nav-icon + span");
            if (!count || !label || !link.getClientRects().length) return null;
            const range = document.createRange();
            range.selectNodeContents(label);
            const text = Array.from(range.getClientRects()).filter(
              (r) => r.width,
            );
            const box = count.getBoundingClientRect();
            return {
              text: link.textContent,
              gap: box.left - Math.max(...text.map((r) => r.right)),
            };
          }).filter(Boolean),
        );
        if (width > 760)
          assert(counts.length > 0, `${label}: missing nav count`);
        else
          assert(
            await run(
              () =>
                document.querySelector(".mobile-needs .nav-count")?.textContent,
            ),
            `${label}: missing top bar count`,
          );
        for (const count of counts)
          assert(count.gap >= 8, `${label}: nav count too close ${count.text}`);
        await capture(name, width, theme);
        if (width <= 760) {
          assert.equal(
            layout.scrollWidth,
            width,
            `${label}: horizontal page overflow`,
          );
          assert.equal(layout.main.x, 0, label);
          assert.equal(layout.main.width, width, label);
          // C-209: the sidebar leaves the flow for a 56px top bar.
          assert.equal(layout.sidebarShown, false, label);
          assert.equal(layout.header?.height, 56, label);
          assert(layout.main.y >= layout.header.bottom, label);
          if (name === "needs-you") {
            await run(() =>
              document.querySelector('[aria-label="打开导航"]').click(),
            );
            await until("Boolean(document.querySelector('.nav-drawer'))");
            const drawer = await run(() => {
              const r = document
                .querySelector(".nav-drawer")
                .getBoundingClientRect();
              return {
                x: r.x,
                width: r.width,
                height: r.height,
                focused: document.activeElement?.getAttribute("aria-label"),
                links: document.querySelectorAll(".nav-drawer .nav-item")
                  .length,
                main: document.querySelector(".content").getBoundingClientRect()
                  .x,
              };
            });
            assert.equal(drawer.x, 0, `${label}: drawer`);
            assert.equal(drawer.width, Math.min(280, width - 56), label);
            assert.equal(drawer.height, 844, label);
            assert.equal(drawer.focused, "关闭导航", label);
            // C-206 added 帮助 to the drawer.
            assert.equal(drawer.links, 9, `${label}: drawer entries`);
            assert.equal(drawer.main, 0, `${label}: drawer pushes content`);
            await capture("nav-drawer", width, theme);
            await send("Input.dispatchKeyEvent", {
              type: "keyDown",
              key: "Escape",
              code: "Escape",
              windowsVirtualKeyCode: 27,
            });
            await send("Input.dispatchKeyEvent", {
              type: "keyUp",
              key: "Escape",
              code: "Escape",
              windowsVirtualKeyCode: 27,
            });
            await until("!document.querySelector('.nav-drawer')");
            assert.equal(
              await run(() =>
                document.activeElement?.getAttribute("aria-label"),
              ),
              "打开导航",
              `${label}: focus returns to the menu button`,
            );
          }
          if (name === "card") {
            const controls = await run(() => {
              const main = document
                .querySelector(".card-main")
                .getBoundingClientRect();
              const side = document
                .querySelector(".card-sidebar")
                .getBoundingClientRect();
              const controls = document.querySelector(".timeline-controls");
              return {
                stacked: side.y >= main.bottom,
                text: controls.textContent,
                boxes: Array.from(controls.children, (el) => {
                  const r = el.getBoundingClientRect();
                  return {
                    x: r.x,
                    y: r.y,
                    right: r.right,
                    bottom: r.bottom,
                    width: r.width,
                    height: r.height,
                  };
                }).filter((r) => r.width && r.height),
              };
            });
            assert(controls.stacked, label);
            assert.match(controls.text, /已加载 20 \/ 25 条/, label);
            for (const box of controls.boxes)
              assert(
                box.x >= 0 && box.right <= width,
                `${label}: clipped control`,
              );
            for (let i = 0; i < controls.boxes.length; i++)
              for (const other of controls.boxes.slice(i + 1)) {
                const a = controls.boxes[i];
                assert(
                  a.right <= other.x ||
                    other.right <= a.x ||
                    a.bottom <= other.y ||
                    other.bottom <= a.y,
                  `${label}: overlapping controls`,
                );
              }
            const point = await run(() => {
              const button = document.querySelector(".timeline-load");
              button.scrollIntoView({ block: "center", behavior: "instant" });
              const r = button.getBoundingClientRect();
              return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
            });
            await send("Input.dispatchMouseEvent", {
              type: "mousePressed",
              button: "left",
              clickCount: 1,
              ...point,
            });
            await send("Input.dispatchMouseEvent", {
              type: "mouseReleased",
              button: "left",
              clickCount: 1,
              ...point,
            });
            await until(
              "document.querySelector('.timeline-controls').textContent.includes('已加载 25 / 25 条')",
            );
            assert.equal(
              await evaluate("document.documentElement.scrollWidth"),
              width,
              label,
            );
          }
          // C-458: snapshot tables stack as records on narrow screens.
          if (name === "execution" && width > 760) {
            const scroll = await run((selector) => {
              const el = document.querySelector(selector);
              el.scrollLeft = el.scrollWidth;
              return {
                left: el.scrollLeft,
                max: el.scrollWidth - el.clientWidth,
                page: document.documentElement.scrollWidth,
              };
            }, ".execution-table-scroll");
            assert(
              (width !== 390 || scroll.left > 0) &&
                Math.abs(scroll.left - scroll.max) <= 1,
              `${label}: table cannot scroll to the end`,
            );
            assert.equal(scroll.page, width, label);
          }
          if (name === "board") {
            const current = await geometry();
            // Compare page content against the baseline stylesheet.
            await setCss(baseline);
            assert.deepEqual(
              await geometry(),
              current,
              `${label}: existing board layout changed`,
            );
          }
        } else {
          assert(layout.fixed, label);
          assert.equal(layout.main.x, 220, label);
          const current = await geometry();
          // C-207 redesigns the execution view (new DOM and stylesheet), so
          // it is not compared with the baseline; execution-layout-screenshots
          // checks its row heights and first screen instead. C-134 changes
          // the decision history records with its own allowance.
          if (name !== "execution") {
            await setCss(
              name === "decision-history"
                ? `${baseline}\n${decisionHistoryAllowance}`
                : baseline,
            );
            assert.deepEqual(
              await geometry(),
              current,
              `${label}: desktop layout changed`,
            );
            await setCss(css);
          }
        }
        console.log(`PASS ${label}`);
      }
    }
  }
  assert.deepEqual(browser.errors, [], "Browser runtime errors");
  console.log(
    process.env.LAYOUT_CASES
      ? `PASS selected layout cases: ${process.env.LAYOUT_CASES} (5 widths, 2 themes)`
      : "PASS 70 layout cases, including single-line execution headers, timeline pagination and internal table scrolling",
  );
} finally {
  await browser?.close();
  await server.close();
}
