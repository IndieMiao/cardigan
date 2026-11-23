// C-615: attachments in comments. Captures 1440 and 390 × light/dark of the card
// page: the timeline with attachment chips (own, other card, unknown number as
// text, an image chip hovered), the comment box with chosen files as chips and
// a refused file's reason, and the `#` list open. Measures chip geometry and
// page overflow.
// CHROMIUM_PATH=<chrome> node apps/web/test-support/c615-capture.mjs <new output dir>
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(process.argv[2] ?? "");
assert(process.argv[2], "Pass a new output directory");
// A 160×100 synthetic gradient PNG for the image chip's hover preview.
const png = (() => {
  const width = 160;
  const height = 100;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      rows[row + 1 + x * 3] = 40 + x;
      rows[row + 2 + x * 3] = 90 + y;
      rows[row + 3 + x * 3] = 200;
    }
  }
  const crc = (data) => {
    let c = ~0;
    for (const byte of data) {
      c ^= byte;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
})();
const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "c615-fixture",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url?.startsWith("/__c615/files/")) {
            const image = req.url.endsWith(".png");
            res.setHeader("Content-Type", image ? "image/png" : "text/plain");
            res.end(image ? png : "synthetic C-615 file\n");
            return;
          }
          if (!req.url?.startsWith("/__c615")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              "/__c615",
              '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/c615-fixture.tsx"></script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
const cases = [];
let browser;
try {
  await mkdir(output, { recursive: true });
  await server.listen();
  browser = await chromium({
    args: [
      "--run-all-compositor-stages-before-draw",
      "--disable-gpu",
      "--force-color-profile=srgb",
    ],
  });
  const { send, evaluate } = browser;
  const run = (fn, ...args) =>
    evaluate(`(${fn.toString()})(...${JSON.stringify(args)})`);
  const until = async (expression, ms = 20000) => {
    const end = Date.now() + ms;
    while (!(await evaluate(expression))) {
      assert(Date.now() < end, expression);
      await delay(25);
    }
  };
  const settle = async () => {
    await run(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    );
    await delay(150);
  };
  const shot = async (name) => {
    const { data } = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    await writeFile(resolve(output, name), Buffer.from(data, "base64"));
    return name;
  };
  const measure = () =>
    run(() => {
      const box = (e) => {
        const r = e.getBoundingClientRect();
        return {
          text: e.textContent.trim(),
          top: Math.round(r.top),
          left: Math.round(r.left),
          width: Math.round(r.width),
          height: Math.round(r.height),
        };
      };
      return {
        chips: [
          ...document.querySelectorAll(".timeline-body a.ui-attachment-ref"),
        ].map(box),
        plain: [...document.querySelectorAll(".timeline-body")].some((b) =>
          b.textContent.includes("attachment-404"),
        ),
        pending: [...document.querySelectorAll(".ui-file-chip")].map(box),
        problems: [...document.querySelectorAll(".ui-file-problems li")].map(
          (e) => e.textContent,
        ),
        options: [...document.querySelectorAll("[role=option]")].map(
          (e) => e.textContent,
        ),
        // The hover preview, if shown, stays inside the viewport.
        peek: (() => {
          const shown = [
            ...document.querySelectorAll(".ui-attachment-ref-peek"),
          ].find((e) => getComputedStyle(e).display !== "none");
          if (!shown) return null;
          const r = shown.getBoundingClientRect();
          return { left: Math.round(r.left), right: Math.round(r.right) };
        })(),
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth,
      };
    });
  for (const [width, theme] of [1440, 390].flatMap((w) =>
    ["light", "dark"].map((t) => [w, t]),
  )) {
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height: width > 600 ? 1000 : 844,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const tag = `${width}-${theme}`;
    const result = { width, theme, shots: [] };
    cases.push(result);
    // The Workbench follows the system colour scheme (theme.css media query).
    await send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: theme }],
    });
    await send("Page.navigate", { url: "about:blank" });
    await until("location.href === 'about:blank'");
    await send("Page.navigate", {
      url: `${server.resolvedUrls.local[0]}__c615#/p/p-1/cards/C-1`,
    });
    await until("!!document.querySelector('.card-page .comment-input')");
    await evaluate("document.fonts.ready.then(() => true)");
    result.scheme = await run(() => ({
      dark: matchMedia("(prefers-color-scheme: dark)").matches,
      background: getComputedStyle(document.body).backgroundColor,
    }));
    await run(() => {
      [...document.querySelectorAll(".card-page [role=tab]")]
        .find((t) => t.textContent.startsWith("时间线"))
        ?.click();
    });
    await until("document.querySelectorAll('a.ui-attachment-ref').length > 0");
    await run(() =>
      document
        .querySelector("a.ui-attachment-ref")
        .closest(".timeline-body")
        .scrollIntoView({ block: "center" }),
    );
    await settle();
    // Hover the image chip so its preview shows.
    const image = await run(() => {
      const chip = document.querySelector(
        'a.ui-attachment-ref[data-kind="image"]',
      );
      chip.scrollIntoView({ block: "center" });
      const r = chip.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: image.x,
      y: image.y,
    });
    await settle();
    result.timeline = await measure();
    result.shots.push(await shot(`timeline-${tag}.png`));
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 0, y: 0 });

    // The comment box: two chosen files, one refused, then `#`.
    await run(() => {
      const input = document.querySelector(".comment-input");
      input.scrollIntoView({ block: "center" });
      input.focus();
    });
    await settle();
    await run(() => {
      const picker = document.querySelector('.comment-box input[type="file"]');
      const transfer = new DataTransfer();
      transfer.items.add(
        new File(["%PDF-1.4"], "复测报告.pdf", { type: "application/pdf" }),
      );
      transfer.items.add(new File(["log"], "replay.log", { type: "" }));
      transfer.items.add(
        new File(["zip"], "build.zip", { type: "application/zip" }),
      );
      picker.files = transfer.files;
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await until("document.querySelectorAll('.ui-file-chip').length === 2");
    await run(() => document.querySelector(".comment-input").focus());
    await settle();
    result.files = await measure();
    result.shots.push(await shot(`comment-files-${tag}.png`));
    await send("Input.insertText", { text: "复测结果见 #" });
    await until("document.querySelectorAll('[role=option]').length > 0");
    await settle();
    result.box = await measure();
    result.shots.push(await shot(`comment-box-${tag}.png`));
  }
  await writeFile(
    resolve(output, "measurements.json"),
    `${JSON.stringify(cases, null, 2)}\n`,
  );
  for (const width of [1440, 390]) {
    const light = cases.find((c) => c.width === width && c.theme === "light");
    const dark = cases.find((c) => c.width === width && c.theme === "dark");
    assert.equal(light.scheme.dark, false, `${width}: light scheme`);
    assert.equal(dark.scheme.dark, true, `${width}: dark scheme`);
    assert.notEqual(
      light.scheme.background,
      dark.scheme.background,
      `${width}: light and dark backgrounds differ`,
    );
    for (const name of ["timeline", "comment-files", "comment-box"]) {
      const [a, b] = await Promise.all(
        ["light", "dark"].map((theme) =>
          readFile(resolve(output, `${name}-${width}-${theme}.png`)),
        ),
      );
      assert(!a.equals(b), `${name} ${width}: light and dark shots differ`);
    }
  }
  for (const c of cases) {
    const label = `${c.width}/${c.theme}`;
    assert.equal(c.timeline.chips.length, 6, `${label}: chips`);
    assert.equal(c.timeline.plain, true, `${label}: unknown stays text`);
    assert(c.timeline.peek, `${label}: hover preview shown`);
    assert(
      c.timeline.peek.left >= 0 &&
        c.timeline.peek.right <= c.timeline.innerWidth,
      `${label}: hover preview inside the viewport`,
    );
    assert.equal(c.files.pending.length, 2, `${label}: pending`);
    assert.equal(c.files.problems.length, 1, `${label}: refused`);
    assert.equal(c.box.options.length, 5, `${label}: candidates`);
    for (const m of [c.timeline, c.files, c.box])
      assert(m.scrollWidth <= m.innerWidth, `${label}: page overflows`);
  }
} finally {
  await browser?.close();
  await server.close();
}
