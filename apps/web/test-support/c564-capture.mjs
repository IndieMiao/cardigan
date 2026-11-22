// C-564: settings "模型" → edit a launch profile — the model field as a
// searchable list of the chosen Provider's models (catalog + its own
// listing, mocked), with metadata, filtering, picking, an unverified typed
// value, loading, a failed list, and permission modes chosen per harness
// (meaning shown, an old value kept, none for Codex), the confirmation diff
// and the discard question. 1440/390 × light/dark, plus the card list at the
// same width/theme for side-by-side comparison.
// CHROMIUM_PATH=<chrome-headless-shell> node apps/web/test-support/c564-capture.mjs <new output dir>
// C564_BASELINE_REF=<git ref> renders that ref's page files (before: the card
// list, the models list and the profile edit form as they were).
// C564_BEFORE=<before output dir> counts differing pixels per scene name.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
assert(process.argv[2], "Pass a new output directory");
const output = resolve(process.argv[2]);
const before = process.env.C564_BEFORE && resolve(process.env.C564_BEFORE);
const baseline = process.env.C564_BASELINE_REF;
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
// Files this card changes; the baseline renders its own copies.
const historical = new Map(
  baseline
    ? [
        "api.ts",
        "testing/fixtures.ts",
        "testing/launch-settings-fixture.ts",
        "views/LaunchForms.tsx",
      ].map((path) => [
        resolve(root, "src", path),
        git("show", `${baseline}:apps/web/src/${path}`),
      ])
    : [],
);
const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "c564-fixture",
      enforce: "pre",
      load(id) {
        return historical.get(id.split("?")[0]);
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__c564")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              "/__c564",
              '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/c564-fixture.tsx"></script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
const cases = [];
const shots = {};
const pairs = [];
let browser;
try {
  await mkdir(output, { recursive: true });
  await server.listen();
  // Same software raster path as the page skeleton visual baseline.
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
  const run = (fn, ...args) =>
    evaluate(`(${fn.toString()})(...${JSON.stringify(args)})`);
  const until = async (expression, ms = 15000) => {
    const end = Date.now() + ms;
    while (!(await evaluate(expression))) {
      assert(Date.now() < end, `Timed out: ${expression}`);
      await delay(25);
    }
  };
  const settle = async () => {
    await evaluate("document.fonts.ready.then(() => true)");
    await run(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    );
    await delay(150);
  };
  const shot = async (name) => {
    await settle();
    const { data } = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    await writeFile(resolve(output, name), Buffer.from(data, "base64"));
    shots[name] = data;
    return data;
  };
  const open = async (path, ready, theme) => {
    await send("Page.navigate", { url: "about:blank" });
    await until("location.href === 'about:blank'");
    await send("Page.navigate", {
      url: `${server.resolvedUrls.local[0]}__c564${path}`,
    });
    await until(ready);
    await run((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await settle();
  };
  /** A real pointer click at the centre of the element `selector` finds. */
  const press = async (selector) => {
    const box = await run((selector) => {
      const dialogs = [...document.querySelectorAll("[role=dialog]")];
      const scope = dialogs.at(-1) ?? document;
      const e =
        scope.querySelector(selector) ?? document.querySelector(selector);
      if (!e) throw new Error(`Missing: ${selector}`);
      e.scrollIntoView({ block: "nearest" });
      const r = e.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, selector);
    for (const type of ["mousePressed", "mouseReleased"])
      await send("Input.dispatchMouseEvent", {
        type,
        x: box.x,
        y: box.y,
        button: "left",
        clickCount: 1,
        pointerType: "mouse",
      });
    await delay(150);
  };
  const KEYS = {
    ArrowDown: 40,
    ArrowUp: 38,
    Enter: 13,
    Escape: 27,
    Tab: 9,
  };
  const key = async (name) => {
    for (const type of ["rawKeyDown", "keyUp"])
      await send("Input.dispatchKeyEvent", {
        type,
        key: name,
        code: name,
        windowsVirtualKeyCode: KEYS[name],
      });
    await delay(100);
  };
  /** Replace the focused field's text, as typing it would. */
  const type = async (text) => {
    await run(() => document.activeElement?.select?.());
    await send("Input.insertText", { text });
    await delay(150);
  };
  /** Click the visible button with this exact text (in the top dialog when one is open). */
  const click = (text, scope = "auto") =>
    run(
      (text, scope) => {
        const dialogs = [...document.querySelectorAll("[role=dialog]")];
        const root = scope === "page" ? document : (dialogs.at(-1) ?? document);
        const b = [...root.querySelectorAll("button, a")].find(
          (x) =>
            (x.getAttribute("aria-label") ?? x.textContent.trim()) === text,
        );
        if (!b) throw new Error(`Missing button: ${text}`);
        b.click();
        requestAnimationFrame(() => {
          if (document.activeElement?.tagName === "BUTTON")
            document.activeElement.blur();
        });
      },
      text,
      scope,
    );
  const measurePage = () =>
    run(() => {
      const box = (e) => {
        if (!e) return null;
        const r = e.getBoundingClientRect(),
          s = getComputedStyle(e);
        return {
          text: e.textContent.trim().slice(0, 32),
          x: Math.round(r.left * 10) / 10,
          y: Math.round(r.top * 10) / 10,
          w: Math.round(r.width * 10) / 10,
          h: Math.round(r.height * 10) / 10,
          font: `${s.fontSize}/${s.lineHeight} ${s.fontWeight}`,
        };
      };
      const content = document.querySelector(
        "[data-settings-content]:not([hidden])",
      );
      return {
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth,
        pageTitle: box(document.querySelector(".ui-page-header h1")),
        content: box(content),
        panelTitle: box(content?.querySelector("h2")),
        tableHead: box(content?.querySelector("th")),
        tableCell: box(content?.querySelector("td")),
      };
    });
  const measureForm = () =>
    run(() => {
      const d = [...document.querySelectorAll("[role=dialog]")][0];
      const top = [...document.querySelectorAll("[role=dialog]")].at(-1);
      const font = (e) => {
        if (!e) return null;
        const s = getComputedStyle(e),
          b = e.getBoundingClientRect();
        return {
          text: (e.value ?? e.textContent ?? "").trim().slice(0, 48),
          font: `${s.fontSize}/${s.lineHeight} ${s.fontWeight}`,
          x: Math.round(b.left * 10) / 10,
          y: Math.round(b.top * 10) / 10,
          w: Math.round(b.width * 10) / 10,
          h: Math.round(b.height * 10) / 10,
          color: s.color,
          border: s.borderTopColor,
        };
      };
      const model = d.querySelector("input[role=combobox]");
      const hint = (e) =>
        e
          ? (e.getAttribute("aria-describedby") ?? "")
              .split(" ")
              .map((id) => document.getElementById(id))
              .filter(Boolean)
              .map(font)
          : [];
      const permission = [...d.querySelectorAll("label")]
        .find((l) => l.firstChild?.textContent?.trim() === "权限模式")
        ?.querySelector("[role=combobox]");
      const fields = [
        ...d.querySelectorAll("form input, form [role=combobox]"),
      ];
      const list = document.querySelector("[role=listbox]");
      const r = d.getBoundingClientRect();
      return {
        scrollWidth: document.documentElement.scrollWidth,
        drawer: { x: r.left, y: r.top, w: r.width, h: r.height },
        drawerScrollWidth: d.scrollWidth,
        drawerClientWidth: d.clientWidth,
        innerOverflow: [...d.querySelectorAll("*")]
          .filter((e) => e.getBoundingClientRect().right > r.right + 0.5)
          .slice(0, 5)
          .map(font),
        label: font(d.querySelector("form label")),
        controls: fields.map((e) => ({
          ...font(e),
          role: e.getAttribute("role"),
          disabled: e.disabled === true,
          invalid: e.getAttribute("aria-invalid"),
        })),
        model: model && {
          ...font(model),
          expanded: model.getAttribute("aria-expanded"),
          activedescendant: model.getAttribute("aria-activedescendant"),
          hint: hint(model),
          tag: font(
            document
              .getElementById(
                (model.getAttribute("aria-describedby") ?? "").split(" ")[0],
              )
              ?.querySelector("[data-ui=badge]"),
          ),
        },
        permission: permission && {
          ...font(permission),
          disabled: permission.disabled,
          hint: hint(permission),
        },
        list: list && {
          ...font(list.parentElement),
          label: list.getAttribute("aria-label"),
          options: [...list.querySelectorAll("[role=option]")].map((o) => ({
            ...font(o),
            selected: o.getAttribute("aria-selected"),
          })),
          status: [
            ...list.querySelectorAll(".ui-suggestion-status, [role=status]"),
          ].map(font),
        },
        diff: [...d.querySelectorAll("dd [data-op]")].map(font),
        question: top !== d ? font(top.querySelector("h2")) : null,
        actions: [
          ...top.querySelectorAll("form > div:last-of-type button"),
        ].map(font),
      };
    });
  const settingsReady =
    "!!document.querySelector('table[aria-label=启动配置] tbody tr')";
  const models = async (theme, params = "") => {
    await open(`/${params}#/p/p-1/settings?tab=models`, settingsReady, theme);
  };
  /** Open the profile's drawer, then its edit form, the model field in view. */
  const edit = async (profile) => {
    await run((name) => {
      const b = [
        ...document.querySelectorAll("table[aria-label=启动配置] td button"),
      ].find((x) => x.textContent.trim() === name);
      if (!b) throw new Error(`Missing row: ${name}`);
      b.click();
    }, profile);
    await until("!!document.querySelector('[role=dialog] h3')");
    await delay(300);
    await click("编辑");
    await until("!!document.querySelector('[role=dialog] form')");
    await run(() => {
      const d = document.querySelector("[role=dialog]");
      const target = [...d.querySelectorAll("form label")].find(
        (l) => l.firstChild?.textContent?.trim() === "Harness",
      );
      target?.scrollIntoView({ block: "start" });
    });
    await delay(200);
  };
  const MODEL = "[role=dialog] input[role=combobox]";
  const permissionSelector = "[data-c564-permission]";
  const markPermission = () =>
    run(() => {
      const d = document.querySelector("[role=dialog]");
      for (const e of d.querySelectorAll("[data-c564-permission]"))
        e.removeAttribute("data-c564-permission");
      [...d.querySelectorAll("label")]
        .find((l) => l.firstChild?.textContent?.trim() === "权限模式")
        ?.querySelector("[role=combobox]")
        ?.setAttribute("data-c564-permission", "");
    });
  const chooseOption = async (value) => {
    await run((value) => {
      const o = [
        ...document.querySelectorAll("[role=listbox] [role=option]"),
      ].find((x) => x.getAttribute("data-value") === value);
      if (!o) throw new Error(`Missing option ${value}`);
      o.scrollIntoView({ block: "nearest" });
      o.setAttribute("data-c564-option", "");
    }, value);
    await press("[data-c564-option]");
  };
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"]) {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await send("Emulation.setEmulatedMedia", {
        features: [
          { name: "prefers-color-scheme", value: theme },
          { name: "prefers-reduced-motion", value: "reduce" },
        ],
      });
      const results = {};
      const suffix = `${width}-${theme}.png`;
      const scene = async (name, measure) => {
        const data = await shot(`${name}-${suffix}`);
        results[name] = await measure();
        assert.equal(results[name].scrollWidth, width, `${name}: overflow`);
        return data;
      };
      // Reference: the card list.
      await open(
        "/#/p/p-1/cards?view=list",
        "!!document.querySelector('table, .card-list')",
        theme,
      );
      const cardsShot = await scene("cards", measurePage);
      await models(theme);
      await scene("models", measurePage);
      // The edit form as it opens (before: the alias select and text field).
      await edit("claude-opus");
      if (!baseline)
        await until(
          "!document.querySelector('[role=dialog]').textContent.includes('正在读取模型列表')",
        );
      const formShot = await scene("profile-edit", measureForm);
      pairs.push({
        name: "profile-edit",
        width,
        theme,
        left: cardsShot,
        right: formShot,
      });
      if (baseline) {
        cases.push({ width, theme, results });
        continue;
      }
      // Opened without typing: every choice, with metadata.
      await press(MODEL);
      await until("!!document.querySelector('[role=listbox] [role=option]')");
      await scene("model-open", measureForm);
      // Typing filters (case-insensitive); ↓ then Enter picks.
      await type("SON");
      await scene("model-filter", measureForm);
      await key("ArrowDown");
      await key("Enter");
      await until(
        "document.querySelector('[role=dialog] input[role=combobox]').value === 'claude-fixture-sonnet'",
      );
      await scene("model-picked", measureForm);
      // A typed ID outside every list stays possible, marked unverified.
      await press(MODEL);
      await type("my-private-model");
      await until(
        "document.querySelector('[role=dialog]').textContent.includes('未验证')",
      );
      await scene("model-unverified", measureForm);
      // Permission modes for Claude Code, each with its meaning.
      await key("Tab");
      await markPermission();
      await press(permissionSelector);
      await until("!!document.querySelector('[role=listbox] [role=option]')");
      await scene("permission-open", measureForm);
      await chooseOption("acceptEdits");
      await until(
        "!document.querySelector('[role=listbox]') && document.querySelector('[role=dialog]').textContent.includes('自动接受文件修改')",
      );
      await scene("permission-picked", measureForm);
      // The confirmation names the changed fields only.
      await click("预览修改");
      await until("!!document.querySelector('[role=dialog] dd [data-op]')");
      await scene("profile-review", measureForm);
      await click("返回修改");
      await until("!!document.querySelector('[role=dialog] form input')");
      // Leaving with unapplied edits asks first.
      await click("取消");
      await until("document.querySelectorAll('[role=dialog]').length === 2");
      await scene("profile-discard", measureForm);
      await click("放弃修改");
      await until("document.querySelectorAll('[role=dialog]').length <= 1");

      // Codex takes no permission mode.
      await models(theme);
      await edit("codex-sol");
      await until(
        "!document.querySelector('[role=dialog]').textContent.includes('正在读取模型列表')",
      );
      await scene("permission-codex", measureForm);

      // An old value outside the list stays, and says so.
      await models(theme, "?legacy=1");
      await edit("claude-opus");
      await markPermission();
      await run(() =>
        document
          .querySelector("[data-c564-permission]")
          ?.scrollIntoView({ block: "center" }),
      );
      await scene("permission-legacy", measureForm);

      // Loading, a failed request, and a host answer whose sources failed.
      await models(theme, "?models=hold");
      await edit("claude-opus");
      await press(MODEL);
      await until("!!document.querySelector('[role=listbox]')");
      await scene("model-loading", measureForm);
      await models(theme, "?models=fail");
      await edit("claude-opus");
      await until(
        "document.querySelector('[role=dialog]').textContent.includes('模型列表读取失败')",
      );
      await press(MODEL);
      await type("typed-by-hand");
      await scene("model-failed", measureForm);
      await click("取消");
      await until("document.querySelectorAll('[role=dialog]').length === 2");
      await click("放弃修改");
      await until("document.querySelectorAll('[role=dialog]').length <= 1");
      await models(theme, "?models=down");
      await edit("claude-opus");
      await until(
        "document.querySelector('[role=dialog]').textContent.includes('模型目录暂不可用')",
      );
      await scene("model-down", measureForm);
      cases.push({ width, theme, results });
    }
  // Side-by-side: reference (left) | profile edit (right), same width/theme.
  await send("Emulation.setDeviceMetricsOverride", {
    width: 2 * 1440 + 16,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.navigate", { url: "about:blank" });
  await until("location.href === 'about:blank'");
  const load = `const load = (src) => new Promise((r) => { const img = new Image(); img.onload = () => r(img); img.src = 'data:image/png;base64,' + src; });`;
  const compose = (a, b, width) =>
    evaluate(`(async () => { ${load}
      const [left, right] = await Promise.all([load(${JSON.stringify(a)}), load(${JSON.stringify(b)})]);
      const canvas = document.createElement('canvas');
      canvas.width = ${width} * 2 + 16;
      canvas.height = Math.max(left.height, right.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#888';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(left, 0, 0);
      ctx.drawImage(right, ${width} + 16, 0);
      return canvas.toDataURL('image/png').split(',')[1];
    })()`);
  for (const { name, width, theme, left, right } of pairs)
    await writeFile(
      resolve(output, `side-by-side-${name}-${width}-${theme}.png`),
      Buffer.from(await compose(left, right, width), "base64"),
    );
  const diffs = {};
  if (before)
    for (const name of Object.keys(shots)) {
      let old;
      try {
        old = (await readFile(resolve(before, name))).toString("base64");
      } catch {
        continue; // new scene, no before
      }
      diffs[name] = await evaluate(`(async () => { ${load}
        const [x, y] = await Promise.all([load(${JSON.stringify(old)}), load(${JSON.stringify(shots[name])})]);
        if (x.width !== y.width || x.height !== y.height) return 'size';
        const pixels = (img) => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0); return ctx.getImageData(0, 0, img.width, img.height).data; };
        const [p, q] = [pixels(x), pixels(y)];
        let n = 0;
        for (let i = 0; i < p.length; i += 4) if (p[i] !== q[i] || p[i + 1] !== q[i + 1] || p[i + 2] !== q[i + 2] || p[i + 3] !== q[i + 3]) n++;
        return n;
      })()`);
    }
  assert.deepEqual(browser.errors, []);
  const report = {
    stage: baseline ? "before" : "after",
    baseline: baseline ? git("rev-parse", baseline) : null,
    head: git("rev-parse", "HEAD"),
    tree: git("rev-parse", "HEAD^{tree}"),
    dirty: git("status", "--porcelain") !== "",
    browser: await send("Browser.getVersion"),
    viewport:
      "1440x1000 / 390x1000, DPR 1, prefers-reduced-motion: reduce, --hide-scrollbars, software raster flags of the page skeleton baseline",
    fonts:
      "Inter Variable, Noto Sans SC Variable, JetBrains Mono Variable (lockfile @fontsource)",
    fixture:
      "test-support/c564-fixture.tsx + src/testing/launch-settings-fixture.ts: 4 synthetic launch profiles, 4 Providers, 2 model aliases; mocked model list in the page (anthropic: 4 models, 3 with metadata; deepseek: 1; others empty) and mocked preview; no host, models.dev, endpoint, credential or inference; fixed clock 2026-01-01T00:00Z; not production scale",
    interactions:
      "real CDP mouse presses and key events (ArrowDown/Enter/Tab) and Input.insertText; drawers scrolled so the Harness label is at the top",
    cases,
    pixelDiffAgainstBefore: before ? diffs : null,
  };
  await writeFile(
    resolve(output, "measurements.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(`C-564: ${Object.keys(shots).length} shots`);
} finally {
  await browser?.close();
  await server.close();
}
