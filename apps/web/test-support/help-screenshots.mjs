import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

// C-206: local fixture only; no business server, credentials or real data.
const output = process.argv[2];
assert(output, "Pass a screenshot output directory");
await mkdir(output, { recursive: true });
const server = await createServer({
  root: fileURLToPath(new URL("../", import.meta.url)),
  server: { host: "localhost", port: 0 },
  plugins: [
    {
      name: "help-screenshot-entry",
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (!request.url?.startsWith("/__help")) return next();
          response.setHeader("Content-Type", "text/html");
          response.end(
            await server.transformIndexHtml(
              "/__help",
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
let browser;
const measurements = [];
try {
  await server.listen();
  const origin = server.resolvedUrls.local[0];
  browser = await chromium();
  for (const width of [1440, 1920, 2560, 390]) {
    for (const theme of ["light", "dark"]) {
      await browser.send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await browser.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: theme }],
      });
      await browser.send("Page.navigate", {
        url: `${origin}__help?width=${width}&theme=${theme}#/p/p-1/help`,
      });
      await browser.evaluate(`new Promise((resolve, reject) => {
        const deadline = performance.now() + 10000;
        function check() {
          if (document.querySelector('.help-markdown .status-passed')) return resolve(true);
          if (performance.now() > deadline) return reject(new Error('Help did not load'));
          setTimeout(check, 50);
        }
        check();
      })`);
      await browser.evaluate("document.fonts.ready");
      assert(
        await browser.evaluate(
          "document.documentElement.scrollWidth <= innerWidth",
        ),
        "Help page overflows horizontally",
      );
      assert(
        await browser.evaluate(
          "document.querySelectorAll('.help-directory a').length >= 2",
        ),
      );
      const save = async (suffix) => {
        const { data } = await browser.send("Page.captureScreenshot", {
          format: "png",
        });
        await writeFile(
          resolve(output, `${width}-${theme}-${suffix}.png`),
          Buffer.from(data, "base64"),
        );
      };
      const measure = async (documentName) => {
        const value = await browser.evaluate(`(() => {
          const width = (element) => element.getBoundingClientRect().width;
          const article = document.querySelector('.help-markdown');
          const page = document.querySelector('.help-page');
          const content = document.querySelector('.content');
          const prose = [...article.querySelectorAll('p, ul, ol, h1, h2, h3, h4, h5, h6')];
          return {
            scrollWidth: document.documentElement.scrollWidth,
            articleWidth: width(article),
            pageWidth: width(page),
            availableWidth: content.clientWidth - parseFloat(getComputedStyle(content).paddingLeft) - parseFloat(getComputedStyle(content).paddingRight),
            prose: prose.map(element => ({tag: element.tagName, width: width(element)})),
            tables: [...article.querySelectorAll('table')].map(width),
            code: [...article.querySelectorAll('pre')].map(element => {
              element.scrollLeft = element.scrollWidth;
              return {width: width(element), clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, scrollLeft: element.scrollLeft};
            }),
          };
        })()`);
        const label = `${documentName} ${width} ${theme}`;
        assert.equal(value.scrollWidth, width, `${label}: horizontal overflow`);
        assert.equal(
          value.pageWidth,
          value.availableWidth,
          `${label}: page must fill content`,
        );
        assert(value.prose.length > 0, `${label}: missing prose`);
        if (documentName === "prose-fixture") {
          for (const tag of ["P", "UL", "OL", "H2"])
            assert(
              value.prose.some((block) => block.tag === tag),
              `${label}: missing ${tag}`,
            );
          assert.equal(value.code.length, 1, `${label}: missing code block`);
        }
        for (const block of value.prose)
          assert(
            block.width <= Math.min(680, value.articleWidth),
            `${label}: ${block.tag} exceeds reading width`,
          );
        for (const tableWidth of value.tables)
          assert.equal(
            tableWidth,
            value.articleWidth,
            `${label}: table must use available width`,
          );
        for (const code of value.code) {
          assert.equal(
            code.width,
            value.articleWidth,
            `${label}: code must use available width`,
          );
          assert(
            code.scrollWidth > code.clientWidth,
            `${label}: long code should scroll`,
          );
          assert.equal(
            code.scrollLeft + code.clientWidth,
            code.scrollWidth,
            `${label}: code end must be reachable`,
          );
        }
        measurements.push({ document: documentName, width, theme, ...value });
      };
      await measure("identifiers");
      await save("identifiers");
      await browser.evaluate(
        "document.querySelector('.status-blocked').scrollIntoView({block: 'start'})",
      );
      await save("statuses");
      if (width === 390) {
        await browser.evaluate(
          "scrollTo(0, 0); document.querySelector('[aria-label=\"打开导航\"]').click()",
        );
        await browser.evaluate(
          "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
        );
        assert(
          await browser.evaluate(
            "Boolean(document.querySelector('[role=dialog] a[href$=\"/help\"]'))",
          ),
        );
        await save("drawer");
        await browser.evaluate(
          "document.querySelector('[role=dialog] a[href$=\"/help\"]').click()",
        );
      }
      await browser.evaluate(
        "document.querySelector('.help-directory a[href*=\"02-navigation\"]').click()",
      );
      await browser.evaluate(
        "new Promise(resolve => setTimeout(resolve, 100))",
      );
      assert.equal(
        await browser.evaluate(
          "document.querySelector('.help-article').getAttribute('aria-label')",
        ),
        "查找工作和记录",
      );
      await browser.evaluate("scrollTo(0, 0)");
      await measure("navigation");
      await save("navigation");
      // Exercise supported Markdown that the shipped guides do not yet use.
      // Render through the real component; never change the product documents.
      await browser.evaluate(`(async () => {
        const {mountHelpProseFixture} = await import('/test-support/help-prose-fixture.tsx');
        mountHelpProseFixture();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await document.fonts.ready;
      })()`);
      await measure("prose-fixture");
      await save("prose-fixture");
      console.log(`PASS help ${width} ${theme}`);
    }
  }
  assert.deepEqual(browser.errors, [], "Browser runtime errors");
  await writeFile(
    resolve(output, "measurements.json"),
    `${JSON.stringify(measurements, null, 2)}\n`,
  );
  console.log(
    "Help screenshots: 1440/1920/2560/390, light/dark, prose widths, wide blocks, directory and drawer passed.",
  );
} finally {
  await browser?.close();
  await server.close();
}
