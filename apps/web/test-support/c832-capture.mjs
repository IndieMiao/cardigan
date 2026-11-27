// C-832 evidence: the device enable prompt in Needs You (H-283 opened; H-284
// opened and its retry refused) at 1440/390 in light/dark, beside the card
// list (the reference page) at the same width and theme. Synthetic fixture.
// Usage: CHROMIUM_PATH=... node test-support/c832-capture.mjs <output-dir> [before|after] [before-dir]
// `before` renders apps/web/src from C832_BASELINE_REF with the same fixture.
// With a before-dir (the `before` run's output) it also writes before|after
// side-by-side images and per-image pixel differences.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(process.argv[2] ?? "c832-evidence");
const phase = process.argv[3] === "before" ? "before" : "after";
const before = process.argv[4] ? resolve(process.argv[4]) : undefined;
const baseline = process.env.C832_BASELINE_REF ?? "origin/main";
const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "c832-fixture",
      enforce: "pre",
      load(id) {
        const file = id.split("?")[0];
        if (phase !== "before" || !file.startsWith(`${root}src/`)) return;
        const relative = file.slice(root.length);
        if (!/\.(tsx?|css)$/.test(relative)) return;
        try {
          return execFileSync(
            "git",
            ["show", `${baseline}:apps/web/${relative}`],
            { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
          );
        } catch {
          return;
        }
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__c832")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              "/__c832",
              `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/c832-fixture.tsx"></script></body></html>`,
            ),
          );
        });
      },
    },
  ],
});
const results = [];
const shots = {};
let browser;
try {
  await mkdir(output, { recursive: true });
  await server.listen();
  browser = await chromium({
    args: [
      "--run-all-compositor-stages-before-draw",
      "--disable-new-content-rendering-timeout",
      "--disable-threaded-animation",
      "--disable-threaded-scrolling",
      "--disable-partial-raster",
      "--disable-gpu",
      "--disable-skia-runtime-opts",
      "--force-color-profile=srgb",
      "--num-raster-threads=1",
    ],
  });
  const { send, evaluate } = browser;
  const version = await send("Browser.getVersion");
  const run = (fn, ...args) =>
    evaluate(`(${fn.toString()})(...${JSON.stringify(args)})`);
  const until = async (expression, ms = 20000) => {
    const end = Date.now() + ms;
    while (!(await evaluate(expression))) {
      assert(Date.now() < end, expression);
      await delay(50);
    }
  };
  const settle = () =>
    run(async () => {
      await document.fonts.ready;
      document.activeElement?.blur();
      await new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(r)),
      );
    });
  const open = async (width, theme, hash) => {
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: theme }],
    });
    await send("Page.navigate", { url: "about:blank" });
    await until("location.href === 'about:blank'");
    await send("Page.navigate", {
      url: `${server.resolvedUrls.local[0]}__c832${hash}`,
    });
    await until("!!window.c832");
    await run((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
  };
  const expand = async (id) => {
    await until(`document.body.innerText.includes('${id}')`);
    await run((id) => {
      document.querySelector(`[aria-label='处理 ${id}']`)?.click();
    }, id);
    await until(
      `!!document.querySelector("form[aria-label='${id} 启用设备']")?.offsetParent`,
    );
  };
  const measure = (id) =>
    run((id) => {
      const box = (e) => {
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return {
          x: +r.x.toFixed(2),
          y: +r.y.toFixed(2),
          w: +r.width.toFixed(2),
          h: +r.height.toFixed(2),
          right: +r.right.toFixed(2),
        };
      };
      const style = (e) => {
        if (!e) return null;
        const s = getComputedStyle(e);
        return {
          font: s.fontSize,
          line: s.lineHeight,
          weight: s.fontWeight,
          color: s.color,
        };
      };
      const text = (e) => e?.textContent?.trim() ?? null;
      const row = id && document.querySelector(`[aria-label='执行 ${id}']`);
      const form = row?.querySelector("form");
      const title = row?.querySelector("h3");
      return {
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth,
        overflow: document.documentElement.scrollWidth > innerWidth,
        pageTitle: style(document.querySelector("h1")),
        toolbarControl: box(
          document.querySelector(".page-toolbar button, .ui-toolbar button"),
        ),
        row: row && {
          box: box(row),
          title: text(title),
          titleStyle: style(title),
          titleBox: box(title),
          primary: box(row.querySelector("[data-needs-row-action] button")),
          form: box(form),
          legend: form && {
            text: text(form.querySelector("legend")),
            style: style(form.querySelector("legend")),
            box: box(form.querySelector("legend")),
          },
          choices: [...(form?.querySelectorAll("label") ?? [])].map((l) => ({
            text: text(l),
            box: box(l),
            style: style(l),
            checkbox: box(l.querySelector("[role=checkbox]")),
            checked:
              l
                .querySelector("[role=checkbox]")
                ?.getAttribute("aria-checked") ?? null,
          })),
          select: box(form?.querySelector("[role=combobox]")),
          buttons: [
            ...(form?.querySelectorAll(":scope > button, :scope button") ?? []),
          ]
            .filter((b) => b.getAttribute("role") !== "checkbox")
            .filter((b) => b.getAttribute("role") !== "combobox")
            .map((b) => ({
              text: text(b),
              box: box(b),
              disabled: b.disabled,
              style: style(b),
            })),
          error: text(row.querySelector("[role=alert]")),
          feedback: [
            ...document.querySelectorAll(".request-feedback-region"),
          ].map((r) => ({ text: text(r), box: box(r) })),
        },
      };
    }, id);
  const shot = async (name) => {
    const { data } = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    shots[name] = data;
    await writeFile(resolve(output, name), Buffer.from(data, "base64"));
  };
  const record = async (name, id) => {
    await settle();
    await delay(200);
    const metrics = await measure(id);
    assert(!metrics.overflow, `${name}: page overflows`);
    await shot(name);
    results.push({ name, ...metrics });
    console.log(`Captured ${name}`);
    return metrics;
  };

  for (const width of [1440, 390])
    for (const theme of ["light", "dark"]) {
      const suffix = `${width}-${theme}.png`;
      await open(width, theme, "#/p/cardigan/cards?view=list");
      await until("!!document.querySelector('.card-table')");
      await record(`list-${suffix}`);
      // A new device on a shared machine: choose projects, then enable.
      await open(width, theme, "#/p/cardigan/needs-you");
      await expand("H-283");
      await record(`needs-${suffix}`, "H-283");
      // A failed initialization: chosen projects kept, the retry refused.
      await open(width, theme, "#/p/cardigan/needs-you");
      await expand("H-284");
      const retried = await run(() => {
        const form = document.querySelector(
          "form[aria-label='H-284 启用设备']",
        );
        const retry = [...(form?.querySelectorAll("button") ?? [])].find(
          (b) => b.textContent?.trim() === "重试",
        );
        if (!retry || retry.disabled) return false;
        retry.click();
        return true;
      });
      if (retried)
        await until(
          "document.body.innerText.includes('设备正在初始化，稍后再试')",
        );
      await run(() =>
        document
          .querySelector("form[aria-label='H-284 启用设备']")
          ?.scrollIntoView({ block: "center" }),
      );
      await record(`failed-${suffix}`, "H-284");
    }
  assert.deepEqual(browser.errors, []);

  await send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.navigate", { url: "about:blank" });
  await until("location.href === 'about:blank'");
  const images = (fn, ...args) =>
    run(
      async (fn, ...args) => {
        const load = (src) =>
          new Promise((r) => {
            const img = new Image();
            img.onload = () => r(img);
            img.src = `data:image/png;base64,${src}`;
          });
        const imgs = await Promise.all(args.map(load));
        return new Function("imgs", fn)(imgs);
      },
      fn,
      ...args,
    );
  const pair = (left, right) =>
    images(
      `const [l, r] = imgs; const c = document.createElement("canvas");
       c.width = l.width + r.width + 16; c.height = Math.max(l.height, r.height);
       const x = c.getContext("2d"); x.fillStyle = "#888"; x.fillRect(0, 0, c.width, c.height);
       x.drawImage(l, 0, 0); x.drawImage(r, l.width + 16, 0);
       return c.toDataURL("image/png").split(",")[1];`,
      left,
      right,
    );
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"]) {
      const suffix = `${width}-${theme}.png`;
      for (const page of ["needs", "failed"])
        await writeFile(
          resolve(output, `reference-${page}-${suffix}`),
          Buffer.from(
            await pair(shots[`list-${suffix}`], shots[`${page}-${suffix}`]),
            "base64",
          ),
        );
    }
  const diffs = {};
  if (before) {
    for (const name of Object.keys(shots)) {
      const old = (await readFile(resolve(before, name))).toString("base64");
      diffs[name] = await images(
        `const [a, b] = imgs; if (a.width !== b.width || a.height !== b.height) return "size";
         const px = (img) => { const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
           const x = c.getContext("2d"); x.drawImage(img, 0, 0); return x.getImageData(0, 0, img.width, img.height).data; };
         const [p, q] = [px(a), px(b)]; let n = 0;
         for (let i = 0; i < p.length; i += 4) if (p[i] !== q[i] || p[i+1] !== q[i+1] || p[i+2] !== q[i+2] || p[i+3] !== q[i+3]) n++;
         return n;`,
        old,
        shots[name],
      );
      if (!name.startsWith("list-"))
        await writeFile(
          resolve(output, `side-by-side-${name}`),
          Buffer.from(await pair(old, shots[name]), "base64"),
        );
    }
  }
  await writeFile(
    resolve(output, "measurements.json"),
    `${JSON.stringify({ phase, browser: version, cases: results, diffs }, null, 2)}\n`,
  );
  console.log(`Wrote ${output}`);
} finally {
  await browser?.close();
  await server.close();
}
