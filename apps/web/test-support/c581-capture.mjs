// C-581 evidence: answering a question group while the URL anchors an earlier
// comment. Drives real mouse, wheel and key input through CDP and records the
// page scroll after every step (open at anchor, scroll to question 4, type,
// live refresh, answer, accept the group). Records only, so the same script
// runs on the baseline: C581_BASELINE_REF=<git ref> loads that ref's
// CardDetailPage.tsx. Also captures the card list (reference page) at the same
// width and theme. Synthetic fixture, local Vite only, no backend.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
assert(process.argv[2], "Pass a new output directory");
const output = resolve(process.argv[2]);
await mkdir(output); // Never replace existing evidence.
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const baseline = process.env.C581_BASELINE_REF;
const historical = new Map(
  baseline
    ? [
        [
          resolve(root, "src/views/CardDetailPage.tsx"),
          git("show", `${baseline}:apps/web/src/views/CardDetailPage.tsx`),
        ],
      ]
    : [],
);
const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "c581-fixture",
      enforce: "pre",
      load(id) {
        return historical.get(id.split("?")[0]);
      },
      configureServer(s) {
        s.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__c581")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await s.transformIndexHtml(
              "/__c581",
              '<!doctype html><html lang="zh-CN"><head><title>C-581</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/c581-fixture.tsx"></script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
const probe = `(() => {
  const px = (v) => Math.round(v * 100) / 100;
  const q4 = document.querySelector('[aria-label="第 4 题回答"]');
  const q4title = Array.from(document.querySelectorAll('[aria-label="需求澄清"] *')).find((el) => el.childElementCount === 0 && el.textContent?.startsWith('合成问题 4'));
  const anchor = document.getElementById('entry-C-1#8');
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { top: px(r.top), bottom: px(r.bottom), height: px(r.height) }; };
  return {
    scrollY: px(scrollY),
    q4Title: rect(q4title),
    q4Input: rect(q4),
    anchorEntry: rect(anchor?.closest('.timeline-entry') ?? anchor),
    entry9: rect(document.getElementById('entry-C-1#9')?.closest('.timeline-entry') ?? null),
    viewport: innerHeight,
    active: document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName ?? null,
    q4Value: q4?.value ?? null,
    hash: location.hash,
    reads: window.__c581?.state.reads ?? null,
    document: { clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth },
  };
})()`;
const records = [];
let browser;
try {
  await server.listen();
  browser = await chromium({
    args: [
      "--run-all-compositor-stages-before-draw",
      "--disable-threaded-animation",
      "--disable-threaded-scrolling",
      "--disable-partial-raster",
      "--disable-gpu",
      "--force-color-profile=srgb",
      "--num-raster-threads=1",
    ],
  });
  const { send, evaluate } = browser;
  const version = (await send("Browser.getVersion")).product;
  const until = async (expression, timeout = 15000) => {
    const end = Date.now() + timeout;
    while (!(await evaluate(expression))) {
      assert(Date.now() < end, expression);
      await delay(40);
    }
  };
  /** Waits for in-flight reads and one more layout pass. */
  const settled = async () => {
    await delay(60);
    await until("window.__c581.state.pending === 0");
    await delay(400); // Debounced stream revision + ResizeObserver frames.
    await until("window.__c581.state.pending === 0");
    await delay(200);
  };
  const shoot = async (name) => {
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    await writeFile(
      resolve(output, `${name}.png`),
      Buffer.from(data, "base64"),
      {
        flag: "wx",
      },
    );
  };
  const center = (selector) =>
    evaluate(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    );
  const click = async ({ x, y }) => {
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
      await send("Input.dispatchMouseEvent", {
        type,
        x,
        y,
        button: type === "mouseMoved" ? "none" : "left",
        clickCount: type === "mouseMoved" ? 0 : 1,
      });
  };
  const wheel = async (deltaY, width) => {
    await send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: Math.round(width / 2),
      y: 300,
      deltaX: 0,
      deltaY,
    });
    await delay(300);
  };
  const type = async (text) => {
    for (const ch of text) {
      await send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: ch,
        text: ch,
      });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
      await delay(40);
    }
  };
  /** Button whose own text is exactly `label`, inside the question group. */
  const button = (label, scope = '[aria-label="需求澄清"]') =>
    evaluate(`(() => {
      const el = Array.from(document.querySelectorAll(${JSON.stringify(`${scope} button`)})).find((b) => b.textContent.trim() === ${JSON.stringify(label)} && !b.disabled);
      if (!el) return null;
      el.setAttribute('data-c581-target', '');
      return true;
    })()`);
  for (const width of [1440, 390]) {
    const height = width === 1440 ? 900 : 844;
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    for (const theme of ["light", "dark"]) {
      await send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: theme }],
      });
      const base = server.resolvedUrls.local[0];
      const prefix = `${width}-${theme}`;
      await send("Page.navigate", {
        url: `${base}__c581?case=list-${prefix}#/p/p-1/cards?view=list`,
      });
      await until(
        "document.readyState === 'complete' && !!document.querySelector('table')",
      );
      await evaluate("document.fonts.ready");
      await delay(200);
      await shoot(`reference-cards-${prefix}`);
      const steps = [];
      const step = async (name, extra = {}) => {
        const state = await evaluate(probe);
        steps.push({ step: name, ...state, ...extra });
        await shoot(`${prefix}-${name}`);
      };
      await send("Page.navigate", {
        url: `${base}__c581?case=${prefix}#/p/p-1/cards/C-1?at=entry-C-1%238`,
      });
      await until(
        "!!document.querySelector('[aria-label=\"第 4 题回答\"]') && !!document.getElementById('entry-C-1#8')",
      );
      await evaluate("document.fonts.ready");
      await settled();
      await step("01-open-at-anchor");
      // The reader wheels up until question 4 sits in the upper third.
      const q4 = await evaluate(probe);
      await wheel(Math.round(q4.q4Input.top - height / 3), width);
      await step("02-wheel-to-q4");
      const input = await center('[aria-label="第 4 题回答"]');
      await click(input);
      await type("two");
      await step("03-typing");
      await evaluate("window.__c581.arrive()");
      await settled();
      await step("04-live-refresh-while-typing");
      await type(" cols");
      await step("05-typing-after-refresh");
      await evaluate(
        `(() => { const form = document.querySelector('[aria-label="第 4 题回答"]').closest('form'); form.querySelector('button[type=submit]').setAttribute('data-c581-target', ''); })()`,
      );
      await click(await center("[data-c581-target]"));
      await evaluate(
        "document.querySelector('[data-c581-target]')?.removeAttribute('data-c581-target')",
      );
      await settled();
      await step("06-after-answer");
      // "整组按默认" sits in the group header; wheel there only if needed.
      assert(await button("整组按默认"), "accept-all button");
      const header = await center("[data-c581-target]");
      let wheeled = 0;
      if (header.y < 60 || header.y > height - 60) {
        wheeled = Math.round(header.y - height / 3);
        await wheel(wheeled, width);
      }
      const before = await evaluate("scrollY");
      await click(await center("[data-c581-target]"));
      await evaluate(
        "document.querySelector('[data-c581-target]')?.removeAttribute('data-c581-target')",
      );
      await settled();
      await step("07-after-accept-defaults", {
        wheeled,
        scrollBeforeClick: before,
      });
      await evaluate("window.__c581.arrive()");
      await settled();
      await step("08-another-live-refresh");
      const jumps = steps.slice(2, 8).map((s, i) => ({
        from: steps[i + 1].step,
        to: s.step,
        // The script's own wheel before "整组按默认" is not a jump.
        delta:
          Math.round(
            (s.scrollY - (s.scrollBeforeClick ?? steps[i + 1].scrollY)) * 100,
          ) / 100,
      }));
      // A → B → back to A without touching B, then a refresh of that visit.
      const visible = (box) => !!box && box.bottom > 0 && box.top < height;
      await evaluate("location.hash = '#/p/p-1/cards/C-1?at=entry-C-1%239'");
      await settled();
      await step("09-link-to-entry-9");
      await evaluate("history.back()");
      await settled();
      await step("10-back-to-entry-8");
      await evaluate("window.__c581.arrive()");
      await settled();
      await step("11-refresh-after-back");
      const [toB, backToA, refresh] = steps.slice(8);
      const navigation = {
        entry9VisibleAfterLink: visible(toB.entry9),
        entry8VisibleAfterBack: visible(backToA.anchorEntry),
        hashAfterBack: backToA.hash,
        refreshDelta:
          Math.round((refresh.scrollY - backToA.scrollY) * 100) / 100,
      };
      records.push({
        case: prefix,
        viewport: { width, height },
        steps,
        jumps,
        navigation,
      });
    }
  }
  assert.equal(browser.errors.length, 0, "browser exceptions");
  await writeFile(
    resolve(output, "measurements.json"),
    JSON.stringify(
      {
        sha: git("rev-parse", "HEAD"),
        tree: git("rev-parse", "HEAD^{tree}"),
        dirty: git("status", "--porcelain"),
        baseline: baseline ?? null,
        browser: version,
        dpr: 1,
        fonts:
          "@fontsource-variable/inter, noto-sans-sc, jetbrains-mono (lockfile)",
        fixture:
          "apps/web/test-support/c581-fixture.tsx: one synthetic story card, 6 questions, 9 timeline entries, URL anchor entry-C-1#8, reads delayed 120 ms; no production data or backend",
        records,
      },
      null,
      2,
    ),
    { flag: "wx" },
  );
  console.log(`${records.length} C-581 cases captured: ${output}`);
} finally {
  await browser?.close();
  await server.close();
}
