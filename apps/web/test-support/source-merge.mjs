import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

const output = resolve(process.argv[2]);
await mkdir(output, { recursive: true });
const server = await createServer({
  root: resolve("apps/web"),
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "source-merge-fixture",
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__source")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await vite.transformIndexHtml(
              "/__source",
              '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/source-merge.tsx"></script></body></html>',
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
  browser = await chromium();
  const { send, evaluate } = browser;
  const until = async (expression) => {
    const end = Date.now() + 15000;
    while (!(await evaluate(expression))) {
      if (Date.now() > end) throw new Error(`Timeout: ${expression}`);
      await delay(50);
    }
  };
  const button = `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='确认来源无关')`;
  const key = async (key, code, modifiers = 0) => {
    for (const type of ["keyDown", "keyUp"])
      await send("Input.dispatchKeyEvent", {
        type,
        key,
        code: key,
        windowsVirtualKeyCode: code,
        modifiers,
        ...(key === "Enter" && type === "keyDown" ? { text: "\r" } : {}),
      });
  };
  const shot = async (name) => {
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    await writeFile(
      resolve(output, `${name}.png`),
      Buffer.from(data, "base64"),
    );
  };
  const measure = async (name) => {
    const metrics = await evaluate(`(() => {
      const section=document.querySelector('.source-merge-suggestion');
      const box=e=>e.getBoundingClientRect().toJSON();
      const lum=color=>{const c=color.match(/[\\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4});return c[0]*.2126+c[1]*.7152+c[2]*.0722};
      const bg=lum(getComputedStyle(section).backgroundColor);
      return {pageWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,section:box(section),sectionWidth:section.clientWidth,sectionScrollWidth:section.scrollWidth,
        buttons:[...section.querySelectorAll('button')].map(e=>({text:e.textContent,box:box(e)})),
        contrasts:[...section.querySelectorAll('p')].map(e=>{const fg=lum(getComputedStyle(e).color);return {text:e.textContent,ratio:(Math.max(bg,fg)+.05)/(Math.min(bg,fg)+.05)}}),
        focus:document.activeElement?.className,outline:getComputedStyle(document.activeElement).outlineStyle};
    })()`);
    assert.equal(metrics.pageWidth, metrics.scrollWidth, name);
    assert.equal(metrics.sectionWidth, metrics.sectionScrollWidth, name);
    for (const b of metrics.buttons)
      assert(b.box.width >= 44 && b.box.height >= 44, `${name}: hit target`);
    for (const p of metrics.contrasts)
      assert(p.ratio >= 4.5, `${name}: contrast ${p.ratio}`);
    measurements.push({ name, ...metrics });
    await shot(name);
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
      for (const surface of ["needs", "card"]) {
        const name = `${width}-${theme}-${surface}`;
        await send("Page.navigate", {
          url: `${server.resolvedUrls.local[0]}__source?surface=${surface}#/p/p-1/${surface === "needs" ? "needs-you" : "cards/C-1"}`,
        });
        await until(`!!${button}`);
        await evaluate("document.fonts.ready");
        await evaluate(
          "document.querySelector('.source-merge-suggestion').scrollIntoView({block:'center'})",
        );
        // Reach the action through actual Tab navigation; Escape is a no-op (no dialog).
        await evaluate(`${button}.focus()`);
        await key("Tab", 9, 8);
        await key("Tab", 9);
        assert.equal(
          await evaluate(`document.activeElement===${button}`),
          true,
          name,
        );
        await key("Escape", 27);
        assert.equal(await evaluate("sourceFixture.calls.length"), 0);
        await measure(`${name}-suggestion`);
        if (width === 390) {
          const point = await evaluate(
            `(()=>{const r=${button}.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
          );
          await send("Input.dispatchTouchEvent", {
            type: "touchStart",
            touchPoints: [point],
          });
          await send("Input.dispatchTouchEvent", {
            type: "touchEnd",
            touchPoints: [],
          });
        } else await key("Enter", 13);
        await until("sourceFixture.calls.length===1");
        await evaluate(`${button}.click()`);
        assert.equal(await evaluate("sourceFixture.calls.length"), 1);
        assert.equal(await evaluate(`${button}.disabled`), true);
        await evaluate("sourceFixture.finish(false)");
        await until(
          "!!document.querySelector('.source-merge-suggestion [role=alert]')",
        );
        await measure(`${name}-error`);
        await evaluate(`${button}.focus()`);
        await key("Enter", 13);
        await until("sourceFixture.calls.length===2");
        assert.equal(
          await evaluate(
            "sourceFixture.calls[0].at(-1)===sourceFixture.calls[1].at(-1)",
          ),
          true,
        );
        await evaluate("sourceFixture.finish(true)");
        await until(
          "document.querySelector('.source-merge-suggestion [role=status]')?.textContent.includes('由本人确认')",
        );
        await until(
          "document.activeElement?.classList.contains('source-merge-suggestion')",
        );
        await measure(`${name}-audit`);
        assert.equal(
          await evaluate(
            "document.querySelector('.needs-merge').textContent.includes('敏感卡片的合并须由人亲自确认')",
          ),
          true,
        );
      }
      await send("Page.navigate", {
        url: `${server.resolvedUrls.local[0]}__source?mode=multi#/p/p-1/needs-you`,
      });
      await until(
        "document.querySelectorAll('.source-merge-suggestion').length===2",
      );
      await evaluate(
        "document.querySelector('.source-merge-suggestion').scrollIntoView({block:'center'})",
      );
      await measure(`${width}-${theme}-multi`);
      await send("Page.navigate", {
        url: `${server.resolvedUrls.local[0]}__source?mode=stale#/p/p-1/needs-you`,
      });
      await until(
        "document.querySelector('.source-merge-suggestion [role=status]')?.textContent.includes('建议已失效')",
      );
      assert.equal(await evaluate(`!!${button}`), false);
      await evaluate(
        "document.querySelector('.source-merge-suggestion').scrollIntoView({block:'center'})",
      );
      await measure(`${width}-${theme}-stale`);
      await send("Page.navigate", {
        url: `${server.resolvedUrls.local[0]}__source?mode=empty#/p/p-1/needs-you`,
      });
      await until("!!document.querySelector('[role=tablist]')");
      await evaluate("document.fonts.ready");
      assert.equal(
        await evaluate("!!document.querySelector('.source-merge-suggestion')"),
        false,
      );
      await shot(`${width}-${theme}-empty`);
    }
  assert.deepEqual(browser.errors, []);
  await writeFile(
    resolve(output, "measurements.json"),
    JSON.stringify(
      {
        sha: execFileSync("git", ["rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
        worktree: execFileSync("git", ["status", "--short"], {
          encoding: "utf8",
        }).trim(),
        seed: "c311-source-v1",
        data: {
          cards: 1,
          decisions: 2,
          multi_cards: 2,
          multi_decisions: 4,
          persisted_events: 0,
          scale: "synthetic, non-production",
        },
        scope:
          "Local rendering and simulated writes only. No production authentication claims. No modal: Escape submits nothing.",
        measurements,
      },
      null,
      2,
    ),
  );
  process.stdout.write(
    `Captured 36 screenshots and ${measurements.length} measurements.\n`,
  );
} finally {
  await browser?.close();
  await server.close();
}
