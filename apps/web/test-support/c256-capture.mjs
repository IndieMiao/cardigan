import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "vite";

// C-256: Plane-sized board cards. Local fixture only (the C-210 board data,
// product stylesheet); no business server or real data. "before" swaps the
// baseline stylesheet into the same DOM. Uses a separately installed
// Playwright; adds no product dependency.
const { chromium, firefox } = await import(
  pathToFileURL(process.env.C256_PLAYWRIGHT_MODULE)
);
const output = process.env.C256_SCREENSHOTS;
assert(output, "Set C256_SCREENSHOTS to an evidence directory");
await mkdir(output, { recursive: true });
const config = await mkdtemp(join(tmpdir(), "c256-browser-"));
const root = fileURLToPath(new URL("../", import.meta.url));
const css = await readFile(join(root, "src/styles.css"), "utf8");
const baseline = execFileSync(
  "git",
  [
    "show",
    `${process.env.C256_BASELINE_REF ?? "origin/main"}:apps/web/src/styles.css`,
  ],
  { cwd: root, encoding: "utf8" },
);
const server = await createServer({
  root,
  server: { host: "127.0.0.1", port: 0 },
});
await server.listen();
const records = [];
try {
  for (const engine of (process.env.C256_ENGINES ?? "chromium,firefox").split(
    ",",
  )) {
    const browser = await { chromium, firefox }[engine].launch({
      ...(engine === "chromium"
        ? {
            executablePath: process.env.CHROMIUM_PATH,
            ignoreDefaultArgs: ["--hide-scrollbars"],
          }
        : {
            firefoxUserPrefs: {
              "widget.gtk.overlay-scrollbars.enabled": false,
            },
          }),
      env: { ...process.env, XDG_CONFIG_HOME: config },
    });
    try {
      for (const width of [1440, 1920, 2560, 390])
        for (const colorScheme of ["light", "dark"]) {
          const page = await browser.newPage({
            viewport: { width, height: width === 390 ? 844 : 1000 },
            colorScheme,
          });
          const errors = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(
            `${server.resolvedUrls.local[0]}test-support/c210-board.html?product=1`,
          );
          await page.locator(".board-card").first().waitFor();
          await page.evaluate(() => document.fonts.ready);
          await page.mouse.move(0, 0);
          for (const [version, sheet] of [
            ["before", baseline],
            ["after", css],
          ]) {
            const measures = await page.evaluate(async (sheet) => {
              document.querySelector(
                'style[data-vite-dev-id$="/src/styles.css"]',
              ).textContent = sheet;
              await new Promise((done) =>
                requestAnimationFrame(() => requestAnimationFrame(done)),
              );
              const lanes = [
                ...document.querySelectorAll(
                  ".board-column:not(.board-column-collapsed)",
                ),
              ];
              const lane = lanes[0];
              const scroll = lane.querySelector(".board-lane-cards");
              const card = lane.querySelector(".board-card");
              const cs = getComputedStyle(card);
              const px = (v) => Number.parseFloat(v);
              const rect = card.getBoundingClientRect();
              const cards = [...document.querySelectorAll(".board-card")];
              return {
                pageWidth: document.documentElement.clientWidth,
                boardWidth: document.querySelector(".board").clientWidth,
                scrollWidth: document.documentElement.scrollWidth,
                columnWidth: lane.getBoundingClientRect().width,
                laneGap:
                  lanes[1].getBoundingClientRect().left -
                  lane.getBoundingClientRect().right,
                gutter: scroll.offsetWidth - scroll.clientWidth,
                card: {
                  borderBox: [rect.width, rect.height],
                  content: [
                    rect.width -
                      px(cs.paddingLeft) -
                      px(cs.paddingRight) -
                      px(cs.borderLeftWidth) -
                      px(cs.borderRightWidth),
                    rect.height -
                      px(cs.paddingTop) -
                      px(cs.paddingBottom) -
                      px(cs.borderTopWidth) -
                      px(cs.borderBottomWidth),
                  ],
                  padding: cs.padding,
                  border: cs.borderLeftWidth,
                  height: cs.height,
                  minHeight: cs.minHeight,
                },
                cardHeights: [
                  ...new Set(
                    cards.map((el) =>
                      Math.round(el.getBoundingClientRect().height),
                    ),
                  ),
                ].sort((a, b) => a - b),
                // Any card whose content is wider or taller than its box.
                overflowing: cards.filter(
                  (el) =>
                    el.scrollWidth > el.clientWidth + 1 ||
                    el.scrollHeight > el.clientHeight + 1,
                ).length,
                clippedTitles: [
                  ...document.querySelectorAll(".card-title"),
                ].filter((el) => el.scrollWidth > el.clientWidth + 1).length,
                firstPage: lane.querySelectorAll(".board-card").length,
                counts: lanes.map(
                  (el) => el.querySelector(".board-column-count")?.textContent,
                ),
              };
            }, sheet);
            if (version === "after") {
              assert.equal(measures.scrollWidth, measures.pageWidth);
              assert.equal(measures.overflowing, 0, "card content overflows");
              assert.equal(measures.clippedTitles, 0, "card title clipped");
              assert(["auto", "0px"].includes(measures.card.minHeight));
              assert.equal(measures.firstPage, 10, "first page is 10 cards");
              assert.equal(measures.laneGap, 16);
              if (width === 390) {
                // Unchanged narrow layout: one lane, 48px of the next visible.
                assert.equal(measures.columnWidth, measures.boardWidth - 64);
                assert.equal(
                  measures.card.borderBox[0],
                  measures.columnWidth - measures.gutter - 8,
                );
              } else {
                assert.equal(measures.card.borderBox[0], 326);
                assert.equal(measures.card.content[0], 300);
                assert.equal(measures.columnWidth, 326 + measures.gutter + 8);
              }
            }
            const stem = `${engine}-${width}-${colorScheme}-${version}`;
            await page.screenshot({ path: join(output, `${stem}.png`) });
            records.push({
              engine,
              browser: browser.version(),
              width,
              colorScheme,
              version,
              ...measures,
            });
          }
          assert.deepEqual(errors, []);
          await page.close();
          console.log(`PASS ${engine} ${width} ${colorScheme}`);
        }
    } finally {
      await browser.close();
    }
  }
} finally {
  await server.close();
}
await writeFile(
  join(output, "measurements.json"),
  `${JSON.stringify(records, null, 2)}\n`,
);
