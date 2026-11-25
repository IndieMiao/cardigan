// C-713: the project's 发版说明 (release notes) page on synthetic data
// (c713-fixture.tsx: 4 published versions, one without a note; 7 cards).
//
// 1440 and 390 × light/dark, same browser flags as the page-skeleton check:
// - notes-*: the list; cards-*: the cards list at the same width and theme;
//   compare-*: both side by side (发版说明 left, 卡片 right);
// - empty-*: no publication; editor-*: writing a draft; saved-*: after a
//   save (the list shows the server's record); editor-error-*: a failed save
//   kept in the dialog with the draft; discard-*: leaving with unsaved edits.
// c713-measurements.json records type, sizes, spacing, alignment and
// horizontal overflow; the script asserts the facts the card relies on.
//
// CHROMIUM_PATH=<chrome> node apps/web/test-support/c713-capture.mjs <new dir>
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const outArg = process.argv[2];
assert(outArg, "Pass a new output directory");
const output = resolve(outArg);
const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "c713-fixture",
      enforce: "pre",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__c713")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              "/__c713",
              `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/c713-fixture.tsx"></script></body></html>`,
            ),
          );
        });
      },
    },
  ],
});
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
let browser;
const report = [];
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
  const version = await send("Browser.getVersion");
  const base = server.resolvedUrls.local[0];
  await send("Browser.grantPermissions", {
    origin: new URL(base).origin,
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  });
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
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
  const capture = async () => {
    await delay(250);
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    return data;
  };
  const save = async (name, data) => {
    await writeFile(resolve(output, name), Buffer.from(data, "base64"));
    console.log(`Captured ${name}`);
  };
  const shot = async (name) => {
    const data = await capture();
    await save(name, data);
    return data;
  };
  const key = async (key, code, windowsVirtualKeyCode) => {
    for (const type of ["keyDown", "keyUp"])
      await send("Input.dispatchKeyEvent", {
        type,
        key,
        code,
        windowsVirtualKeyCode,
      });
  };
  const open = async (path, ready, query = "") => {
    await send("Page.navigate", { url: "about:blank" });
    await until("location.href === 'about:blank'");
    await send("Page.navigate", {
      url: `${base}__c713${query}#/p/p-1/${path}`,
    });
    await until(ready);
    await evaluate("document.fonts.ready.then(() => true)");
  };
  const theme = (value) =>
    run((value) => {
      document.documentElement.dataset.theme = value;
    }, value);
  const click = (selector, text) =>
    run(
      (selector, text) => {
        const target = [...document.querySelectorAll(selector)].find(
          (e) => text == null || e.textContent.trim() === text,
        );
        if (!target) throw new Error(`Missing ${selector} ${text}`);
        target.click();
      },
      selector,
      text,
    );
  const measurePage = () =>
    run(() => {
      const rect = (e) => {
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      };
      const type = (e) => {
        if (!e) return null;
        const s = getComputedStyle(e);
        return `${s.fontSize}/${s.lineHeight} ${s.fontWeight}`;
      };
      const main = document.querySelector(".ui-workspace");
      const title = document.querySelector(".page-title h1");
      const table = document.querySelector(".card-table");
      const th = table?.querySelector("th");
      const td = table?.querySelector("tbody td");
      const buttons = [
        ...document.querySelectorAll(
          ".ui-workspace tbody td[data-record=aside] button",
        ),
      ];
      const expand = document.querySelector(
        ".ui-workspace tbody .long-content button",
      );
      const nav = [...document.querySelectorAll(".sidebar .nav-item")].find(
        (a) => a.textContent.trim() === "发版说明",
      );
      const ms = main ? getComputedStyle(main) : null;
      return {
        viewport: { width: innerWidth, height: innerHeight },
        scrollWidth: document.documentElement.scrollWidth,
        overflow: document.documentElement.scrollWidth > innerWidth,
        workspace: {
          ...rect(main),
          padding: ms ? `${ms.paddingTop} ${ms.paddingRight}` : null,
        },
        title: { ...rect(title), type: type(title) },
        table: table
          ? {
              ...rect(table),
              right: table.getBoundingClientRect().right,
              header: { ...rect(th), type: type(th) },
              cell: {
                type: type(td),
                padding: td ? getComputedStyle(td).padding : null,
              },
              rows: table.querySelectorAll("tbody tr").length,
              text: [...table.querySelectorAll("tbody tr")].map((tr) =>
                [...tr.cells]
                  .map((c) => c.textContent.replace(/\s+/g, " ").trim())
                  .join(" | ")
                  .slice(0, 80),
              ),
            }
          : null,
        rowButtons: buttons.map((b) => ({
          name: b.getAttribute("aria-label") ?? b.textContent,
          ...rect(b),
          type: type(b),
        })),
        nav: nav
          ? {
              ...rect(nav),
              current: nav.getAttribute("aria-current"),
              type: type(nav),
              icon: rect(nav.querySelector("svg")),
            }
          : null,
        expand: expand
          ? {
              text: expand.textContent,
              ...rect(expand),
              type: type(expand),
            }
          : null,
        empty: document.querySelector(".ui-workspace .empty")?.textContent,
      };
    });
  const measureDialog = () =>
    run(() => {
      const rect = (e) => {
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      };
      const panels = [...document.querySelectorAll("[data-ui=dialog]")];
      return panels.map((panel) => {
        const body = panel.querySelector(".ui-dialog-body");
        const field = panel.querySelector("textarea");
        const title = panel.querySelector(".ui-dialog-title");
        return {
          title: title?.textContent,
          titleType: title
            ? `${getComputedStyle(title).fontSize}/${getComputedStyle(title).lineHeight}`
            : null,
          panel: rect(panel),
          body: rect(body),
          field: field
            ? {
                ...rect(field),
                value: field.value,
                type: `${getComputedStyle(field).fontSize}/${getComputedStyle(field).lineHeight}`,
              }
            : null,
          footer: [...panel.querySelectorAll(".ui-dialog-footer button")].map(
            (b) => ({ text: b.textContent, ...rect(b), disabled: b.disabled }),
          ),
          alert: panel.querySelector("[role=alert]")?.textContent ?? null,
          status: panel.querySelector("[role=status]")?.textContent ?? null,
          active: document.activeElement?.tagName,
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
    });
  // Side-by-side image drawn in the page itself (no image dependency).
  const compose = async (left, right, width) => {
    await send("Page.navigate", { url: "about:blank" });
    await until("location.href === 'about:blank'");
    const data = await run(
      async (left, right, width) => {
        const load = (src) =>
          new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = reject;
            image.src = `data:image/png;base64,${src}`;
          });
        const [a, b] = await Promise.all([load(left), load(right)]);
        const canvas = document.createElement("canvas");
        canvas.width = width * 2 + 16;
        canvas.height = Math.max(a.height, b.height);
        const context = canvas.getContext("2d");
        context.fillStyle = "#808080";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(a, 0, 0);
        context.drawImage(b, width + 16, 0);
        return canvas.toDataURL("image/png").slice(22);
      },
      left,
      right,
      width,
    );
    return data;
  };
  const ready = {
    notes:
      "!!document.querySelector('[data-release-note]') && !!document.querySelector('.capacity-wide')",
    empty: "!!document.querySelector('.ui-workspace .empty')",
    cards:
      "!!document.querySelector('.capacity-wide') && !!document.querySelector('.card-table')",
  };
  for (const width of [1440, 390])
    for (const scheme of ["light", "dark"]) {
      const suffix = `${width}-${scheme}`;
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await send("Emulation.setEmulatedMedia", {
        features: [
          { name: "prefers-color-scheme", value: scheme },
          { name: "prefers-reduced-motion", value: "reduce" },
        ],
      });
      const result = { width, theme: scheme };

      await open("release-notes", ready.notes);
      await theme(scheme);
      await settle();
      result.notes = await measurePage();
      const notes = await shot(`notes-${suffix}.png`);

      await open("cards?view=list", ready.cards);
      await theme(scheme);
      await settle();
      result.cards = await measurePage();
      const cards = await shot(`cards-${suffix}.png`);
      await save(`compare-${suffix}.png`, await compose(notes, cards, width));

      await open("release-notes", ready.empty, "?mode=empty");
      await theme(scheme);
      await settle();
      result.empty = await measurePage();
      await shot(`empty-${suffix}.png`);

      // Copy: the clipboard gets the plain body text.
      await open("release-notes", ready.notes);
      await theme(scheme);
      await click("button[aria-label='复制 0.5.1 的发版说明']");
      await until(
        "[...document.querySelectorAll('[role=status]')].some(e => e.textContent.includes('已复制'))",
      );
      result.clipboard = await run(() => navigator.clipboard.readText());

      // Write a note for the unwritten version and save it.
      await click("button[aria-label='填写 0.6.0 的发版说明']");
      await until("document.activeElement?.tagName === 'TEXTAREA'");
      await send("Input.insertText", {
        text: "- 新增每日挑战\n- 修复排行榜偶发不刷新",
      });
      await settle();
      result.editor = await measureDialog();
      await shot(`editor-${suffix}.png`);
      await click(".ui-dialog-footer button", "保存");
      await until("!document.querySelector('[data-ui=dialog]')");
      await until(
        "document.querySelector('[data-release-note]').textContent.includes('新增每日挑战')",
      );
      await settle();
      result.saved = await measurePage();
      await shot(`saved-${suffix}.png`);

      // A failed save stays in the dialog with the draft.
      await open("release-notes", ready.notes, "?mode=fail");
      await theme(scheme);
      await click("button[aria-label='编辑 0.5.1 的发版说明']");
      await until("document.activeElement?.tagName === 'TEXTAREA'");
      await send("Input.insertText", { text: "\n- 新增雪原 BOSS" });
      await click(".ui-dialog-footer button", "保存");
      await until("!!document.querySelector('[data-ui=dialog] [role=alert]')");
      await settle();
      result.error = await measureDialog();
      await shot(`editor-error-${suffix}.png`);

      // Leaving with unsaved edits asks first (Escape).
      await key("Escape", "Escape", 27);
      await until(
        "[...document.querySelectorAll('.ui-dialog-title')].some(e => e.textContent === '放弃未应用的修改？')",
      );
      await settle();
      result.discard = await measureDialog();
      await shot(`discard-${suffix}.png`);
      // Discarding closes both dialogs and drops the browser's leave prompt.
      await click(".ui-dialog button", "放弃修改");
      await until("!document.querySelector('[data-ui=dialog]')");
      result.afterDiscard = await measurePage();
      report.push(result);

      // Facts the card relies on.
      for (const page of [
        result.notes,
        result.cards,
        result.empty,
        result.saved,
      ])
        assert(!page.overflow, `overflow ${suffix}`);
      if (width === 1440) assert.equal(result.notes.nav?.current, "page");
      assert.deepEqual(
        result.notes.table.text.map((t) => t.split(" | ")[0]),
        ["0.6.0", "0.5.1", "0.5.0", "0.4.2"],
      );
      assert(result.notes.table.text[0].includes("未填写"));
      assert.equal(result.empty.empty, "没有发布的版本");
      assert.equal(
        result.clipboard,
        "- 新增关卡“雪原”\n- 修复存档在低电量时丢失的问题\n- 优化开场加载速度",
      );
      assert.deepEqual(
        { x: result.notes.title.x, y: result.notes.title.y },
        { x: result.cards.title.x, y: result.cards.title.y },
      );
      assert.equal(result.notes.title.type, result.cards.title.type);
      for (const b of result.notes.rowButtons) assert.equal(b.height, 28);
      for (const b of result.editor[0].footer) assert.equal(b.height, 32);
      assert(result.error[0].alert.includes("第 4 版"));
      assert(result.error[0].field.value.endsWith("新增雪原 BOSS"));
      assert.equal(result.discard.length, 2);
      assert(!result.afterDiscard.table.text[1].includes("新增雪原 BOSS"));
    }
  assert.deepEqual(browser.errors, []);
  await writeFile(
    resolve(output, "c713-measurements.json"),
    `${JSON.stringify(
      {
        sha: git("rev-parse", "HEAD"),
        tree: git("rev-parse", "HEAD^{tree}"),
        dirty: !!git("status", "--porcelain"),
        browser: version.product,
        dpr: 1,
        height: 1000,
        data: "c713-fixture.tsx: 4 published versions (1 without a note), 7 cards, clock 2026-01-01T00:00:00Z",
        cases: report,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await browser?.close();
  await server.close();
}
