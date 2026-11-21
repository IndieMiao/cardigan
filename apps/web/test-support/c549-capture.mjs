// C-549: settings "模型" → Provider — the list under the launch profiles,
// detail (secret status, hidden variable, probe), a new Provider with an
// in-place error and a filled form (fake secret, masked), the confirmation
// diff (secret named, never its value), a failed write that empties the
// secret input, a stale write, replace/clear, a Provider in use that cannot
// be deleted, a probe running and failed, and the discard question.
// 1440/390 × light/dark, plus the card list at the same width/theme for
// side-by-side comparison.
// CHROMIUM_PATH=<chromium> node apps/web/test-support/c549-capture.mjs <new output dir>
// C549_BASELINE_REF=<git ref> renders that ref's page files (before: only the
// scenes that existed — card list, models list, profile detail and the
// profile drawer's Provider form).
// C549_FULL=1 with a baseline renders every scene that existed then (V-2708:
// before = the previous delivery).
// C549_BEFORE=<before output dir> counts differing pixels per scene name.
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
const before = process.env.C549_BEFORE && resolve(process.env.C549_BEFORE);
const baseline = process.env.C549_BASELINE_REF;
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
        "views/LaunchForms.tsx",
        "views/launch-change.ts",
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
      name: "c549-fixture",
      enforce: "pre",
      load(id) {
        return historical.get(id.split("?")[0]);
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__c549")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              "/__c549",
              '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/c549-fixture.tsx"></script></body></html>',
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
      url: `${server.resolvedUrls.local[0]}__c549${path}`,
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
  const toProviders = () =>
    run(() => {
      const panel = document.getElementById("providers");
      (
        panel ?? document.querySelector("table[aria-label=启动配置]")
      )?.scrollIntoView({ block: panel ? "start" : "end" });
    });
  /** Open the Provider row `id` (its link button in the Provider table). */
  const provider = async (id) => {
    await run((id) => {
      const b = [
        ...document.querySelectorAll("table[aria-label=Provider] td button"),
      ].find((x) => x.textContent.trim() === id);
      if (!b) throw new Error(`Missing provider: ${id}`);
      b.click();
    }, id);
    await until("!!document.querySelector('[role=dialog] h3')");
    await delay(300);
  };
  /** Type into the field `label` inside the group (fieldset) `group`, or the form. */
  const fillIn = (group, label, value) =>
    run(
      (group, label, value) => {
        const d = [...document.querySelectorAll("[role=dialog]")].at(-1);
        const scope = group
          ? [...d.querySelectorAll("fieldset")].find(
              (f) => f.querySelector("legend")?.textContent.trim() === group,
            )
          : d;
        const l = [...(scope?.querySelectorAll("label") ?? [])].find(
          (x) => x.firstChild?.textContent?.trim() === label,
        );
        const input = l?.querySelector("input");
        if (!input) throw new Error(`Missing field: ${group}/${label}`);
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        ).set.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.blur();
      },
      group,
      label,
      value,
    );
  /** Click button `text` inside the group (fieldset) `group`. */
  const clickIn = (group, text) =>
    run(
      (group, text) => {
        const d = [...document.querySelectorAll("[role=dialog]")].at(-1);
        const f = [...d.querySelectorAll("fieldset")].find(
          (x) => x.querySelector("legend")?.textContent.trim() === group,
        );
        const b = [...(f?.querySelectorAll("button") ?? [])].find(
          (x) => x.textContent.trim() === text,
        );
        if (!b) throw new Error(`Missing button: ${group}/${text}`);
        b.click();
      },
      group,
      text,
    );
  const scrollTo = (selector) =>
    run((selector) => {
      const d = document.querySelector("[role=dialog]");
      const target = [...d.querySelectorAll(selector.tag)].find((e) =>
        e.textContent.trim().startsWith(selector.text),
      );
      target?.scrollIntoView({ block: "start" });
    }, selector);
  const passwords = () =>
    run(() =>
      [...document.querySelectorAll("[role=dialog] input[type=password]")].map(
        (i) => ({
          length: i.value.length,
          autocomplete: i.getAttribute("autocomplete"),
          invalid: i.getAttribute("aria-invalid"),
        }),
      ),
    );
  const FAKE = "fixture-not-a-real-key-0000";
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
      // Reference: the card list.
      await open(
        "/#/p/p-1/cards?view=list",
        "!!document.querySelector('table, .card-list')",
        theme,
      );
      const cardsShot = await scene("cards", measurePage);
      // The models tab: launch profiles, then the Provider list below.
      await models(theme);
      const modelsShot = await scene("models", measurePage);
      pairs.push({
        name: "models",
        width,
        theme,
        left: cardsShot,
        right: modelsShot,
      });
      await toProviders();
      await settle();
      const providersShot = await scene("models-providers", () =>
        run(() => {
          const panel = document.getElementById("providers");
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
          const prev = document.getElementById("models");
          return {
            scrollWidth: document.documentElement.scrollWidth,
            panel: box(panel),
            panelTitle: box(panel?.querySelector("h2")),
            panelAction: box(panel?.querySelector("h2 ~ div button")),
            tableHead: box(panel?.querySelector("th")),
            tableCell: box(panel?.querySelector("td")),
            gapFromProfiles:
              panel && prev
                ? Math.round(
                    panel.getBoundingClientRect().top -
                      prev.getBoundingClientRect().bottom,
                  )
                : null,
            rows: [...(panel?.querySelectorAll("tbody tr") ?? [])].map((r) =>
              r.textContent.trim(),
            ),
          };
        }),
      );
      pairs.push({
        name: "providers",
        width,
        theme,
        left: cardsShot,
        right: providersShot,
      });
      if (baseline && !process.env.C549_FULL) {
        // Before: the profile drawer's Provider form is all there was.
        await models(theme);
        await row("claude-opus");
        await click("编辑 Provider");
        await until("!!document.querySelector('[role=dialog] form input')");
        await scene("profile-provider-form", measureDrawer);
        cases.push({ width, theme, results });
        continue;
      }
      // The same form, opened from a profile (C-516 entry kept).
      await models(theme);
      await row("claude-opus");
      await click("编辑 Provider");
      await until("!!document.querySelector('[role=dialog] form input')");
      await scene("profile-provider-form", measureDrawer);

      // Detail: secret status and time, a hidden variable, the last probe.
      await models(theme);
      await toProviders();
      await provider("anthropic");
      await scene("provider-detail", measureDrawer);
      await scrollTo({ tag: "h3", text: "密钥" });
      await scene("provider-detail-secrets", measureDrawer);

      // New: duplicate id and a bad endpoint are marked in place.
      await models(theme);
      await click("新建 Provider", "page");
      await until("!!document.querySelector('[role=dialog] form input')");
      await delay(300);
      await fillIn(null, "ID", "anthropic");
      await fillIn(null, "端点", "ftp://gateway");
      await scene("provider-new-invalid", measureDrawer);
      // Filled: one plain variable, one secret (fake value, masked).
      await fillIn(null, "ID", "gateway");
      await fillIn(null, "名称", "Gateway");
      await fillIn(null, "端点", "https://gateway.example.test");
      await click("添加环境变量");
      await fillIn("新环境变量", "变量名", "ANTHROPIC_DEFAULT_OPUS_MODEL");
      await fillIn("新环境变量", "值", "gateway-opus");
      await click("添加密钥变量");
      await fillIn("新密钥变量", "变量名", "ANTHROPIC_AUTH_TOKEN");
      await fillIn("新密钥变量", "密钥", FAKE);
      await scrollTo({ tag: "legend", text: "新环境变量" });
      await scene("provider-new-filled", measureDrawer);
      results.newPasswords = await passwords();
      assert.equal(results.newPasswords[0]?.length, FAKE.length);
      assert.equal(results.newPasswords[0]?.autocomplete, "new-password");
      await click("预览修改");
      await until("!!document.querySelector('[role=dialog] dd [data-op]')");
      await scene("provider-new-review", measureDrawer);
      results.reviewHasValue = await evaluate(
        `document.body.textContent.includes(${JSON.stringify(FAKE)})`,
      );
      assert.equal(results.reviewHasValue, false);
      await click("确认保存");
      // The new Provider opens: probe it from its detail.
      await until(
        "document.querySelector('[role=dialog]')?.getAttribute('aria-label')?.includes('gateway') || [...document.querySelectorAll('[role=dialog] h2')].some((h) => h.textContent === 'Gateway')",
      );
      await delay(300);
      await scene("provider-created", measureDrawer);

      if (!baseline) {
        // V-2713: filling a key in use does not ride along with another edit.
        await models(theme);
        await toProviders();
        await provider("relay");
        await click("编辑");
        await until("!!document.querySelector('[role=dialog] form input')");
        await fillIn(null, "名称", "Relay 2");
        await clickIn("密钥变量 ANTHROPIC_AUTH_TOKEN", "填写");
        await fillIn(
          "密钥变量 ANTHROPIC_AUTH_TOKEN",
          "新密钥 RELAY_TOKEN",
          FAKE,
        );
        await until(
          "[...document.querySelectorAll('[role=dialog] [role=alert]')].some((a) => a.textContent.includes('要单独保存'))",
        );
        await run(() =>
          document
            .querySelector("[role=dialog] [role=alert]")
            ?.scrollIntoView({ block: "center" }),
        );
        await scene("provider-mixed-secrets", measureDrawer);
        await click("取消");
        await until("document.querySelectorAll('[role=dialog]').length === 2");
        await click("放弃修改");
        await until("document.querySelectorAll('[role=dialog]').length <= 1");
      }

      // A failed write: the form stays, the secret input is emptied.
      await models(theme, "?confirm=fail");
      await click("新建 Provider", "page");
      await until("!!document.querySelector('[role=dialog] form input')");
      await delay(300);
      await fillIn(null, "ID", "gateway");
      await fillIn(null, "名称", "Gateway");
      await fillIn(null, "端点", "https://gateway.example.test");
      await click("添加密钥变量");
      await fillIn("新密钥变量", "变量名", "ANTHROPIC_AUTH_TOKEN");
      await fillIn("新密钥变量", "密钥", FAKE);
      await click("预览修改");
      await until("!!document.querySelector('[role=dialog] dd [data-op]')");
      await click("确认保存");
      await until(
        "[...document.querySelectorAll('[role=dialog] [role=alert]')].some((a) => a.textContent.includes('密钥没有写入'))",
      );
      await run(() =>
        document
          .querySelector("[role=dialog] [role=alert]")
          ?.scrollIntoView({ block: "center" }),
      );
      await scene("provider-write-failed", measureDrawer);
      results.failedPasswords = await passwords();
      assert.deepEqual(
        results.failedPasswords.map((p) => p.length),
        [0],
      );
      // Leaving asks first (unapplied edits); discard.
      await click("取消");
      await until("document.querySelectorAll('[role=dialog]').length === 2");
      await scene("provider-discard", measureDrawer);
      await click("放弃修改");
      await until("document.querySelectorAll('[role=dialog]').length <= 1");

      if (!baseline) {
        // V-2708: no reply, and the check gets none either: unknown, not "not written".
        await models(theme, "?confirm=lost");
        await toProviders();
        await provider("relay");
        await click("编辑");
        await until("!!document.querySelector('[role=dialog] form input')");
        await clickIn("密钥变量 ANTHROPIC_AUTH_TOKEN", "填写");
        await fillIn(
          "密钥变量 ANTHROPIC_AUTH_TOKEN",
          "新密钥 RELAY_TOKEN",
          FAKE,
        );
        await click("预览修改");
        await until("!!document.querySelector('[role=dialog] dd [data-op]')");
        await click("确认保存");
        await until(
          "[...document.querySelectorAll('[role=dialog] [role=alert]')].some((a) => a.textContent.includes('无法确认密钥是否已写入'))",
        );
        await run(() =>
          document
            .querySelector("[role=dialog] [role=alert]")
            ?.scrollIntoView({ block: "center" }),
        );
        await scene("provider-write-unknown", measureDrawer);
        results.unknownPasswords = await passwords();
        assert.deepEqual(
          results.unknownPasswords.map((p) => p.length),
          [0],
        );
        await click("取消");
        await until("document.querySelectorAll('[role=dialog]').length === 2");
        await click("放弃修改");
        await until("document.querySelectorAll('[role=dialog]').length <= 1");
        // V-2708: a key another Provider reads is refused before any preview.
        await models(theme);
        await toProviders();
        await provider("relay");
        await click("编辑");
        await until("!!document.querySelector('[role=dialog] form input')");
        await click("添加密钥变量");
        await fillIn("新密钥变量", "变量名", "ANTHROPIC_API_KEY");
        await fillIn("新密钥变量", "secrets.env 键名", "ANTHROPIC_API_KEY");
        await fillIn("新密钥变量", "密钥", FAKE);
        await until(
          "[...document.querySelectorAll('[role=dialog] [role=alert]')].some((a) => a.textContent.includes('也被 Provider anthropic 使用'))",
        );
        await run(() =>
          document
            .querySelector("[role=dialog] [role=alert]")
            ?.scrollIntoView({ block: "center" }),
        );
        await scene("provider-shared-key", measureDrawer);
        await click("取消");
        await until("document.querySelectorAll('[role=dialog]').length === 2");
        await click("放弃修改");
        await until("document.querySelectorAll('[role=dialog]').length <= 1");
      }

      // A stale write: refresh and preview again; nothing written.
      await models(theme, "?confirm=stale");
      await toProviders();
      await provider("anthropic");
      await click("编辑");
      await until("!!document.querySelector('[role=dialog] form input')");
      await clickIn("密钥变量 ANTHROPIC_API_KEY", "清除");
      await scrollTo({ tag: "legend", text: "密钥变量" });
      await scene("provider-edit-clear", measureDrawer);
      await click("预览修改");
      await until("!!document.querySelector('[role=dialog] dd [data-op]')");
      await scene("provider-edit-review", measureDrawer);
      await click("确认保存");
      await until(
        "[...document.querySelectorAll('[role=dialog] button')].some((b) => b.textContent.trim() === '刷新并重新预览')",
      );
      await scene("provider-stale", measureDrawer);
      await click("返回修改");
      await click("取消");
      await until("document.querySelectorAll('[role=dialog]').length === 2");
      await click("放弃修改");
      await until("document.querySelectorAll('[role=dialog]').length <= 1");

      if (!baseline) {
        // V-2708: removing a hidden variable shows its status, never its value.
        await models(theme);
        await toProviders();
        await provider("anthropic");
        await click("编辑");
        await until("!!document.querySelector('[role=dialog] form input')");
        await clickIn("环境变量 ANTHROPIC_CUSTOM_HEADERS_TOKEN", "移除");
        await click("预览修改");
        await until("!!document.querySelector('[role=dialog] dd [data-op]')");
        await scene("provider-hidden-review", measureDrawer);
        await click("返回修改");
        await click("取消");
        await until("document.querySelectorAll('[role=dialog]').length === 2");
        await click("放弃修改");
        await until("document.querySelectorAll('[role=dialog]').length <= 1");
      }

      // In use: no delete; the users are listed.
      await models(theme);
      await toProviders();
      await provider("anthropic");
      await click("删除");
      await until("!!document.querySelector('[role=dialog] [role=alert]')");
      await scene("provider-delete-in-use", measureDrawer);
      // Unused: the diff says it will be deleted.
      await models(theme);
      await toProviders();
      await provider("relay");
      await click("删除");
      await click("预览删除");
      await until("!!document.querySelector('[role=dialog] dd [data-op]')");
      await scene("provider-delete-review", measureDrawer);

      // Probe: running, then a failed result stated plainly.
      await models(theme, "?check=hold");
      await toProviders();
      await provider("relay");
      await click("在线探测");
      await until(
        "document.querySelector('[role=dialog]')?.textContent.includes('在线探测中')",
      );
      await scrollTo({ tag: "h3", text: "在线探测" });
      await scene("provider-probe-running", measureDrawer);
      await models(theme);
      await toProviders();
      await provider("relay");
      await click("在线探测");
      await until(
        "document.querySelector('[role=dialog]')?.textContent.includes('在线探测未通过')",
        8000,
      );
      await scrollTo({ tag: "h3", text: "在线探测" });
      await scene("provider-probe-failed", measureDrawer);
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
      "test-support/c549-fixture.tsx + src/testing/launch-settings-fixture.ts: 4 synthetic launch profiles, 4 Providers (one unused, one hidden variable), 2 model aliases, 4 fake secrets.env key names; one fake secret value typed by this script (masked, dropped by the mock); mocked preview/confirm/probe in the page (timer for the probe, no host, endpoint or paid call); fixed clock 2026-01-01T00:00Z; not production scale",
    cases,
    pixelDiffAgainstBefore: before ? diffs : null,
  };
  await writeFile(
    resolve(output, "measurements.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(`C-549: ${Object.keys(shots).length} shots`);
} finally {
  await browser?.close();
  await server.close();
}
