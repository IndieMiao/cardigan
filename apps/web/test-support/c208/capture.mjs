import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// Use an already installed local Playwright; this prototype adds no dependency.
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright"
);
const output = process.argv[2];
if (!output) throw Error("Pass an evidence output directory");
const base = process.argv[3] ?? "http://localhost:5183";
if (new URL(base).hostname !== "localhost" || new URL(base).port === "7781")
  throw Error("Use the local prototype server");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  headless: true,
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  colorScheme: "dark",
});
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const results = [];
const readingSamples = [];
const routes = [
  ["needs-you", "needs-you", ".needs-item"],
  ["card", "cards/C-1", ".timeline"],
  ["board", "cards?view=board", ".cards-page-board"],
  ["execution", "execution?view=all", ".execution-row"],
  ["activity", "activity", ".activity-list"],
];
async function settle() {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() =>
    window.scrollTo({ top: 0, left: 0, behavior: "instant" }),
  );
}
async function geometry() {
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  return page.locator(".app *").evaluateAll((elements) =>
    elements.map((e) => {
      const r = e.getBoundingClientRect();
      return [r.x, r.y, r.width, r.height];
    }),
  );
}
try {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const [name, route, selector] of routes) {
      await page.goto(
        `${base}/test-support/c208/index.html?palette=before#/p/p-1/${route}`,
      );
      await page.locator(selector).first().waitFor();
      if (name === "card") {
        await settle();
        await geometry();
        await page
          .locator(".timeline-review summary")
          .filter({ hasText: "问题列表" })
          .click();
        const expand = page
          .locator(".timeline-comment")
          .first()
          .getByRole("button", { name: "展开全文", exact: true });
        if (await expand.count()) await expand.click();
      }
      await page.evaluate(() => {
        document.documentElement.dataset.c208 = "before";
      });
      await settle();
      const beforeBg = await page.evaluate(
        () => getComputedStyle(document.body).backgroundColor,
      );
      await page.screenshot({
        path: resolve(output, `${name}-${width}-before.png`),
        fullPage: true,
      });
      await settle();
      const before = await geometry();
      await page.evaluate(() => {
        document.documentElement.dataset.c208 = "after";
      });
      await settle();
      await page.screenshot({
        path: resolve(output, `${name}-${width}-after.png`),
        fullPage: true,
      });
      const after = await geometry();
      const metrics = await page.evaluate(() => ({
        width: innerWidth,
        scroll: document.documentElement.scrollWidth,
        scrollY,
        bg: getComputedStyle(document.body).backgroundColor,
        apiRequests: performance
          .getEntriesByType("resource")
          .filter((r) => new URL(r.name).pathname.startsWith("/api/")).length,
      }));
      if (
        beforeBg !== "rgb(23, 30, 27)" ||
        metrics.bg !== "rgb(24, 24, 24)" ||
        metrics.scroll > width ||
        metrics.scrollY ||
        metrics.apiRequests ||
        JSON.stringify(before) !== JSON.stringify(after)
      )
        throw Error(
          JSON.stringify({
            name,
            width,
            metrics,
            geometrySame: JSON.stringify(before) === JSON.stringify(after),
            differences: before
              .map((value, i) =>
                JSON.stringify(value) !== JSON.stringify(after[i])
                  ? { i, before: value, after: after[i] }
                  : null,
              )
              .filter(Boolean)
              .slice(0, 10),
          }),
        );
      results.push({ name, width, beforeBg, ...metrics, geometrySame: true });
      if (name === "card") {
        const comment = page.locator(".timeline-comment").first();
        const review = page.locator(".timeline-review").first();
        for (const mode of ["before", "after"]) {
          await page.evaluate((mode) => {
            document.documentElement.dataset.c208 = mode;
          }, mode);
          // Capture document coordinates from the top: locator screenshots scroll
          // the target under the sticky card navigation on narrow viewports.
          await settle();
          await page.screenshot({
            path: resolve(output, `review-issues-${width}-${mode}.png`),
            fullPage: true,
            clip: await review.boundingBox(),
          });
          await page.screenshot({
            path: resolve(output, `long-comment-${width}-${mode}.png`),
            fullPage: true,
            clip: await comment.boundingBox(),
          });
        }
        const details = await comment.evaluate((el) => {
          const body = el.querySelector(".timeline-body");
          const container = el.querySelector(".long-body");
          return {
            text: body.textContent,
            color: getComputedStyle(body).color,
            metadata: getComputedStyle(el.querySelector("time")).color,
            fullyVisible: container.clientHeight >= container.scrollHeight - 1,
          };
        });
        const issues = await review.evaluate((el) => ({
          color: getComputedStyle(el.querySelector(".markdown p")).color,
          open: !!el.querySelector("details[open]"),
          mustFix: el.textContent.includes("必须修复"),
          suggestion: el.textContent.includes("建议"),
        }));
        if (
          !details.text.includes("本轮核对覆盖页面背景") ||
          details.color !== "rgb(204, 204, 204)" ||
          details.metadata !== "rgb(164, 164, 164)" ||
          !details.fullyVisible ||
          issues.color !== details.color ||
          !issues.open ||
          !issues.mustFix ||
          !issues.suggestion
        )
          throw Error(JSON.stringify({ details, issues }));
        readingSamples.push({
          width,
          comment: {
            color: details.color,
            metadata: details.metadata,
            characters: details.text.length,
            fullyVisible: details.fullyVisible,
          },
          issues,
        });
      }
    }
    await page.goto(`${base}/test-support/c208/palette.html`);
    await page.waitForFunction(
      () => document.querySelectorAll("[data-id-kind]").length === 36,
    );
    await settle();
    await page.screenshot({
      path: resolve(output, `palette-${width}.png`),
      fullPage: true,
    });
  }
  await page.emulateMedia({ colorScheme: "light" });
  const lightBefore = await page.evaluate(() => {
    document.documentElement.dataset.c208 = "before";
    return getComputedStyle(document.body).backgroundColor;
  });
  const lightAfter = await page.evaluate(() => {
    document.documentElement.dataset.c208 = "after";
    return getComputedStyle(document.body).backgroundColor;
  });
  if (lightBefore !== lightAfter || errors.length)
    throw Error(JSON.stringify({ lightBefore, lightAfter, errors }));
  await writeFile(
    resolve(output, "browser-checks.json"),
    JSON.stringify(
      {
        scenarios: results,
        readingSamples,
        lightBackground: lightAfter,
        runtimeErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "20 page screenshots + 2 palette screenshots + 8 reading screenshots; 10 geometry/overflow/local-data checks passed.",
  );
} finally {
  await browser.close();
}
