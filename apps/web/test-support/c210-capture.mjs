import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "vite";

// Uses a separately installed Playwright; adds no product dependency.
const { chromium, firefox } = await import(
  pathToFileURL(process.env.C210_PLAYWRIGHT_MODULE)
);
const output = process.env.C210_SCREENSHOTS;
assert(output, "Set C210_SCREENSHOTS to an evidence directory");
await mkdir(output, { recursive: true });
const config = await mkdtemp(join(tmpdir(), "c210-browser-"));
// Product mode compares actual baseline/current components with identical local
// fixtures. Design mode continues to use the independently served prototype.
const product = process.env.C210_PRODUCT === "1";
const servers = {};
if (product) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  for (const version of ["before", "after"]) {
    const server = await createServer({
      root,
      server: { host: "127.0.0.1", port: 0 },
      plugins:
        version === "before"
          ? [
              {
                name: "c210-baseline",
                enforce: "pre",
                load(id) {
                  for (const file of [
                    "src/styles.css",
                    "src/components/BoardCard.tsx",
                  ])
                    if (id === join(root, file))
                      return execFileSync(
                        "git",
                        [
                          "show",
                          `${process.env.C210_BASELINE_REF ?? "c23948661633b04962c9e2aeede735d068fb58bd"}:apps/web/${file}`,
                        ],
                        { cwd: root, encoding: "utf8" },
                      );
                },
              },
            ]
          : [],
    });
    await server.listen();
    servers[version] = server;
  }
}
const records = [];
try {
  for (const engine of (process.env.C210_ENGINES ?? "chromium,firefox").split(
    ",",
  )) {
    const browser = await { chromium, firefox }[engine].launch({
      headless: process.env.C210_HEADED !== "1",
      ...(engine === "firefox"
        ? {
            firefoxUserPrefs: {
              "widget.gtk.overlay-scrollbars.enabled": false,
            },
          }
        : {}),
      ...(engine === "chromium"
        ? {
            executablePath: process.env.CHROMIUM_PATH,
            ignoreDefaultArgs: ["--hide-scrollbars"],
          }
        : {}),
      env: { ...process.env, XDG_CONFIG_HOME: config },
    });
    try {
      for (const width of [1440, 390])
        for (const colorScheme of ["light", "dark"])
          for (const version of ["before", "after"]) {
            const page = await browser.newPage({
              viewport: { width, height: 1000 },
              colorScheme,
            });
            const errors = [];
            page.on("pageerror", (error) => errors.push(error.message));
            await page.goto(
              `${product ? servers[version].resolvedUrls.local[0] : "http://127.0.0.1:4210/"}test-support/c210-board.html?version=${version}${product ? "&product=1" : ""}`,
            );
            await page.locator(".board-card").first().waitFor();
            await page.evaluate(() => document.fonts.ready);
            await page.mouse.move(0, 0);
            if (width === 390)
              await page.locator(".board").evaluate((el) => {
                const lane = el.querySelector(
                  ".board-column:not(.board-column-collapsed)",
                );
                el.scrollLeft =
                  lane.getBoundingClientRect().left -
                  el.getBoundingClientRect().left;
                window.scrollTo(0, document.documentElement.scrollHeight);
              });
            const measures = await page.evaluate(() => {
              const title = document.querySelector(".card-title"),
                card = document.querySelector(".board-card");
              const lane = document.querySelector(
                ".board-column:not(.board-column-collapsed)",
              );
              const scroll = lane.querySelector(".board-lane-cards");
              const style = getComputedStyle(title);
              const board = document
                .querySelector(".board")
                .getBoundingClientRect();
              const nextLane = lane.nextElementSibling;
              const nextHeading = nextLane
                .querySelector(".board-column-heading")
                .getBoundingClientRect();
              const nextCard = nextLane
                .querySelector(".board-card")
                .getBoundingClientRect();
              const visible = (rect) =>
                Math.max(
                  0,
                  Math.min(rect.right, board.right) -
                    Math.max(rect.left, board.left),
                );
              const pairRows = [
                ...document.querySelectorAll(".board-card-meta"),
              ].flatMap((meta) => {
                const time = meta.querySelector('a[aria-label^="更新时间："]');
                const attachment = meta.querySelector(
                  'a[aria-label^="附件："]',
                );
                return time && attachment
                  ? [
                      Math.abs(
                        time.getBoundingClientRect().top -
                          attachment.getBoundingClientRect().top,
                      ),
                    ]
                  : [];
              });
              return {
                nextColumnVisible: visible(nextLane.getBoundingClientRect()),
                nextHeadingVisible: visible(nextHeading),
                nextCardVisible: visible(nextCard),
                fadeHidden:
                  !document.querySelector(".board-fade") ||
                  getComputedStyle(document.querySelector(".board-fade"))
                    .display === "none",
                timeAttachmentRowOffsets: pairRows,
                pageWidth: document.documentElement.clientWidth,
                boardWidth: document.querySelector(".board").clientWidth,
                scrollWidth: document.documentElement.scrollWidth,
                columnWidth: lane.getBoundingClientRect().width,
                cardWidth: card.getBoundingClientRect().width,
                titleWeight: style.fontWeight,
                titleHeight: title.getBoundingClientRect().height,
                titleColor: style.color,
                // Canvas resolves color-mix() to sRGB for WCAG contrast checks.
                contrast: (() => {
                  const ctx = document.createElement("canvas").getContext("2d");
                  const luminance = (color) => {
                    ctx.fillStyle = color;
                    ctx.fillRect(0, 0, 1, 1);
                    const rgb = [...ctx.getImageData(0, 0, 1, 1).data]
                      .slice(0, 3)
                      .map((v) => v / 255)
                      .map((v) =>
                        v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4,
                      );
                    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
                  };
                  const bg = luminance(getComputedStyle(card).backgroundColor);
                  return [title, card.querySelector(".board-card-badge")].map(
                    (el) => {
                      const fg = luminance(getComputedStyle(el).color);
                      return (
                        (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05)
                      );
                    },
                  );
                })(),
                cardBackground: getComputedStyle(card).backgroundColor,
                metaColor: getComputedStyle(
                  card.querySelector(".board-card-badge"),
                ).color,
                scrollStyle: getComputedStyle(scroll).scrollbarColor,
                arrow: getComputedStyle(scroll, "::-webkit-scrollbar-button")
                  .display,
              };
            });
            assert.equal(
              measures.scrollWidth,
              measures.pageWidth,
              "Page must not overflow horizontally",
            );
            if (version === "after") {
              if (width === 390) {
                assert(
                  measures.nextColumnVisible >= 48,
                  "Next lane must remain visibly discoverable",
                );
                assert(
                  measures.nextHeadingVisible >= 36,
                  "Next heading must peek into the viewport",
                );
                assert(
                  measures.nextCardVisible >= 44,
                  "Next card edge must peek into the viewport",
                );
                assert(
                  measures.fadeHidden,
                  "The next lane must not be obscured by the edge fade",
                );
                assert(
                  measures.timeAttachmentRowOffsets.every((delta) => delta < 1),
                  "Fixture time and attachment should share a row",
                );
              }
              assert(
                measures.contrast.every((ratio) => ratio >= 4.5),
                "Title and metadata must meet AA",
              );
              assert.equal(measures.titleWeight, "400");
              // C-256: titles wrap in 22px lines; wide lanes hold a 326px card.
              assert.equal(measures.titleHeight % 22, 0);
              if (width === 1440) assert.equal(measures.cardWidth, 326);
              else assert.equal(measures.columnWidth, measures.boardWidth - 64);
            }
            const stem = `${engine}-${width}-${colorScheme}-${version}`;
            await page.screenshot({
              path: join(output, `${stem}.png`),
              // Full-page capture can remove the document scrollbar and reflow
              // Chromium's narrow layout; capture the measured viewport instead.
              fullPage: width !== 390,
            });
            if (version === "after") {
              const link = page.locator(".card-tile-link").first();
              await link.scrollIntoViewIfNeeded();
              await page.waitForTimeout(250);
              await link.focus();
              await page.getByRole("tooltip").waitFor({ timeout: 3000 });
              assert(
                (await page.getByRole("tooltip").textContent())?.includes(
                  "标题不加粗",
                ),
              );
              await page.keyboard.press("Escape");
              await page.getByRole("tooltip").waitFor({ state: "hidden" });
              if (width === 1440) {
                await page.locator(".board-lane-cards:visible").first().hover();
                await page.screenshot({
                  path: join(output, `${stem}-hover.png`),
                });
              }
              const lane = page.locator(".board-lane-cards:visible").first();
              await lane.focus();
              await page.keyboard.press("PageDown");
              await page.waitForFunction(
                () =>
                  document.querySelector(".board-lane-cards:not([hidden])")
                    .scrollTop > 0,
                null,
                { timeout: 3000 },
              );
              await page.locator(".board").evaluate((el) => {
                el.scrollLeft = el.scrollWidth;
              });
              assert(
                await page
                  .locator(".board")
                  .evaluate((el) => el.scrollLeft > 0),
              );
            }
            assert.deepEqual(errors, []);
            records.push({
              engine,
              browser: browser.version(),
              width,
              colorScheme,
              version,
              ...measures,
            });
            await page.close();
          }
    } finally {
      await browser.close();
    }
  }
} finally {
  for (const server of Object.values(servers)) await server.close();
}
await writeFile(
  join(output, "measurements.json"),
  `${JSON.stringify(records, null, 2)}\n`,
);
console.log(JSON.stringify({ scenarios: records.length, records }, null, 2));
