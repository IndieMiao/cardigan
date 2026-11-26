// C-696: the “标记完成” dialog. 1440×1000 and 390×844, light and dark, on
// synthetic data from c696-fixture.tsx (C-48 with 14 files, C-49 with none),
// plus the card list (the baseline page) at the same viewport and theme for
// side-by-side comparison. Same browser flags as the page-skeleton check.
//
//   after (default): dialog with 14 and 0 files, the discard question,
//     submitting, failed and done states.
//   --before: the inline form of the base commit (C-48), for comparison.
//
// Each shot records the dialog, its header/body/footer boxes, the confirm
// button (box, text, in viewport), list rows, fonts and horizontal overflow.
//
// CHROMIUM_PATH=<chrome> node apps/web/test-support/c696-capture.mjs <new dir> [--before]
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const outArg = process.argv[2];
const before = process.argv.includes("--before");
assert(outArg, "Pass a new output directory");
const output = resolve(outArg);
const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "c696-fixture",
      enforce: "pre",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__c696")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              "/__c696",
              `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/c696-fixture.tsx"></script></body></html>`,
            ),
          );
        });
      },
    },
  ],
});
const RESULT = "已现场复核，三层货架标签需更换，照片见附件。";
let browser;
const report = { mode: before ? "before" : "after", shots: [] };
try {
  await mkdir(output);
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
  report.browser = (await send("Browser.getVersion")).product;
  const run = (fn, ...a) =>
    evaluate(`(${fn.toString()})(...${JSON.stringify(a)})`);
  const until = async (expression) => {
    const end = Date.now() + 20000;
    while (!(await evaluate(expression))) {
      assert(Date.now() < end, expression);
      await delay(50);
    }
  };
  const settle = () =>
    run(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    );
  const shot = async (name, full = false) => {
    await delay(250);
    const { data } = await send("Page.captureScreenshot", {
      format: "png",
      ...(full ? { captureBeyondViewport: true } : {}),
    });
    await writeFile(resolve(output, name), Buffer.from(data, "base64"));
    console.log(`Captured ${name}`);
  };
  const open = async (hash, ready, theme, query = "") => {
    await send("Page.navigate", { url: "about:blank" });
    await until("location.href === 'about:blank'");
    await send("Page.navigate", {
      url: `${server.resolvedUrls.local[0]}__c696${query}#/p/p-1/${hash}`,
    });
    await until(ready);
    await evaluate("document.fonts.ready.then(() => true)");
    await run((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await settle();
  };
  const click = (selector, text) =>
    run(
      (selector, text) => {
        const el = [...document.querySelectorAll(selector)].find(
          (e) => e.textContent.trim() === text,
        );
        if (!el) throw new Error(`No ${selector} “${text}”`);
        el.click();
      },
      selector,
      text,
    );
  // React tracks the value setter; type through the native one.
  const type = (selector, value) =>
    run(
      (selector, value) => {
        const field = document.querySelector(selector);
        const set = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        ).set;
        set.call(field, value);
        field.dispatchEvent(new Event("input", { bubbles: true }));
      },
      selector,
      value,
    );
  const pick = (count) =>
    run((count) => {
      const boxes = [
        ...document.querySelectorAll(
          "[role=dialog] [role=checkbox], form [role=checkbox]",
        ),
      ];
      for (const i of [0, 2, 6].slice(0, count)) boxes[i]?.click();
    }, count);
  const measure = () =>
    run(() => {
      const rect = (e) => {
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return {
          x: Math.round(r.x),
          y: Math.round(r.y),
          width: Math.round(r.width),
          height: Math.round(r.height),
          bottom: Math.round(r.bottom),
        };
      };
      const font = (e) => {
        if (!e) return null;
        const s = getComputedStyle(e);
        return `${s.fontSize}/${s.lineHeight} ${s.fontWeight}`;
      };
      const dialog = document.querySelector(
        "[role=dialog]:has(form[aria-label='标记完成'])",
      );
      const form =
        dialog?.querySelector("form") ??
        document.querySelector("form[aria-label='标记完成']");
      const buttons = form
        ? [...form.querySelectorAll("button[data-ui=button]")]
            .filter((e) => e.getClientRects().length)
            .map((e) => ({
              text: e.textContent.trim(),
              variant: [...e.classList].find((c) =>
                /^ui-button-(?!label)/.test(c),
              ),
              ...rect(e),
              font: font(e),
              disabled: e.disabled,
              ariaDisabled: e.getAttribute("aria-disabled"),
              inViewport:
                e.getBoundingClientRect().top >= 0 &&
                e.getBoundingClientRect().bottom <= innerHeight,
            }))
        : [];
      const list = form?.querySelector("ul[aria-label='本卡附件']");
      const rows = list ? [...list.querySelectorAll("label")] : [];
      const body = dialog?.querySelector(".ui-dialog-body");
      const textarea = form?.querySelector("textarea");
      const head = form?.querySelector("fieldset > div");
      const notice = [...document.querySelectorAll(".request-feedback")]
        .map((e) => e.textContent.trim())
        .filter(Boolean);
      const panel = document.querySelector("section[aria-label='下一步']");
      return {
        viewport: { width: innerWidth, height: innerHeight },
        dialog: dialog && {
          ...rect(dialog),
          radius: getComputedStyle(dialog).borderRadius,
          title: dialog.querySelector("h2")?.textContent,
          titleFont: font(dialog.querySelector("h2")),
          header: rect(dialog.querySelector(".ui-dialog-header")),
          body: body && {
            ...rect(body),
            scrollHeight: body.scrollHeight,
            clientHeight: body.clientHeight,
          },
          footer: rect(dialog.querySelector(".ui-dialog-footer")),
          scrollWidth: dialog.scrollWidth,
          clientWidth: dialog.clientWidth,
        },
        form: !dialog && form ? rect(form) : undefined,
        textarea: textarea && {
          ...rect(textarea),
          rows: textarea.rows,
          readOnly: textarea.readOnly,
          value: textarea.value,
          focused: document.activeElement === textarea,
        },
        evidenceHead: head && {
          ...rect(head),
          text: head.textContent,
          labelFont: font(head.firstElementChild),
        },
        list: list && {
          ...rect(list),
          scrollHeight: list.scrollHeight,
          clientHeight: list.clientHeight,
          rows: rows.length,
          rowHeights: [
            ...new Set(
              rows.map((r) => Math.round(r.getBoundingClientRect().height)),
            ),
          ],
          rowFont: font(rows[0]),
          selectedRows: rows.filter((r) => r.hasAttribute("data-selected"))
            .length,
          selectedBackground: rows.find((r) => r.hasAttribute("data-selected"))
            ? getComputedStyle(
                rows.find((r) => r.hasAttribute("data-selected")),
              ).backgroundColor
            : null,
        },
        empty: form?.querySelector("fieldset p")?.textContent ?? null,
        buttons,
        feedback: notice,
        alert: dialog?.querySelector("[role=alert]")?.textContent ?? null,
        panelTitle: panel?.querySelector("h2")?.textContent ?? null,
        focused:
          document.activeElement?.textContent?.trim().slice(0, 20) ?? null,
        overflow: {
          page: document.documentElement.scrollWidth > innerWidth,
          pageScrollWidth: document.documentElement.scrollWidth,
        },
      };
    });
  const record = async (name, full = false) => {
    report.shots.push({ name, ...(await measure()) });
    await shot(name, full);
  };
  const openDialog = async (id, theme, query = "") => {
    await open(
      `cards/${id}`,
      "!!document.querySelector('article.card-page .card-main')",
      theme,
      query,
    );
    await click("section[aria-label='下一步'] button", "标记完成");
    await until(
      before
        ? "!!document.querySelector('form[aria-label=\"标记完成\"] textarea')"
        : "!!document.querySelector('[role=dialog] form textarea')",
    );
    await settle();
  };
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"]) {
      const height = width === 390 ? 844 : 1000;
      const tag = `${width}-${theme}`;
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await send("Emulation.setEmulatedMedia", {
        features: [
          { name: "prefers-color-scheme", value: theme },
          { name: "prefers-reduced-motion", value: "reduce" },
        ],
      });
      await open(
        "cards?view=list",
        "!!document.querySelector('.card-table, .card-records')",
        theme,
      );
      await shot(`list-${tag}.png`);
      if (before) {
        await openDialog("C-48", theme);
        await type("form[aria-label='标记完成'] textarea", RESULT);
        await pick(3);
        await settle();
        await record(`before-markdone-14-${tag}.png`);
        await record(`before-markdone-14-${tag}-full.png`, true);
        continue;
      }
      // 14 files: three chosen, as the design.
      await openDialog("C-48", theme);
      const opened = await measure();
      report.shots.push({ name: `open-focus-${tag}`, ...opened });
      await type("[role=dialog] textarea", RESULT);
      await pick(3);
      await settle();
      await record(`dialog-14-${tag}.png`);
      await run(() => {
        const list = document.querySelector("ul[aria-label='本卡附件']");
        list.scrollTop = list.scrollHeight;
      });
      await settle();
      await record(`dialog-14-scrolled-${tag}.png`);
      // Closing with a draft asks first.
      await click("[role=dialog] .ui-dialog-footer button", "取消");
      await until("document.querySelectorAll('[role=dialog]').length === 2");
      await settle();
      await record(`dialog-discard-${tag}.png`);
      // No files.
      await openDialog("C-49", theme);
      await record(`dialog-0-${tag}.png`);
      // Submitting, failed, done.
      for (const state of ["pending", "fail", "ok"]) {
        await openDialog("C-48", theme, `?done=${state}`);
        await type("[role=dialog] textarea", RESULT);
        await pick(3);
        await click("[role=dialog] .ui-dialog-footer button", "确认完成");
        if (state === "pending")
          await until(
            "[...document.querySelectorAll('[role=dialog] button')].some((b) => b.textContent === '正在提交…')",
          );
        if (state === "fail")
          await until("!!document.querySelector('[role=dialog] [role=alert]')");
        if (state === "ok")
          await until(
            "!document.querySelector('[role=dialog]') && document.querySelector(\"section[aria-label='下一步'] h2\")?.textContent === '已完成'",
          );
        await settle();
        await record(
          `dialog-${state === "pending" ? "submitting" : state === "fail" ? "failed" : "done"}-${tag}.png`,
        );
      }
    }
} finally {
  await writeFile(
    resolve(output, "measurements.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  ).catch(() => {});
  await browser?.close();
  await server.close();
}
