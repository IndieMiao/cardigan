// C-516: settings "模型" writes and checks — list, detail actions, edit form
// with an in-place field error, the diff confirmation, a stale snapshot, the
// discard question, a referenced profile that cannot be deleted, a new
// profile refused by the server, provider and alias forms, a running and a
// finished check, the list after saving, and the employee drawer's launch
// profile choice (options, a blocked role, saved). 1440/390 × light/dark, plus the
// card list, the roles panel and the role edit drawer at the same
// width/theme for side-by-side comparison.
// CHROMIUM_PATH=<chromium> node apps/web/test-support/c516-capture.mjs <new output dir>
// C516_BASELINE_REF=<git ref> renders that ref's page files (before: only the
// scenes that existed — card list, roles, role edit, models list and detail,
// employees list and employee drawer).
// C516_BEFORE=<before output dir> counts differing pixels per scene name.
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
const before = process.env.C516_BEFORE && resolve(process.env.C516_BEFORE);
const baseline = process.env.C516_BASELINE_REF;
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
// Files this card changes; the baseline renders its own copies.
const historical = new Map(
  baseline
    ? [
        "api.ts",
        "testing/fixtures.ts",
        "testing/launch-settings-fixture.ts",
        "views/ModelsSettings.tsx",
        "views/EmployeesSettings.tsx",
        "components/layout/SettingsLayout.tsx",
        "components/layout/SettingsLayout.module.css",
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
      name: "c516-fixture",
      enforce: "pre",
      load(id) {
        return historical.get(id.split("?")[0]);
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__c516")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              "/__c516",
              '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/c516-fixture.tsx"></script></body></html>',
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
  const key = async (name, code) => {
    for (const type of ["keyDown", "keyUp"])
      await send("Input.dispatchKeyEvent", {
        type,
        key: name,
        code: name,
        windowsVirtualKeyCode: code,
        nativeVirtualKeyCode: code,
      });
  };
  const open = async (path, ready, theme) => {
    await send("Page.navigate", { url: "about:blank" });
    await until("location.href === 'about:blank'");
    await send("Page.navigate", {
      url: `${server.resolvedUrls.local[0]}__c516${path}`,
    });
    await until(ready);
    await run((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await settle();
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
        // A scripted click has no pointer: drop the focus ring it leaves.
        requestAnimationFrame(() => {
          if (document.activeElement?.tagName === "BUTTON")
            document.activeElement.blur();
        });
      },
      text,
      scope,
    );
  /** Type into the drawer field whose label starts with `label`. */
  const fill = (label, value) =>
    run(
      (label, value) => {
        const l = [...document.querySelectorAll("[role=dialog] label")].find(
          (x) => x.firstChild?.textContent?.trim() === label,
        );
        const input = l?.querySelector("input");
        if (!input) throw new Error(`Missing field: ${label}`);
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        ).set.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.blur();
      },
      label,
      value,
    );
  const row = async (
    name,
    ready = "!!document.querySelector('[role=dialog] h3')",
  ) => {
    await run((name) => {
      const b = [
        ...document.querySelectorAll("[data-settings-content] td button"),
      ].find((x) => x.textContent.trim() === name);
      if (!b) throw new Error(`Missing row: ${name}`);
      b.click();
    }, name);
    await until(ready);
    await delay(300);
  };
  const employeeReady = "!!document.querySelector('[role=dialog] form')";
  /** Open the drawer's select labelled `label` and pick the option `value`. */
  const choose = async (label, value) => {
    await run((label) => {
      const l = [...document.querySelectorAll("[role=dialog] label")].find(
        (x) => x.firstChild?.textContent?.trim() === label,
      );
      const select = l?.querySelector("[role=combobox]");
      if (!select) throw new Error(`Missing select: ${label}`);
      select.focus();
    }, label);
    await key("ArrowDown", 40);
    await until("!!document.querySelector('[role=listbox] [role=option]')");
    await delay(200);
    if (value === undefined) return;
    await run((value) => {
      const option = document.querySelector(
        `[role=option][data-value="${value}"]`,
      );
      if (!option) throw new Error(`Missing option: ${value}`);
      option.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    }, value);
    await until("!document.querySelector('[role=listbox]')");
  };
  const employees = async (theme) => {
    await open("/#/p/p-1/settings?tab=employees", settings, theme);
    await until(
      "!!document.querySelector('table[aria-label=员工列表] tbody tr')",
    );
    await settle();
  };
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
      const limit = content
        ? content.getBoundingClientRect().right + 0.5
        : innerWidth;
      return {
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth,
        pageTitle: box(document.querySelector(".ui-page-header h1")),
        navCurrent: box(
          document.querySelector(
            "nav[aria-label='设置分栏'] [aria-current='page']",
          ),
        ),
        content: box(content),
        panelTitle: box(content?.querySelector("h2")),
        panelAction: box(content?.querySelector("h2 ~ div button")),
        tableHead: box(content?.querySelector("th")),
        tableCell: box(content?.querySelector("td")),
        statusTag: box(content?.querySelector("td [data-ui='badge']")),
        feedback: [...document.querySelectorAll(".request-feedback")]
          .filter((t) => t.textContent.trim())
          .map((t) => t.textContent.trim()),
        overflowing: [...(content?.querySelectorAll("*") ?? [])]
          .filter((e) => {
            if (e.closest("[hidden]")) return false;
            const r = e.getBoundingClientRect();
            return r.width > 0 && r.right > limit;
          })
          .slice(0, 8)
          .map(box),
      };
    });
  const measureDrawer = () =>
    run(() => {
      const dialogs = [...document.querySelectorAll("[role=dialog]")];
      const d = dialogs[0];
      const top = dialogs.at(-1);
      const font = (e) => {
        if (!e) return null;
        const s = getComputedStyle(e),
          b = e.getBoundingClientRect();
        return {
          text: (e.textContent || e.value || "").trim().slice(0, 32),
          font: `${s.fontSize}/${s.lineHeight} ${s.fontWeight}`,
          x: Math.round(b.left),
          y: Math.round(b.top),
          w: Math.round(b.width),
          h: Math.round(b.height),
          border: s.borderTopColor,
          color: s.color,
        };
      };
      const r = d.getBoundingClientRect();
      const actions = top.querySelectorAll("form > div:last-of-type button");
      return {
        drawer: { x: r.left, y: r.top, w: r.width, h: r.height },
        drawerScrollWidth: d.scrollWidth,
        drawerClientWidth: d.clientWidth,
        innerOverflow: [...d.querySelectorAll("*")]
          .filter((e) => e.getBoundingClientRect().right > r.right + 0.5)
          .slice(0, 5)
          .map(font),
        title: font(d.querySelector("h2")),
        headerButtons: [
          ...d.querySelectorAll("header button, .drawer-actions button"),
        ].map(font),
        section: font(d.querySelector("section h3")),
        factLabel: font(d.querySelector("dt")),
        factValue: font(d.querySelector("dd")),
        label: font(d.querySelector("form label")),
        input: font(d.querySelector("form input")),
        select: font(d.querySelector("form [role=combobox]")),
        selects: [...d.querySelectorAll("form [role=combobox]")].map((e) => ({
          ...font(e),
          disabled: e.disabled,
        })),
        options: [
          ...document.querySelectorAll("[role=listbox] [role=option]"),
        ].map((e) => e.textContent.trim()),
        invalid: [...d.querySelectorAll("[aria-invalid=true]")].map((e) => ({
          ...font(e),
          note: font(
            document.getElementById(e.getAttribute("aria-describedby") ?? ""),
          ),
        })),
        alert: font(top.querySelector("[role=alert]")),
        diff: [...d.querySelectorAll("dd [data-op]")].map(font),
        actionButtons: [...actions].map(font),
        question: dialogs.length > 1 ? font(top) : null,
        buttons: [...top.querySelectorAll("button")].map(
          (b) => b.getAttribute("aria-label") ?? b.textContent.trim(),
        ),
        scrollWidth: document.documentElement.scrollWidth,
      };
    });
  const settings = "!!document.querySelector('[data-settings-content]')";
  const modelsReady =
    "!!document.querySelector('table[aria-label=启动配置] tbody tr')";
  const models = async (theme, params = "") => {
    await open(`/${params}#/p/p-1/settings?tab=models`, settings, theme);
    await until(modelsReady);
    await settle();
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
        if (results[name].scrollWidth !== undefined)
          assert.equal(results[name].scrollWidth, width, `${name}: overflow`);
        return data;
      };
      // References: the card list and the roles panel with its edit drawer.
      await open(
        "/#/p/p-1/cards?view=list",
        "!!document.querySelector('table, .card-list')",
        theme,
      );
      const cardsShot = await scene("cards", measurePage);
      await open("/#/p/p-1/settings?tab=roles", settings, theme);
      await until("!!document.querySelector('[data-settings-content] table')");
      const rolesShot = await scene("roles", measurePage);
      await row("开发工程师");
      await until("!!document.querySelector('[role=dialog] dl')");
      await click("编辑");
      await until("!!document.querySelector('[role=dialog] form input')");
      const roleEditShot = await scene("roles-edit", measureDrawer);

      // Employees (C-494 list and drawer; C-516 adds the profile field).
      await employees(theme);
      const employeesShot = await scene("employees", measurePage);
      await row("悟净", employeeReady);
      await until(
        "!!document.querySelector('[role=dialog] form [role=combobox]')",
      );
      await settle();
      const employeeEditShot = await scene("employees-edit", measureDrawer);
      pairs.push(
        {
          name: "employees-vs-roles",
          width,
          theme,
          left: rolesShot,
          right: employeesShot,
        },
        {
          name: "employee-edit-vs-role-edit",
          width,
          theme,
          left: roleEditShot,
          right: employeeEditShot,
        },
      );

      // Models list (C-518 scene name: pixel diff against the baseline).
      await models(theme);
      const modelsShot = await scene("models", measurePage);
      assert.deepEqual(results.models.overflowing, [], "models: column");
      pairs.push(
        {
          name: "models-vs-roles",
          width,
          theme,
          left: rolesShot,
          right: modelsShot,
        },
        {
          name: "models-vs-cards",
          width,
          theme,
          left: cardsShot,
          right: modelsShot,
        },
      );
      // Detail: copy / delete / edit in the title row, section actions.
      await row("claude-opus");
      await until("!!document.querySelector('[role=dialog] dl')");
      await scene("models-detail", measureDrawer);
      if (baseline) {
        cases.push({ width, theme, results });
        continue;
      }
      assert.deepEqual(results["models-detail"].buttons, [
        "复制",
        "删除",
        "编辑",
        "关闭抽屉",
        "编辑 Provider",
        "编辑模型别名",
        "本地检查",
        "在线探测",
      ]);
      // Edit: one field wrong, marked in place; the preview stays unavailable.
      await click("编辑");
      await until("!!document.querySelector('[role=dialog] form input')");
      await fill("推理强度", "medium");
      await fill("权限模式", "bad mode!");
      const editShot = await scene("models-edit-invalid", measureDrawer);
      assert.equal(results["models-edit-invalid"].invalid.length, 1);
      pairs.push({
        name: "edit-vs-role-edit",
        width,
        theme,
        left: roleEditShot,
        right: editShot,
      });
      // Correct it: preview shows the diff, nothing written yet.
      await fill("权限模式", "");
      await click("预览修改");
      await until("!!document.querySelector('[role=dialog] dd [data-op]')");
      await scene("models-review", measureDrawer);
      // Confirm → saved: back to the detail, list read again.
      await click("确认保存");
      await until(
        "[...document.querySelectorAll('.request-feedback')].some((t) => t.textContent.includes('已保存启动配置'))",
      );
      await key("Escape", 27);
      await until("!document.querySelector('[role=dialog]')");
      await scene("models-saved", measurePage);
      assert(
        results["models-saved"].feedback.some((t) =>
          t.startsWith("已保存启动配置 claude-opus"),
        ),
      );

      // A stale snapshot on confirm.
      await models(theme, "?confirm=stale");
      await row("claude-opus");
      await click("编辑");
      await until("!!document.querySelector('[role=dialog] form input')");
      await fill("推理强度", "low");
      await click("预览修改");
      await until("!!document.querySelector('[role=dialog] dd [data-op]')");
      await click("确认保存");
      await until("!!document.querySelector('[role=dialog] [role=alert]')");
      await scene("models-stale", measureDrawer);
      // Leaving with unapplied edits asks first.
      await click("返回修改");
      await until("!!document.querySelector('[role=dialog] form input')");
      await click("关闭抽屉");
      await until("document.querySelectorAll('[role=dialog]').length === 2");
      await delay(300);
      await scene("models-discard", measureDrawer);
      await click("继续编辑");
      await until("document.querySelectorAll('[role=dialog]').length === 1");

      // A referenced profile cannot be deleted.
      await models(theme);
      await row("claude-opus");
      await click("删除");
      await until("!!document.querySelector('[role=dialog] [role=alert]')");
      await scene("models-delete-in-use", measureDrawer);
      // An unused one: the diff says it will be deleted.
      await models(theme);
      await row("pi-deepseek");
      await click("删除");
      await click("预览删除");
      await until("!!document.querySelector('[role=dialog] dd [data-op]')");
      await scene("models-delete-review", measureDrawer);

      // A new profile whose name the server refuses.
      await models(theme, "?preview=invalid");
      await click("新建启动配置", "page");
      await until("!!document.querySelector('[role=dialog] form input')");
      await delay(300);
      await fill("名称", "added-elsewhere");
      await click("预览修改");
      await until(
        "!!document.querySelector('[role=dialog] [aria-invalid=true]')",
      );
      await scene("models-new-invalid", measureDrawer);

      // Provider: endpoint and the secret key reference (key names only).
      await models(theme);
      await row("claude-opus");
      await click("编辑 Provider");
      await until("!!document.querySelector('[role=dialog] form input')");
      await fill("端点", "https://gateway.example.test");
      await scene("models-provider", measureDrawer);
      // Alias: point it at another id.
      await models(theme);
      await row("claude-opus");
      await click("编辑模型别名");
      await until("!!document.querySelector('[role=dialog] form input')");
      await fill("模型标识", "claude-opus-fixture-2");
      await click("预览修改");
      await until("!!document.querySelector('[role=dialog] dd [data-op]')");
      await scene("models-alias-review", measureDrawer);

      // Checks: only on a click; running, then the result of what ran.
      await models(theme, "?check=hold");
      await row("pi-deepseek");
      await click("在线探测");
      await until(
        "document.querySelector('[role=dialog]')?.textContent.includes('在线探测中')",
      );
      await run(() =>
        [...document.querySelectorAll("[role=dialog] h3")]
          .find((h) => h.textContent === "检查")
          .scrollIntoView({ block: "start" }),
      );
      await scene("models-check-running", measureDrawer);
      await models(theme);
      await row("pi-deepseek");
      await click("在线探测");
      await until(
        "document.querySelector('[role=dialog]')?.textContent.includes('已列出模型')",
        8000,
      );
      await run(() =>
        [...document.querySelectorAll("[role=dialog] h3")]
          .find((h) => h.textContent === "检查")
          .scrollIntoView({ block: "start" }),
      );
      await scene("models-check-result", measureDrawer);
      results.checkText = await evaluate(
        "document.querySelector('[role=dialog]').textContent.includes('推理通过')",
      );
      assert.equal(results.checkText, false);

      // Employee launch profile: valid profiles or following the role.
      await employees(theme);
      await row("悟净", employeeReady);
      await until(
        "[...document.querySelectorAll('[role=dialog] form [role=combobox]')].every((s) => !s.disabled)",
      );
      await choose("启动配置");
      await scene("employees-profile-options", measureDrawer);
      assert.deepEqual(results["employees-profile-options"].options, [
        "跟随角色（codex-sol）",
        "claude-opus",
        "codex-sol",
        "pi-deepseek",
        "claude-local",
      ]);
      await key("Escape", 27);
      await until("!document.querySelector('[role=listbox]')");
      // A run in progress blocks the role, not the profile.
      await employees(theme);
      await row("八戒", employeeReady);
      await until(
        "document.querySelectorAll('[role=dialog] form [role=combobox]:not([disabled])').length === 1",
      );
      await choose("启动配置", "");
      await scene("employees-blocked", measureDrawer);
      assert.deepEqual(
        results["employees-blocked"].selects.map((s) => s.disabled),
        [true, false],
      );
      // Leave through the discard question, so no unload prompt is pending.
      await click("取消");
      await until("document.querySelectorAll('[role=dialog]').length === 2");
      await click("放弃修改");
      await until("!document.querySelector('[role=dialog]')");
      // Pin one and save: the drawer closes and the page says what changed.
      await employees(theme);
      await row("悟净", employeeReady);
      await until(
        "[...document.querySelectorAll('[role=dialog] form [role=combobox]')].every((s) => !s.disabled)",
      );
      await choose("启动配置", "pi-deepseek");
      await click("保存");
      await until("!document.querySelector('[role=dialog]')");
      await until(
        "[...document.querySelectorAll('.request-feedback')].some((t) => t.textContent.includes('启动配置改为 pi-deepseek'))",
      );
      await scene("employees-saved", measurePage);
      cases.push({ width, theme, results });
    }
  // Side-by-side: reference (left) | models (right), same width/theme.
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
      "test-support/c516-fixture.tsx + src/testing/launch-settings-fixture.ts: 4 synthetic launch profiles, 3 providers, 2 model aliases, 3 role and 2 employee references, 4 fake secrets.env key names (no values); mocked C-515 preview/confirm/check (in-page, timer for the check, no host, endpoint or paid call); settings-panels-data.ts for roles; fixed clock 2026-01-01T00:00Z; not production scale",
    cases,
    pixelDiffAgainstBefore: before ? diffs : null,
  };
  await writeFile(
    resolve(output, "measurements.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(`C-516: ${Object.keys(shots).length} shots`);
} finally {
  await browser?.close();
  await server.close();
}
