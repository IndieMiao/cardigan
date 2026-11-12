import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

// Only the settings/employee fixture: no backend, live data or general e2e suite.
const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(
  process.argv[2] ?? "../../artifacts/employee-screenshots",
);
await mkdir(output, { recursive: true });
for (const before of [true, false]) {
  const baseline = new Set([
    "src/views/SettingsPage.tsx",
    "src/views/RolesSettings.tsx",
    "src/styles.css",
  ]);
  const server = await createServer({
    root,
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "employee-screenshot-fixture",
        enforce: "pre",
        load(id) {
          const relative = id.startsWith(root) ? id.slice(root.length) : "";
          if (before && baseline.has(relative))
            return execFileSync(
              "git",
              [
                "show",
                `${process.env.EMPLOYEE_BASELINE_REF ?? "origin/main"}:apps/web/${relative}`,
              ],
              { cwd: root, encoding: "utf8" },
            );
        },
        configureServer(server) {
          server.middlewares.use(async (request, response, next) => {
            if (!request.url?.startsWith("/__employees")) return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await server.transformIndexHtml(
                "/__employees",
                '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/employee-fixture.tsx"></script></body></html>',
              ),
            );
          });
        },
      },
    ],
  });
  let browser;
  try {
    await server.listen();
    browser = await chromium();
    const { send, evaluate } = browser;
    const run = (fn, ...args) =>
      evaluate(`(${fn.toString()})(...${JSON.stringify(args)})`);
    const until = async (expression) => {
      const deadline = Date.now() + 15000;
      while (!(await evaluate(expression))) {
        assert(Date.now() < deadline, `Timed out: ${expression}`);
        await delay(40);
      }
    };
    const click = (text) =>
      run((text) => {
        const button = [...document.querySelectorAll("button")].find(
          (item) => item.textContent.trim() === text,
        );
        if (!button) throw new Error(`Missing button: ${text}`);
        button.click();
      }, text);
    const capture = async (name, width, theme) => {
      await evaluate("document.fonts.ready");
      await run(async () => {
        await Promise.all(
          [...document.images]
            .filter((image) => image.getBoundingClientRect().top < innerHeight)
            .map((image) => image.decode().catch(() => {})),
        );
        window.scrollTo(0, 0);
        await new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        );
      });
      assert.equal(
        await evaluate("document.documentElement.scrollWidth"),
        width,
        `${name}: horizontal overflow`,
      );
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
        resolve(output, `${name}-${width}-${theme}.png`),
        Buffer.from(data, "base64"),
      );
    };
    for (const width of [1440, 390])
      for (const theme of ["light", "dark"]) {
        await send("Emulation.setDeviceMetricsOverride", {
          width,
          height: 1080,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await send("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: theme }],
        });
        await send("Page.navigate", { url: "about:blank" });
        await until("location.href === 'about:blank'");
        await send("Page.navigate", {
          url: `${server.resolvedUrls.local[0]}__employees#/p/p-1/settings`,
        });
        await until("Boolean(document.querySelector('.settings-layout nav'))");
        if (before) {
          await click("角色");
          await until("Boolean(document.querySelector('.role-table'))");
          await click("新建角色");
          await until(
            "Boolean(document.querySelector('form[aria-label=\"新建角色\"]'))",
          );
          await capture("before-role", width, theme);
        } else {
          await click("员工");
          await until(
            "document.querySelectorAll('.employee-person').length === 60",
          );
          await click("孙悟空");
          await capture("after-library", width, theme);
          await run(() => {
            document.querySelectorAll('input[name="employee-mode"]')[1].click();
          });
          await until("Boolean(document.querySelector('input[type=file]'))");
          await capture("after-custom", width, theme);
        }
        console.log(`PASS ${before ? "before" : "after"} ${width}px ${theme}`);
      }
    assert.deepEqual(browser.errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
}
