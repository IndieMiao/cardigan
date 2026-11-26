// C-697: the merge confirmation as the card detail's “下一步” panel, in the
// four acceptance states (C-702 ready, C-706 failed check, C-707 PM confirms,
// C-708 held), page and drawer, 1440×1000 and 390×844, light and dark, plus
// the card list page (the baseline page) at the same viewport and theme.
// After the change it also opens 合并详情, the ⋯ menu, the 暂不合并, 退回修改
// and 其他 dialogs, a failed 退回修改 and the PM takeover. Synthetic data from
// c697-fixture.tsx only; same browser flags as the page-skeleton check.
//
// Each shot records: the panel box, border and title font, every panel
// button (text, variant, box, font), the number of button rows, an open
// dialog's box and footer buttons (in the viewport or not), and horizontal
// overflow of the page and of the drawer body.
//
// CHROMIUM_PATH=<chrome> node apps/web/test-support/c697-capture.mjs <new dir> [--before]
// CHROMIUM_PATH=<chrome> node apps/web/test-support/c697-capture.mjs --compose <before dir> <after dir> <new dir>
// CHROMIUM_PATH=<chrome> node apps/web/test-support/c697-capture.mjs <new dir> --merged
//   only the scenes from merging C-701 and C-760: the main-action dock
//   repeating 确认合并 (page and drawer), and 仍要合并 past an open hold.
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

const flags = [
  "--run-all-compositor-stages-before-draw",
  "--disable-new-content-rendering-timeout",
  "--disable-threaded-animation",
  "--disable-threaded-scrolling",
  "--disable-partial-raster",
  "--disable-gpu",
  "--disable-skia-runtime-opts",
  "--force-color-profile=srgb",
  "--num-raster-threads=1",
];
const states = ["C-702", "C-706", "C-707", "C-708"];

if (process.argv[2] === "--compose") await compose(...process.argv.slice(3));
else
  await capture(
    process.argv[2],
    process.argv.includes("--before"),
    process.argv.includes("--merged"),
  );

