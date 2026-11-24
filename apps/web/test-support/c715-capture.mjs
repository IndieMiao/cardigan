// C-715 evidence: the story checklist submitted as one whole. At 1440/390 ×
// light/dark it shoots the card list (reference page), the checklist open,
// typed (two answers, one blank), a failed submit, the retry and the leave
// confirmation, plus side-by-side images and measurements. Real mouse and key
// input through CDP. C715_BASELINE_REF=<git ref> loads that ref's checklist
// files and shoots only the steps the old page has (open, typed). Synthetic
// fixture, local Vite only, no backend.
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
await mkdir(output); // Never replace existing evidence.
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const baseline = process.env.C715_BASELINE_REF;
const swapped = [
  "src/components/StoryDiscussion.tsx",
  "src/components/layout/ChecklistLayout.tsx",
  "src/components/layout/ChecklistLayout.module.css",
];
const historical = new Map(
  baseline
    ? swapped.map((file) => [
        resolve(root, file),
        git("show", `${baseline}:apps/web/${file}`),
      ])
    : [],
);
const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "c715-fixture",
      enforce: "pre",
      load(id) {
        return historical.get(id.split("?")[0]);
      },
      configureServer(s) {
        s.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__c715")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await s.transformIndexHtml(
              "/__c715",
              '<!doctype html><html lang="zh-CN"><head><title>C-715</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/c715-fixture.tsx"></script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
const measure = `(() => {
  const px = (v) => Math.round(v * 100) / 100;
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return { x: px(r.x), y: px(r.y), width: px(r.width), height: px(r.height), right: px(r.right), fontSize: s.fontSize, lineHeight: s.lineHeight, color: s.color, fontWeight: s.fontWeight }; };
  const section = document.querySelector('[aria-label="需求澄清"]');
  const buttons = section ? Array.from(section.querySelectorAll('button')) : [];
  const byText = (t) => buttons.find((b) => b.textContent.trim() === t) ?? null;
  const note = section ? Array.from(section.querySelectorAll('span')).find((s) => /题按推荐$/.test(s.textContent)) : null;
  const items = section ? Array.from(section.querySelectorAll('li')) : [];
  return {
    section: box(section),
    heading: box(section?.querySelector('h2')),
    panel: box(section?.querySelector('fieldset')),
    itemTitle: box(items[1]?.querySelector('strong')),
    itemContext: box(items[1]?.querySelector('p')),
    resolved: items.map((li) => li.querySelector(':scope > p:not(:first-of-type)')?.textContent ?? null),
    inputs: Array.from(section?.querySelectorAll('input') ?? []).map(box),
    submit: box(byText('提交')),
    acceptAll: box(byText('整组按默认')),
    perQuestionAnswerButtons: buttons.filter((b) => b.textContent.trim() === '回答').length,
    note: note ? { text: note.textContent, ...box(note) } : null,
    dialog: box(document.querySelector('[role="dialog"]')),
    dialogTitle: document.querySelector('[role="dialog"] h2')?.textContent ?? null,
    feedback: Array.from(document.querySelectorAll('[role="alert"]')).map((el) => el.textContent.trim()).filter(Boolean),
    document: { clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth },
  };
})()`;
const reference = `(() => {
  const px = (v) => Math.round(v * 100) / 100;
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return { x: px(r.x), y: px(r.y), width: px(r.width), height: px(r.height), fontSize: s.fontSize, lineHeight: s.lineHeight }; };
  return {
    title: box(document.querySelector('h1')),
    toolbarButton: box(document.querySelector('.ui-workspace button')),
    search: box(document.querySelector('input[type=search]')),
    body: box(document.body),
    document: { clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth },
  };
})()`;
const records = [];
let browser;
try {
  await server.listen();
  browser = await chromium({
    args: [
      "--run-all-compositor-stages-before-draw",
      "--disable-threaded-animation",
      "--disable-threaded-scrolling",
      "--disable-partial-raster",
      "--disable-gpu",
      "--force-color-profile=srgb",
      "--num-raster-threads=1",
    ],
  });
  const { send, evaluate } = browser;
  const version = (await send("Browser.getVersion")).product;
  const until = async (expression, timeout = 15000) => {
    const end = Date.now() + timeout;
    while (!(await evaluate(expression))) {
      assert(Date.now() < end, expression);
      await delay(40);
    }
  };
  const settled = async () => {
    await delay(200);
    await until("window.__c715.state.pending === 0");
    await delay(400);
    await until("window.__c715.state.pending === 0");
    await delay(200);
  };
  const shoot = async (name) => {
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    await writeFile(
      resolve(output, `${name}.png`),
      Buffer.from(data, "base64"),
      {
        flag: "wx",
      },
    );
  };
  const center = (selector, text, pattern) =>
    evaluate(
      `(() => { const el = Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find((e) => (${JSON.stringify(text ?? null)} === null || e.textContent.trim() === ${JSON.stringify(text ?? null)}) && (${JSON.stringify(pattern?.source ?? null)} === null || new RegExp(${JSON.stringify(pattern?.source ?? "")}).test(e.textContent.trim()))); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    );
  const click = async (point) => {
    assert(point, "click target");
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
      await send("Input.dispatchMouseEvent", {
        type,
        x: point.x,
        y: point.y,
        button: type === "mouseMoved" ? "none" : "left",
        clickCount: type === "mouseMoved" ? 0 : 1,
      });
  };
  const type = async (text) => {
    await send("Input.insertText", { text });
    await delay(60);
  };
  // Below the sticky tab bar, with the section heading in view.
  const reveal = () =>
    evaluate(
      `(() => { document.querySelector('[aria-label="需求澄清"]').scrollIntoView({ block: 'start' }); scrollBy(0, -64); })()`,
    );
  const blur = () => evaluate("document.activeElement?.blur()");
  for (const width of [1440, 390]) {
    const height = 1000;
    for (const theme of ["light", "dark"]) {
      const metrics = async (w = width) =>
        send("Emulation.setDeviceMetricsOverride", {
          width: w,
          height,
          deviceScaleFactor: 1,
          mobile: false,
        });
      await metrics();
      await send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: theme }],
      });
      const base = server.resolvedUrls.local[0];
      const prefix = `${width}-${theme}`;
      const record = { width, height, theme, steps: [] };
      records.push(record);
      await send("Page.navigate", {
        url: `${base}__c715?case=list-${prefix}#/p/p-1/cards?view=list`,
      });
      await until(
        "document.readyState === 'complete' && !!document.querySelector('table')",
      );
      await evaluate("document.fonts.ready");
      await delay(300);
      record.reference = await evaluate(reference);
      await shoot(`reference-cards-${prefix}`);
      const open = async (fail) => {
        await send("Page.navigate", {
          url: `${base}__c715?case=${prefix}${fail ? "&fail=1" : ""}#/p/p-1/cards/C-1`,
        });
        await until(
          "!!document.querySelector('[aria-label=\"需求澄清\"] fieldset')",
        );
        await evaluate("document.fonts.ready");
        await settled();
        // The checklist sits on the timeline tab.
        await click(await center('[id$="timeline-tab"]'));
        await until(
          "document.querySelector('[aria-label=\"需求澄清\"]').getBoundingClientRect().height > 0",
        );
        await delay(200);
        await reveal();
        await delay(200);
      };
      const step = async (name) => {
        record.steps.push({ step: name, ...(await evaluate(measure)) });
        await shoot(`${prefix}-${name}`);
      };
      await open(true);
      await step("01-open");
      await click(await center('[aria-label="第 2 题回答"]'));
      await type("季节轮廓各自独立");
      await click(await center('[aria-label="第 4 题回答"]'));
      await type("先交 6 张");
      await blur();
      await reveal();
      await delay(200);
      await step("02-typed");
      if (baseline) continue;
      await click(await center('[aria-label="需求澄清"] button', "提交"));
      await settled();
      await reveal();
      await delay(200);
      await step("03-failed-keeps-drafts");
      await click(await center('[aria-label="需求澄清"] button', "提交"));
      await settled();
      await reveal();
      await delay(300);
      record.writes = await evaluate("window.__c715.state.writes");
      await step("04-submitted");
      await open(false);
      await click(await center('[aria-label="第 3 题回答"]'));
      await type("朝左下");
      await blur();
      // Any link to another page: the first sidebar/top navigation link.
      const link = await evaluate(`(() => {
        const a = Array.from(document.querySelectorAll('a[href^="#/p/p-1/"]')).find((a) => !a.closest('[aria-label="需求澄清"]') && !/cards\\/C-1/.test(a.getAttribute('href')) && a.getBoundingClientRect().width > 0 && a.getBoundingClientRect().top >= 0);
        if (!a) return null;
        a.setAttribute('data-c715-link', '');
        return a.getAttribute('href');
      })()`);
      assert(link, "a link to another page");
      record.leaveLink = link;
      await click(await center("[data-c715-link]"));
      await until("!!document.querySelector('[role=\"dialog\"]')");
      await delay(300);
      await step("05-leave-asks");
      record.hashWhileAsking = await evaluate("location.hash");
      // Discarding leaves for the link and drops the draft (no unload prompt).
      await click(await center('[role="dialog"] button', "放弃修改"));
      await until("!document.querySelector('[role=\"dialog\"]')");
      await delay(300);
      record.hashAfterDiscard = await evaluate("location.hash");
    }
  }
  // Side by side with the reference page at the same width and theme.
  for (const record of records) {
    const prefix = `${record.width}-${record.theme}`;
    const names = baseline ? ["02-typed"] : ["02-typed", "04-submitted"];
    for (const name of names) {
      const images = await Promise.all(
        [`reference-cards-${prefix}`, `${prefix}-${name}`].map(async (n) =>
          (await readFile(resolve(output, `${n}.png`))).toString("base64"),
        ),
      );
      await send("Emulation.setDeviceMetricsOverride", {
        width: record.width * 2 + 16,
        height: record.height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await send("Page.navigate", { url: "about:blank" });
      await delay(100);
      await evaluate(`(() => {
        document.body.style.cssText = 'margin:0;display:flex;gap:16px;background:#888';
        for (const src of ${JSON.stringify(images)}) { const img = new Image(); img.src = 'data:image/png;base64,' + src; img.style.display = 'block'; document.body.append(img); }
        return Promise.all(Array.from(document.images).map((i) => i.decode()));
      })()`);
      await delay(100);
      await shoot(`side-by-side-${prefix}-${name}`);
    }
  }
  const head = git("rev-parse", "HEAD");
  await writeFile(
    resolve(output, "measurements.json"),
    `${JSON.stringify(
      {
        card: "C-715",
        mode: baseline ? "baseline" : "delivery",
        baseline: baseline ? git("rev-parse", baseline) : null,
        head,
        tree: git("rev-parse", "HEAD^{tree}"),
        dirty: git("status", "--porcelain").length > 0,
        browser: version,
        dpr: 1,
        fonts: [
          "Inter Variable",
          "Noto Sans SC Variable",
          "JetBrains Mono Variable",
        ],
        data: "c715-fixture.tsx: 1 story card, 1 checklist of 4 questions (1 answered earlier), synthetic only",
        records,
      },
      null,
      2,
    )}\n`,
    { flag: "wx" },
  );
} finally {
  await browser?.close();
  await server.close();
}
