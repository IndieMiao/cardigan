import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(process.argv[2] ?? "/tmp/cardigan-c271");
const baseline =
  process.env.PRE_MERGE_BASELINE_REF ??
  "17e01446c0f4d08b622d51d1be6e7b20c884e1c3";
await mkdir(output, { recursive: true });
const measurements = [];
const interactions = [];
for (const before of [true, false]) {
  const server = await createServer({
    root,
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "pre-merge-fixture",
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
            if (!request.url?.startsWith("/__premerge")) return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await server.transformIndexHtml(
                "/__premerge",
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
    const key = async (key, code, modifiers = 0) => {
      for (const type of ["keyDown", "keyUp"])
        await send("Input.dispatchKeyEvent", {
          type,
          key,
          code: key,
          windowsVirtualKeyCode: code,
          modifiers,
        });
    };
    const shot = async (name, fullPage = false) => {
      const { cssContentSize } = await send("Page.getLayoutMetrics");
      const { data } = await send("Page.captureScreenshot", {
        format: "png",
        ...(fullPage
          ? {
              captureBeyondViewport: true,
              clip: {
                x: 0,
                y: 0,
                width: cssContentSize.width,
                height: Math.ceil(cssContentSize.height),
                scale: 1,
              },
            }
          : {}),
      });
      await writeFile(
        resolve(output, `${name}.png`),
        Buffer.from(data, "base64"),
      );
    };
    for (const width of [1440, 390])
      for (const theme of ["light", "dark"]) {
        await send("Emulation.setDeviceMetricsOverride", {
          width,
          height: width === 390 ? 844 : 900,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await send("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: theme }],
        });
        for (const page of ["needs", "card"])
          for (const status of ["missing", "queued", "running", "passed"]) {
            const name = `${before ? "before" : "after"}-${page}-${status}-${width}-${theme}`;
            await send("Page.navigate", {
              url: `${server.resolvedUrls.local[0]}__premerge?scenario=premerge-${status}#/p/p-1/${page === "card" ? "cards/C-199" : "needs-you"}`,
            });
            await until(
              "!!document.querySelector('[aria-label=\"合并前置条件\"]')",
            );
            await evaluate("document.fonts.ready");
            await evaluate(
              "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
            );
            const metric = await evaluate(`(() => {
          const find = text => [...document.querySelectorAll('.needs-merge button')].find(b => b.textContent.trim() === text);
          const button = find('确认合并');
          const prerequisites = document.querySelector('[aria-label="合并前置条件"]');
          const style = getComputedStyle(button);
          const normalHeight = ['lineHeight', 'paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'].reduce((sum, k) => sum + parseFloat(style[k]), 0);
          return { clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, button: button.getBoundingClientRect().toJSON(), row: button.closest('.action-row').getBoundingClientRect().toJSON(), prerequisites: prerequisites.getBoundingClientRect().toJSON(), normalHeight, disabled: button.disabled, status: document.querySelector('.decision-check').textContent, reasons: [...prerequisites.querySelectorAll('li')].map(e => e.textContent) };
        })()`);
            measurements.push({ name, ...metric });
            assert.equal(
              metric.scrollWidth,
              metric.clientWidth,
              `${name}: overflow`,
            );
            assert.equal(metric.disabled, status !== "passed", name);
            if (!before) {
              if (status !== "passed")
                assert.equal(metric.status, metric.reasons[0], name);
              else assert.equal(metric.status, "合并检查：已通过", name);
              if (width === 1440)
                assert(
                  Math.abs(metric.button.height - metric.normalHeight) < 1,
                  `${name}: stretched button`,
                );
            }
            if (status !== "missing") continue;
            await shot(name, true);
            await evaluate(
              "[...document.querySelectorAll('.needs-merge button')].find(b => b.textContent.trim() === '仍要合并').click()",
            );
            await until(
              "!!document.querySelector('[role=alertdialog]') && document.activeElement.textContent === '先不确认'",
            );
            const dialog = await evaluate(`(() => {
          const d = document.querySelector('[role=alertdialog]');
          const overlay = document.querySelector('.pre-merge-overlay');
          return { modal: d.getAttribute('aria-modal'), overlay: getComputedStyle(overlay).backgroundColor, overlayBox: overlay.getBoundingClientRect().toJSON(), cancelHeight: [...d.querySelectorAll('button')].find(b => b.textContent === '先不确认').getBoundingClientRect().height };
        })()`);
            assert.notEqual(dialog.overlay, "rgba(0, 0, 0, 0)");
            assert.equal(dialog.overlayBox.width, width);
            await shot(`${name}-dialog`);
            if (!before) {
              assert.equal(dialog.modal, "true");
              if (width === 1440)
                assert(
                  Math.abs(metric.button.height - dialog.cancelHeight) < 1,
                  name,
                );
              await evaluate(
                "document.querySelector('[role=alertdialog] textarea').focus()",
              );
              await send("Input.insertText", { text: "😀".repeat(501) });
              await until(
                "document.querySelector('[role=alertdialog] [role=alert]')?.textContent === '理由最多500个字符，请缩短后再提交。'",
              );
              assert.equal(
                await evaluate(
                  "[...document.querySelector('[role=alertdialog] textarea').value].length",
                ),
                501,
              );
              assert.equal(
                await evaluate(
                  "[...document.querySelectorAll('[role=alertdialog] button')].at(-1).disabled",
                ),
                true,
              );
              await shot(`${name}-limit`);
              await evaluate(
                "document.querySelector('[role=alertdialog] textarea').select()",
              );
              await send("Input.insertText", { text: "😀".repeat(500) });
              await until(
                "![...document.querySelectorAll('[role=alertdialog] button')].at(-1).disabled",
              );
              await evaluate(
                "[...document.querySelectorAll('[role=alertdialog] button')].at(-1).focus()",
              );
              await key("Tab", 9);
              assert.equal(
                await evaluate("document.activeElement.tagName"),
                "TEXTAREA",
              );
              await key("Tab", 9, 8);
              assert.equal(
                await evaluate("document.activeElement.textContent"),
                "确认仍要合并",
              );
              await evaluate(
                "document.querySelector('.needs-merge button').focus()",
              );
              assert.equal(
                await evaluate(
                  "document.querySelector('[role=alertdialog]').contains(document.activeElement)",
                ),
                true,
              );
            }
            await key("Escape", 27);
            await until(
              "!document.querySelector('[role=alertdialog]') && document.activeElement.textContent === '仍要合并'",
            );
            assert.equal(
              await evaluate("document.activeElement.textContent"),
              "仍要合并",
            );
            interactions.push({
              name,
              ...dialog,
              escapeRestoredFocus: true,
              ...(before
                ? {}
                : {
                    forwardAndBackwardTrap: true,
                    externalFocusBlocked: true,
                    overLimitRetainedAndRejected: true,
                    exactLimitAccepted: true,
                  }),
            });
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
  JSON.stringify(
    {
      baseline,
      data: "非生产规模合成数据；仅本地 Web，无业务服务或生产库",
      measurements,
      interactions,
    },
    null,
    2,
  ),
);
console.log(
  `PASS ${measurements.length} layouts, ${interactions.length} dialogs; ${output}`,
);
