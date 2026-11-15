import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

// Real App and CSS with existing in-memory fixtures; no business server or CI.
const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(
  process.argv[2] ?? "/tmp/cardigan-merge-capacity-targets",
);
const baseline =
  process.env.TARGETS_BASELINE_REF ??
  "7e38cfc6a7363a8fb972fe7164c50a40ecbd47d5";
const baselineCss = execFileSync(
  "git",
  ["show", `${baseline}:apps/web/src/styles.css`],
  { cwd: root, encoding: "utf8" },
);
await mkdir(output, { recursive: true });
const measurements = [];
for (const before of [true, false]) {
  const server = await createServer({
    root,
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "merge-capacity-targets",
        enforce: "pre",
        load(id) {
          if (before && id === resolve(root, "src/styles.css"))
            return baselineCss;
        },
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/__targets")) return next();
            const fixture = req.url.includes("merge=1")
              ? "compact-merge"
              : "capacity-header-fixture";
            res.setHeader("Content-Type", "text/html");
            res.end(
              await server.transformIndexHtml(
                "/__targets",
                `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/${fixture}.tsx"></script></body></html>`,
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
      const deadline = Date.now() + 15000;
      while (!(await evaluate(expression))) {
        assert(Date.now() < deadline, expression);
        await delay(40);
      }
    };
    const key = async (key, code) => {
      for (const type of ["keyDown", "keyUp"])
        await send("Input.dispatchKeyEvent", {
          type,
          key,
          code: key,
          windowsVirtualKeyCode: code,
          ...(type === "keyDown" && key === "Enter" ? { text: "\r" } : {}),
        });
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
          features: [
            { name: "prefers-color-scheme", value: theme },
            { name: "prefers-reduced-motion", value: "reduce" },
          ],
        });
        for (const page of [
          "execution",
          "settings",
          "passed",
          "queued",
          "running",
        ]) {
          const merge = ["passed", "queued", "running"].includes(page);
          const name = `${before ? "before" : "after"}-${page}-${width}-${theme}`;
          await send("Page.navigate", {
            url: `${server.resolvedUrls.local[0]}__targets?merge=${merge ? 1 : 0}&scenario=premerge-${page}#/p/p-1/${merge ? "cards/C-199" : page}`,
          });
          await until(
            merge
              ? "!!document.querySelector('.needs-merge')"
              : "!!document.querySelector('.capacity-status')",
          );
          if (page === "settings") {
            await evaluate(
              "[...document.querySelectorAll('.settings-layout nav button')].find(b => b.textContent === '并发与容量').click()",
            );
            await until("!!document.querySelector('.capacity-settings input')");
          }
          await evaluate("document.fonts.ready");
          await evaluate(
            "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))",
          );
          if (merge) {
            // Native keyboard disclosure and focus must survive the larger box.
            await evaluate(
              "document.querySelector('.merge-quote summary').focus()",
            );
            await key("Enter", 13);
            assert.equal(
              await evaluate("document.querySelector('.merge-quote').open"),
              true,
            );
            await key("Enter", 13);
            assert.equal(
              await evaluate("document.querySelector('.merge-quote').open"),
              false,
            );
            await evaluate(
              "[...document.querySelectorAll('.merge-evidence summary')].find(s => s.textContent === '合并检查详情').focus()",
            );
            await key("Enter", 13);
            assert.equal(
              await evaluate(
                "[...document.querySelectorAll('.merge-evidence summary')].find(s => s.textContent === '合并检查详情').parentElement.open",
              ),
              true,
            );
            const blocked = await evaluate(
              "[...document.querySelectorAll('.needs-merge button')].find(b => b.textContent.trim() === '确认合并').disabled",
            );
            assert.equal(
              blocked,
              page !== "passed",
              `${name}: merge eligibility changed`,
            );
          } else if (page === "execution") {
            await evaluate(
              "document.querySelector('.capacity-status').focus()",
            );
            await until("!!document.querySelector('.capacity-tooltip')");
            assert(
              await evaluate(
                "(() => { const p = document.querySelector('.capacity-tooltip'); const r = p.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && p.scrollWidth <= p.clientWidth; })()",
              ),
              `${name}: tooltip overflow`,
            );
            await key("Escape", 27);
            await until("!document.querySelector('.capacity-tooltip')");
          } else {
            await evaluate(
              "document.querySelector('.capacity-settings input').focus()",
            );
            assert.deepEqual(
              await evaluate(
                "[...document.querySelectorAll('.capacity-settings input')].map(i => ({ value: i.value, max: i.max }))",
              ),
              [
                { value: "6", max: "16" },
                { value: "4", max: "8" },
              ],
            );
          }
          const metric = await evaluate(`(() => {
          const selector = ${JSON.stringify(merge ? ".needs-merge button:not(.employee-trigger), .needs-merge .merge-evidence summary, .needs-merge .merge-quote summary" : page === "settings" ? ".capacity-settings .execution-capacity-edit input, .capacity-settings .execution-capacity-edit button" : ".capacity-status")};
          const targets = [...document.querySelectorAll(selector)].filter(e => e.getBoundingClientRect().height > 0).map(e => {
            const r = e.getBoundingClientRect(), s = getComputedStyle(e);
            return { text: e.textContent.trim() || e.getAttribute('aria-label'), width: r.width, height: r.height, boxSizing: s.boxSizing, padding: s.padding, border: s.border, disabled: !!e.disabled };
          });
          const focus = getComputedStyle(document.activeElement);
          return { scrollWidth: document.documentElement.scrollWidth, targets, focus: { width: focus.outlineWidth, style: focus.outlineStyle } };
        })()`);
          assert.equal(metric.scrollWidth, width, `${name}: page overflow`);
          assert(metric.targets.length > 0, `${name}: no targets`);
          assert.equal(
            metric.focus.style,
            "solid",
            `${name}: focus outline missing`,
          );
          assert.equal(
            metric.focus.width,
            "2px",
            `${name}: focus outline missing`,
          );
          if (!before)
            for (const target of metric.targets) {
              assert(
                target.width >= 44 && target.height >= 44,
                `${name}: ${JSON.stringify(target)}`,
              );
              assert.equal(target.boxSizing, "border-box");
            }
          measurements.push({ name, width, theme, ...metric });
          if (merge)
            await evaluate(
              "document.querySelector('.needs-merge').scrollIntoView({block:'start'})",
            );
          const { data } = await send("Page.captureScreenshot", {
            format: "png",
          });
          await writeFile(
            resolve(output, `${name}.png`),
            Buffer.from(data, "base64"),
          );
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
      data: "existing non-production in-memory App fixtures; no candidate checks or business writes",
      measurements,
    },
    null,
    2,
  ),
);
console.log(
  `PASS ${measurements.length} layouts; 44px targets, disclosure, focus, merge eligibility and overflow; ${output}`,
);
