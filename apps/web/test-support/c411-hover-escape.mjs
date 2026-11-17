import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

// V-1862: exercise mouse-only hover with natural page/drawer focus.
const output = resolve(process.argv[2]);
await mkdir(output, { recursive: true });
const sha = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const server = await createServer({
  root: fileURLToPath(new URL("../", import.meta.url)),
  server: { host: "localhost", port: 0 },
  plugins: [
    {
      name: "template-hover-escape",
      configureServer(s) {
        s.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__template-hover")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await s.transformIndexHtml(
              "/__template-hover",
              '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/c411-fixture.tsx"></script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
let browser;
const records = [];
try {
  await server.listen();
  browser = await chromium();
  const { send, evaluate } = browser;
  const until = async (expr) => {
    const end = Date.now() + 10000;
    while (!(await evaluate(expr))) {
      assert(Date.now() < end, expr);
      await delay(40);
    }
  };
  const pressEscape = async () => {
    for (const type of ["keyDown", "keyUp"])
      await send("Input.dispatchKeyEvent", {
        type,
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
      });
  };
  const screenshot = async (name) => {
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    await writeFile(
      resolve(output, `${name}.png`),
      Buffer.from(data, "base64"),
    );
  };
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"])
      for (const drawer of [false, true]) {
        await send("Emulation.setDeviceMetricsOverride", {
          width,
          height: width === 390 ? 844 : 900,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await send("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: theme }],
        });
        const context = drawer ? "drawer" : "page";
        const name = `${theme}-${width}-${context}`;
        const hash = drawer
          ? "#/p/p-1/cards?view=list&count=20&card=C-904"
          : "#/p/p-1/cards/C-904";
        // Distinct document per case: avoid reusing an already focused button.
        await send("Page.navigate", {
          url: `${server.resolvedUrls.local[0]}__template-hover?case=${name}${hash}`,
        });
        const selector = drawer
          ? ".drawer-content .template-marker"
          : ".card-page .template-marker";
        await until(`Boolean(document.querySelector('${selector}'))`);
        await evaluate("document.fonts.ready");
        await delay(300);
        assert(
          await evaluate(
            `document.activeElement !== document.querySelector('${selector}')`,
          ),
          "Do not focus the marker",
        );
        await evaluate(
          "void (window.c411InitialFocus = document.activeElement)",
        );
        const point = await evaluate(
          `(() => { const r = document.querySelector('${selector}').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`,
        );
        await send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          ...point,
        });
        await until("Boolean(document.querySelector('.template-marker-tip'))");
        const state = () =>
          evaluate(
            `({tip:!!document.querySelector('.template-marker-tip'),drawer:!!document.querySelector('.drawer-content'),focus:document.activeElement.className,focusPreserved:document.activeElement===window.c411InitialFocus})`,
          );
        const before = await state();
        assert(before.focusPreserved);
        if (drawer) assert(before.focus.includes("drawer-close"));
        await screenshot(`${name}-hover`);
        await pressEscape();
        await until("!document.querySelector('.template-marker-tip')");
        const firstEscape = await state();
        assert.equal(firstEscape.drawer, drawer);
        assert(firstEscape.focusPreserved);
        await screenshot(`${name}-escape`);
        await pressEscape();
        if (drawer) await until("!document.querySelector('.drawer-content')");
        const secondEscape = await state();
        assert.equal(secondEscape.drawer, false);
        records.push({
          width,
          theme,
          context,
          before,
          firstEscape,
          secondEscape,
        });
      }
  assert.deepEqual(browser.errors, []);
  await writeFile(
    resolve(output, "hover-escape.json"),
    JSON.stringify(
      {
        sha,
        seed: "c411-implementation-v1",
        syntheticCards: 12,
        records,
        errors: browser.errors,
      },
      null,
      2,
    ),
  );
  console.log(`${records.length} natural-focus hover/Escape checks passed`);
} finally {
  await browser?.close();
  await server.close();
}