async function capture(outArg, before, merged = false) {
  assert(outArg, "Pass a new output directory");
  const root = fileURLToPath(new URL("../", import.meta.url));
  const output = resolve(outArg);
  const server = await createServer({
    root,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "c697-fixture",
        enforce: "pre",
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/__c697")) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await server.transformIndexHtml(
                "/__c697",
                `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/c697-fixture.tsx"></script></body></html>`,
              ),
            );
          });
        },
      },
    ],
  });
  let browser;
  const report = { before, shots: [] };
  try {
    await mkdir(output);
    await server.listen();
    browser = await chromium({ args: flags });
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
    const shot = async (name) => {
      await settle();
      await delay(250);
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      await writeFile(resolve(output, name), Buffer.from(data, "base64"));
      console.log(`Captured ${name}`);
    };
    const open = async (hash, ready, theme, query = "") => {
      await send("Page.navigate", { url: "about:blank" });
      await until("location.href === 'about:blank'");
      await send("Page.navigate", {
        url: `${server.resolvedUrls.local[0]}__c697${query}#/p/p-1/${hash}`,
      });
      await until(ready);
      await evaluate("document.fonts.ready.then(() => true)");
      await run((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      await settle();
    };
    /** A real pointer click at the centre of the first match. */
    const click = async (selector, text) => {
      const point = await run(
        (selector, text) => {
          const e = [...document.querySelectorAll(selector)].find(
            (e) =>
              e.getClientRects().length &&
              (!text ||
                (e.getAttribute("aria-label") ?? e.textContent.trim()) ===
                  text),
          );
          if (!e) return null;
          e.scrollIntoView({ block: "nearest" });
          const r = e.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        },
        selector,
        text,
      );
      assert(point, `${selector} ${text ?? ""}`);
      for (const type of ["mousePressed", "mouseReleased"])
        await send("Input.dispatchMouseEvent", {
          type,
          ...point,
          button: "left",
          clickCount: 1,
        });
      await settle();
    };
    const type = async (text) => {
      await send("Input.insertText", { text });
      await settle();
    };
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
          };
        };
        const font = (e) => {
          if (!e) return null;
          const s = getComputedStyle(e);
          return `${s.fontSize}/${s.lineHeight} ${s.fontWeight}`;
        };
        const button = (e) => {
          const r = e.getBoundingClientRect();
          return {
            text: e.getAttribute("aria-label") ?? e.textContent.trim(),
            variant: [...e.classList].find(
              (c) => c.startsWith("ui-button-") && c !== "ui-button-label",
            ),
            ...rect(e),
            font: font(e),
            inViewport: r.top >= 0 && r.bottom <= innerHeight,
          };
        };
        const article = document.querySelector("article.card-page");
        const panel = article?.querySelector("section[aria-label='下一步']");
        const title = panel?.querySelector("h2");
        const group =
          panel?.querySelector("[role=group]") ??
          panel?.lastElementChild ??
          null;
        const buttons = group
          ? [...group.querySelectorAll("[data-ui=button], button")]
              .filter((e) => e.getClientRects().length)
              .map(button)
          : [];
        let rows = 0;
        let last = Number.NEGATIVE_INFINITY;
        for (const top of buttons.map((b) => b.y).sort((a, b) => a - b)) {
          if (top - last >= 8) rows++;
          last = top;
        }
        const facts = panel?.querySelector("dl");
        const dialog = document.querySelector(
          "[role=dialog][data-ui=dialog], [role=alertdialog][data-ui=dialog]",
        );
        const footer = dialog?.querySelector(".ui-dialog-footer");
        const menu = document.querySelector("[role=menu]");
        const body = document.querySelector(".drawer-body");
        const dock = document.querySelector("section[aria-label='主操作']");
        return {
          dock: dock && {
            ...rect(dock),
            title: dock.firstElementChild?.textContent,
            titleFont: font(dock.firstElementChild),
            buttons: [...dock.querySelectorAll("[data-ui=button]")].map(button),
          },
          viewport: { width: innerWidth, height: innerHeight },
          panel: panel && {
            ...rect(panel),
            borderColor: getComputedStyle(panel).borderTopColor,
            shadow: getComputedStyle(panel).boxShadow,
            padding: getComputedStyle(panel).padding,
            title: title?.textContent,
            titleFont: font(title),
            factsFont: font(facts),
            factsLabelWidth: rect(facts?.querySelector("dt"))?.width ?? null,
          },
          buttons,
          buttonRows: rows,
          dialog: dialog && {
            ...rect(dialog),
            title: dialog.querySelector("h2")?.textContent,
            footer: footer
              ? [...footer.querySelectorAll("button")].map(button)
              : null,
          },
          menu: menu && {
            ...rect(menu),
            items: [...menu.querySelectorAll("[role=menuitem]")].map((e) =>
              e.textContent.trim(),
            ),
          },
          overflow: {
            page: document.documentElement.scrollWidth > innerWidth,
            pageScrollWidth: document.documentElement.scrollWidth,
            drawer: body ? body.scrollWidth > body.clientWidth : null,
            drawerScrollWidth: body?.scrollWidth ?? null,
            drawerClientWidth: body?.clientWidth ?? null,
          },
        };
      });
    const record = async (name, steps) => {
      report.shots.push({ name, steps, ...(await measure()) });
      await shot(name);
    };
    const pageReady =
      "!!document.querySelector('article.card-page .card-main')";
    for (const width of [1440, 390])
      for (const theme of ["light", "dark"]) {
        const height = width === 390 ? 844 : 1000;
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
        const suffix = `${width}-${theme}.png`;
        await open(
          "cards?view=list",
          "!!document.querySelector('.card-table, .card-records')",
          theme,
        );
        await shot(`list-${suffix}`);
        if (merged) {
          const dockReady =
            "!!document.querySelector('section[aria-label=主操作]')";
          // Page: the window scrolls; drawer: its body does.
          // As in c701-capture: the timeline tab, then 700px down.
          const scrollAway = async () => {
            await run(() =>
              document
                .querySelector(
                  "article.card-page [role=tab][id$='-timeline-tab']",
                )
                ?.click(),
            );
            await until(
              "document.querySelectorAll('article.card-page .timeline-entry').length >= 40",
            );
            await run(() => {
              const article = document.querySelector("article.card-page");
              let node = article?.parentElement;
              while (node && node !== document.body) {
                const style = getComputedStyle(node);
                if (
                  /(auto|scroll)/.test(style.overflowY) &&
                  node.scrollHeight > node.clientHeight
                )
                  break;
                node = node.parentElement;
              }
              (node && node !== document.body
                ? node
                : document.scrollingElement).scrollTop += 700;
            });
            await until(dockReady);
          };
          await open("cards/C-702", pageReady, theme, "?long");
          await scrollAway();
          await record(`dock-page-C-702-${suffix}`, [
            "?long",
            "时间线",
            "scroll 700",
          ]);
          await open(
            "cards?view=list&card=C-702",
            "!!document.querySelector('.drawer-body article.card-page .card-main')",
            theme,
            "?long",
          );
          await scrollAway();
          await record(`dock-drawer-C-702-${suffix}`, [
            "?long",
            "时间线",
            "scroll 700",
          ]);
          // Before a PM takeover the bar repeats 接手处理.
          await open("cards/C-707", pageReady, theme, "?long");
          await scrollAway();
          await record(`dock-page-C-707-${suffix}`, [
            "?long",
            "时间线",
            "scroll 700",
          ]);
          await open("cards/C-709", pageReady, theme);
          await click(
            "section[aria-label='下一步'] [data-ui=button]",
            "更多合并操作",
          );
          await click("[role=menuitem]", "仍要合并…");
          await until(
            "!!document.querySelector('[role=alertdialog] textarea')",
          );
          await click("[role=alertdialog] textarea");
          await type("账号合并后再配");
          await click("[role=alertdialog] [data-ui=checkbox]");
          await record(`dialog-override-hold-C-709-${suffix}`, [
            "更多合并操作",
            "menu:仍要合并…",
            "type 账号合并后再配",
            "tick 一并改为合并后跟进",
          ]);
          continue;
        }
        for (const id of states)
          for (const mode of ["page", "drawer"]) {
            await open(
              mode === "page" ? `cards/${id}` : `cards?view=list&card=${id}`,
              mode === "page"
                ? pageReady
                : "!!document.querySelector('.drawer-body article.card-page .card-main')",
              theme,
            );
            await record(`${mode}-${id}-${suffix}`, ["open"]);
          }
        if (before) continue;
        const panelButton = "section[aria-label='下一步'] [data-ui=button]";
        const scenes = [
          ["details", ["合并详情"]],
          ["menu", ["更多合并操作"]],
          ["dialog-hold", ["暂不合并"]],
          ["dialog-return", ["退回修改"]],
          ["dialog-other", ["更多合并操作", "menu:其他（自己填写）…"]],
        ];
        for (const [scene, steps] of scenes) {
          await open("cards/C-702", pageReady, theme);
          for (const step of steps)
            if (step.startsWith("menu:"))
              await click("[role=menuitem]", step.slice(5));
            else await click(panelButton, step);
          await record(`${scene}-C-702-${suffix}`, steps);
        }
        // A write that fails keeps the dialog, the words and the reason.
        await open("cards/C-702", pageReady, theme, "?fail=1");
        await click(panelButton, "退回修改");
        await type("请补暗色截图");
        await click("[role=dialog] button[type=submit]");
        await until("!!document.querySelector('[role=dialog] [role=alert]')");
        await record(`dialog-return-failed-C-702-${suffix}`, [
          "退回修改",
          "type 请补暗色截图",
          "确认退回修改 (fails)",
        ]);
        // Taking over a PM's confirmation shows the controls with emphasis.
        await open("cards/C-707", pageReady, theme);
        await click(panelButton, "接手处理");
        await click("[role=dialog] button", "确认接手");
        await until("!document.querySelector('.pm-merge-takeover-dialog')");
        await record(`takeover-C-707-${suffix}`, ["接手处理", "确认接手"]);
      }
  } finally {
    await writeFile(
      resolve(output, "measurements.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    ).catch(() => {});
    await browser?.close();
    await server.close();
  }
}

/**
 * Side-by-side images at the same width and theme: before | after for every
 * state shot, and the card list page (baseline) | after for every after shot.
 */
async function compose(beforeArg, afterArg, outArg) {
  assert(beforeArg && afterArg && outArg, "Pass before, after and new dirs");
  const [beforeDir, afterDir, output] = [beforeArg, afterArg, outArg].map((p) =>
    resolve(p),
  );
  await mkdir(output);
  const browser = await chromium({ args: flags });
  try {
    const { send } = browser;
    const pair = async (left, right, labels, name) => {
      const images = await Promise.all(
        [left, right].map(async (p) => (await readFile(p)).toString("base64")),
      );
      const size = await Promise.all(
        images.map(async (data) => {
          const buffer = Buffer.from(data, "base64");
          return {
            width: buffer.readUInt32BE(16),
            height: buffer.readUInt32BE(20),
          };
        }),
      );
      const width = size[0].width + size[1].width + 24;
      const height = Math.max(size[0].height, size[1].height) + 28;
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      const { frameTree } = await send("Page.getFrameTree");
      await send("Page.setDocumentContent", {
        frameId: frameTree.frame.id,
        html: `<body style="margin:0;background:#888;font:13px sans-serif;display:flex;gap:24px">${images
          .map(
            (data, i) =>
              `<figure style="margin:0"><figcaption style="height:28px;line-height:28px;color:#fff">${labels[i]}</figcaption><img style="display:block" src="data:image/png;base64,${data}"></figure>`,
          )
          .join("")}</body>`,
      });
      await delay(300);
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      await writeFile(resolve(output, name), Buffer.from(data, "base64"));
      console.log(`Composed ${name}`);
    };
    const after = (await readdir(afterDir)).filter((f) => f.endsWith(".png"));
    const before = new Set(await readdir(beforeDir));
    for (const file of after) {
      if (file.startsWith("list-")) continue;
      const suffix = file.match(/(\d+-(?:light|dark)\.png)$/)?.[1];
      if (before.has(file))
        await pair(
          resolve(beforeDir, file),
          resolve(afterDir, file),
          ["改前", "改后"],
          `before-after-${file}`,
        );
      if (suffix && /^(page|dock|dialog-override)-/.test(file))
        await pair(
          resolve(afterDir, `list-${suffix}`),
          resolve(afterDir, file),
          ["基准：卡片页", "改后"],
          `baseline-${file}`,
        );
    }
  } finally {
    await browser.close();
  }
}
