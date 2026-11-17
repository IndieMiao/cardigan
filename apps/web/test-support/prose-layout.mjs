import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

const output = resolve(process.argv[2]);
await mkdir(output); // Never replace existing evidence.
const sha = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const dirty = execFileSync("git", ["status", "--porcelain"], {
  encoding: "utf8",
}).trim();
const server = await createServer({
  root: fileURLToPath(new URL("../", import.meta.url)),
  server: { host: "localhost", port: 0 },
  plugins: [
    {
      name: "prose-layout-fixture",
      configureServer(s) {
        s.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__prose")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await s.transformIndexHtml(
              "/__prose",
              '<!doctype html><html lang="zh-CN"><head><title>正文布局回归</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/prose-fixture.tsx"></script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
const records = [];
let browser;
try {
  await server.listen();
  browser = await chromium();
  const { send, evaluate } = browser;
  const until = async (expression) => {
    const end = Date.now() + 15000;
    while (!(await evaluate(expression))) {
      assert(Date.now() < end, expression);
      await delay(40);
    }
  };
  for (const width of [390, 768, 1440]) {
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    for (const theme of ["light", "dark"]) {
      await send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: theme }],
      });
      for (const mode of ["page", "drawer", "outside"]) {
        const hash =
          mode === "drawer"
            ? "#/p/p-1/cards?view=list&card=C-1"
            : "#/p/p-1/cards/C-1";
        const name = `${mode}-${theme}-${width}`;
        await send("Page.navigate", {
          url: `${server.resolvedUrls.local[0]}__prose?case=${name}${mode === "outside" ? "&outside=1" : ""}${hash}`,
        });
        await until("Boolean(document.getElementById('entry-C-1#2'))");
        await evaluate("document.fonts.ready");
        if (mode !== "outside") {
          await evaluate(
            "document.getElementById('card-C-1-timeline-tab').click()",
          );
          await until(
            "!document.getElementById('entry-C-1#2').closest('[hidden]')",
          );
        }
        const measurement = await evaluate(`(() => {
          const token = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
          const rgb = value => value.match(/[\\d.]+/g).slice(0, 3).map(Number);
          const luminance = color => rgb(color).map(v => { const x = v / 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; }).reduce((sum, x, i) => sum + x * [.2126, .7152, .0722][i], 0);
          const expectedColor = value => { const span = document.createElement('span'); span.style.color = value; document.body.append(span); const color = getComputedStyle(span).color; span.remove(); return color; };
          const samples = Array.from({length: 7}, (_, i) => {
            const row = document.getElementById('entry-C-1#' + (i + 1));
            const body = row.querySelector('.timeline-body');
            const paragraph = body.querySelector('p');
            const style = getComputedStyle(paragraph);
            let ancestor = paragraph, background;
            while (ancestor) {
              const bg = getComputedStyle(ancestor).backgroundColor;
              if (bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') { background = bg; break; }
              ancestor = ancestor.parentElement;
            }
            background ||= expectedColor(token('--bg'));
            const fg = luminance(style.color), bg = luminance(background);
            return { id: i + 1, color: style.color, fontSize: style.fontSize, lineHeight: style.lineHeight, background, contrast: (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05), muted: !!body.closest('.ui-prose-muted') };
          });
          return { samples, mutedColor: expectedColor(token('--text-muted')), primaryColor: expectedColor(token('--text')), smallSize: token('--ui-text-sm'), readingSize: token('--text-reading') };
        })()`);
        records.push({ name, ...measurement });
        for (const sample of measurement.samples) {
          const muted = mode !== "outside" && [2, 3, 6].includes(sample.id);
          assert.equal(
            sample.muted,
            muted,
            `${name} sample ${sample.id} classification`,
          );
          assert.equal(
            sample.color,
            muted ? measurement.mutedColor : measurement.primaryColor,
            `${name} sample ${sample.id} actual paragraph color`,
          );
          assert.equal(
            sample.fontSize,
            muted ? measurement.smallSize : measurement.readingSize,
            `${name} sample ${sample.id} actual paragraph size`,
          );
          assert(
            sample.contrast >= 4.5,
            `${name} sample ${sample.id} AA contrast`,
          );
          if (muted) assert.equal(sample.lineHeight, "20px");
        }
        if (mode !== "outside") {
          await evaluate(
            "document.getElementById('entry-C-1#3').scrollIntoView({block:'start'})",
          );
          await delay(100);
          const { data } = await send("Page.captureScreenshot", {
            format: "png",
          });
          await writeFile(
            resolve(output, `${name}.png`),
            Buffer.from(data, "base64"),
            { flag: "wx" },
          );
        }
      }
    }
  }
  assert.equal(browser.errors.length, 0, "browser exceptions");
  await writeFile(
    resolve(output, "measurements.json"),
    JSON.stringify(
      {
        sha,
        dirty,
        fixture:
          "one fixed synthetic card, seven entries, two work items; no production data or backend",
        records,
      },
      null,
      2,
    ),
    { flag: "wx" },
  );
  console.log(
    `${records.length} prose cases passed; screenshots and computed paragraph styles: ${output}`,
  );
} finally {
  await browser?.close();
  await server.close();
}
