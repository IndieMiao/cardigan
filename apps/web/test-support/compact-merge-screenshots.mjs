import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(process.argv[2] ?? "../../artifacts/c205");
const baseline =
  process.env.COMPACT_BASELINE_REF ??
  "69f4e14b20f453ff4ccea5d2dfe7a322154bdb8d";
await mkdir(output, { recursive: true });
const measurements = [];
for (const before of [true, false]) {
  const server = await createServer({
    root,
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "compact-merge-fixture",
        enforce: "pre",
        load(id) {
          if (!before || !id.startsWith(`${root}src/`)) return;
          const relative = id.slice(root.length);
          if (/\.(tsx|css)$/.test(relative))
            return execFileSync(
              "git",
              ["show", `${baseline}:apps/web/${relative}`],
              { cwd: root, encoding: "utf8" },
            );
        },
        configureServer(server) {
          server.middlewares.use(async (request, response, next) => {
            if (!request.url?.startsWith("/__compact")) return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await server.transformIndexHtml(
                "/__compact",
                '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/compact-merge.tsx"></script></body></html>',
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
    const until = async (expression) => {
      const end = Date.now() + 15000;
      while (!(await evaluate(expression))) {
        assert(Date.now() < end, expression);
        await delay(50);
      }
    };
    for (const [width, theme] of [
      [1440, "light"],
      [390, "light"],
      [1440, "dark"],
    ]) {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height: width === 390 ? 844 : 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: theme }],
      });
      await send("Emulation.setTimezoneOverride", {
        timezoneId: "Asia/Shanghai",
      });
      for (const scenario of before
        ? ["ready"]
        : [
            "ready",
            "pm",
            "zero",
            "unknown",
            "legacy",
            "failed",
            "review",
            "blocked",
          ]) {
        for (const page of ["needs", "card"]) {
          if (["review", "blocked"].includes(scenario) && page === "needs")
            continue;
          const route = page === "card" ? "cards/C-199" : "needs-you";
          await send("Page.navigate", {
            url: `${server.resolvedUrls.local[0]}__compact?scenario=${scenario}#/p/p-1/${route}`,
          });
          await until(
            `!!document.querySelector('${page === "card" ? ".card-header" : ".needs-merge"}')`,
          );
          await evaluate("document.fonts.ready");
          await evaluate(
            "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
          );
          await evaluate("window.scrollTo({top:0,behavior:'instant'})");
          const metric = await evaluate(`(() => {
            const panel = document.querySelector('.needs-merge');
            const buttons = [...document.querySelectorAll('.needs-merge button')];
            const button = buttons.find(b => b.textContent.includes('按建议')) ?? buttons.find(b => b.textContent.trim() === '确认合并');
            return { width: document.documentElement.scrollWidth, height: panel?.getBoundingClientRect().height, actionTop: button?.getBoundingClientRect().top, actionBottom: button?.getBoundingClientRect().bottom, statusRows: document.querySelectorAll('.decision-status-line').length };
          })()`);
          assert.equal(metric.width, width, `${page}/${scenario}: overflow`);
          if (!before)
            assert.equal(
              metric.statusRows,
              1,
              `${page}/${scenario}: duplicate status rows`,
            );
          const name = `${before ? "before" : "after"}-${page}-${scenario}-${width}-${theme}`;
          measurements.push({ name, ...metric });
          // Keep the attachment set focused; all combinations are measured.
          if (
            before ||
            scenario === "ready" ||
            (["review", "blocked"].includes(scenario) && page === "card") ||
            (width === 390 && page === "needs")
          ) {
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
              resolve(output, `${name}.png`),
              Buffer.from(data, "base64"),
            );
            if (width === 390 && scenario === "ready") {
              const shot = await send("Page.captureScreenshot", {
                format: "png",
              });
              await writeFile(
                resolve(output, `${name}-viewport.png`),
                Buffer.from(shot.data, "base64"),
              );
            }
          }
          if (!before && scenario === "ready") {
            // Native disclosure semantics must work from the keyboard, too.
            await evaluate(
              "document.querySelector('.merge-evidence summary').focus()",
            );
            for (const open of [true, false]) {
              await send("Input.dispatchKeyEvent", {
                type: "keyDown",
                text: "\r",
                key: "Enter",
                code: "Enter",
                windowsVirtualKeyCode: 13,
              });
              await send("Input.dispatchKeyEvent", {
                type: "keyUp",
                key: "Enter",
                code: "Enter",
                windowsVirtualKeyCode: 13,
              });
              assert.equal(
                await evaluate(
                  "document.querySelector('.merge-evidence details').open",
                ),
                open,
              );
            }
            if (page === "card") {
              await evaluate(
                "[...document.querySelectorAll('.card-section-nav button')].find(b => b.textContent === '概览').click()",
              );
              assert.equal(
                await evaluate("document.querySelector('.card-purpose').open"),
                true,
              );
            }
          }
        }
      }
    }
    assert.deepEqual(browser.errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
}
await writeFile(
  resolve(output, "measurements.json"),
  JSON.stringify({ baseline, measurements }, null, 2),
);
console.log(`PASS ${measurements.length} layout cases; ${output}`);
