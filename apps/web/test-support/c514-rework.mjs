// C-514 rework: with the 40-employee roster (`?roster=long`), captures the
// open list at 1440/390/320 × light/dark and measures whether a long title
// still shortens the name; then checks in the browser that Escape does not
// carry over to the next comment, a new `@` re-reads the roster, a name with
// spaces keeps filtering and choosing inside an existing mention replaces it.
// CHROMIUM_PATH=<chrome> node apps/web/test-support/c514-rework.mjs <new output dir>
// C514_BASELINE_REF=<git ref> serves that ref's list for before shots (no
// behaviour checks).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "./chromium.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(process.argv[2] ?? "");
assert(process.argv[2], "Pass a new output directory");
const baseline = process.env.C514_BASELINE_REF;
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const historical = new Map(
  baseline
    ? [
        "components/CommentBox.tsx",
        "components/ui/suggestion-list.tsx",
        "components/ui/theme.css",
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
      name: "c514-fixture",
      enforce: "pre",
      load(id) {
        return historical.get(id.split("?")[0]);
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__c514")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              "/__c514",
              '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/c514-fixture.tsx"></script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
const cases = [];
const checks = {};
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
  const viewport = async (width, height, theme) => {
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
  };
  const openBox = async (theme) => {
    await send("Page.navigate", { url: "about:blank" });
    await until("location.href === 'about:blank'");
    await send("Page.navigate", {
      url: `${server.resolvedUrls.local[0]}__c514?roster=long#/p/p-1/cards/C-1`,
    });
    await until("!!document.querySelector('.card-page .comment-input')");
    await evaluate("document.fonts.ready.then(() => true)");
    await run((theme) => {
      document.documentElement.dataset.theme = theme;
      [...document.querySelectorAll(".card-page [role=tab]")]
        .find((t) => t.textContent.startsWith("时间线"))
        ?.click();
    }, theme);
    await until(
      "document.querySelector('.comment-input').getBoundingClientRect().width > 0",
    );
    await settle();
  };
  const key = async (key, code, keyCode) => {
    for (const type of ["rawKeyDown", "keyUp"])
      await send("Input.dispatchKeyEvent", {
        type,
        key,
        code,
        windowsVirtualKeyCode: keyCode,
      });
    await settle();
  };
  const type = async (text) => {
    await send("Input.insertText", { text });
    await settle();
  };
  const focusBox = async (block = "center") => {
    await run((block) => {
      const input = document.querySelector(".comment-input");
      input.scrollIntoView({ block });
      input.focus();
      input.select();
      document.execCommand("delete");
    }, block);
    await settle();
  };
  const options = () =>
    run(() =>
      [...document.querySelectorAll("[role=option] .ui-suggestion-label")].map(
        (l) => l.textContent,
      ),
    );
  const value = () =>
    evaluate("document.querySelector('.comment-input').value");
  const rows = () =>
    run(() => {
      const box = (el) =>
        el && {
          client: el.clientWidth,
          scroll: el.scrollWidth,
          width: Math.round(el.getBoundingClientRect().width * 100) / 100,
          truncated: el.scrollWidth > el.clientWidth,
        };
      const popover = document.querySelector(".ui-suggestions");
      const r = popover?.getBoundingClientRect();
      return {
        popover: r && {
          left: r.left,
          top: r.top,
          width: r.width,
          height: r.height,
          inViewport:
            r.left >= 0 &&
            r.top >= 0 &&
            r.right <= innerWidth &&
            r.bottom <= innerHeight,
        },
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth,
        rows: [...document.querySelectorAll("[role=option]")]
          .slice(0, 8)
          .map((o) => ({
            title: o.getAttribute("title"),
            height: o.getBoundingClientRect().height,
            avatar: o.querySelector(".employee-avatar")?.getBoundingClientRect()
              .width,
            label: o.querySelector(".ui-suggestion-label")?.textContent,
            labelBox: box(o.querySelector(".ui-suggestion-label")),
            metaBox: box(o.querySelector(".ui-suggestion-meta")),
          })),
      };
    });

  for (const [width, theme] of [
    [1440, "light"],
    [1440, "dark"],
    [390, "light"],
    [390, "dark"],
    [320, "light"],
  ]) {
    const tag = `${width}-${theme}`;
    await viewport(width, 1000, theme);
    await openBox(theme);
    await focusBox();
    await type("@");
    await until("document.querySelectorAll('[role=option]').length > 0");
    await settle();
    const open = await rows();
    await shot(`long-${tag}.png`);
    await type("测试");
    const longName = await rows();
    await shot(`longname-${tag}.png`);
    cases.push({ width, theme, open, longName });
  }

  if (!baseline) {
    await viewport(1440, 1000, "light");
    // 1. Escape on one comment, post it, then `@` in the next comment.
    await openBox("light");
    await focusBox();
    await type("@Bob");
    await until("document.querySelectorAll('[role=option]').length > 0");
    await key("Escape", "Escape", 27);
    const afterEscape = await options();
    await run(() =>
      [...document.querySelectorAll(".comment-box button")]
        .find((b) => b.textContent === "发表评论")
        ?.click(),
    );
    await until("document.querySelector('.comment-input').value === ''");
    await focusBox();
    await type("@");
    await until("document.querySelectorAll('[role=option]').length > 0");
    checks.escapeThenNextComment = {
      afterEscape,
      nextComment: (await options()).length,
    };
    await shot("check-next-comment-1440-light.png");

    // 2. The roster changes while the card stays open; a new `@` shows it.
    await key("Escape", "Escape", 27);
    const readsBefore = await evaluate("window.__c514Reads");
    await run(() => {
      window.__c514Roster = [
        {
          id: "E-6",
          name: "王姐",
          title: "运营",
          avatar: null,
          related: false,
        },
        { id: "E-7", name: "Ann", title: "测试", avatar: null, related: false },
      ];
    });
    await focusBox();
    await type("@");
    await until("[...document.querySelectorAll('[role=option]')].length === 2");
    checks.rosterRefresh = {
      options: await options(),
      reads: [readsBefore, await evaluate("window.__c514Reads")],
    };
    await type("A");
    checks.rosterRefresh.readsAfterTyping =
      await evaluate("window.__c514Reads");
    await shot("check-roster-1440-light.png");
    await run(() => {
      delete window.__c514Roster;
    });

    // 3. A name with spaces keeps filtering.
    await focusBox();
    await type("@Mary");
    await until("document.querySelectorAll('[role=option]').length === 2");
    const mary = await options();
    await type(" J");
    const maryJ = await options();
    await type("a");
    const maryJa = await options();
    await shot("check-spaces-1440-light.png");
    await key("Enter", "Enter", 13);
    const chosen = await value();
    await type("你好");
    checks.spaces = {
      mary,
      maryJ,
      maryJa,
      chosen,
      afterText: await options(),
      value: await value(),
    };

    // 4. The caret inside an existing mention: the whole name is replaced.
    await focusBox();
    await type("@Bob 请看");
    for (let i = 0; i < 5; i++) await key("ArrowLeft", "ArrowLeft", 37);
    const inside = await options();
    await shot("check-inside-1440-light.png");
    await key("Enter", "Enter", 13);
    checks.inside = {
      inside,
      value: await value(),
      caret: await evaluate(
        "document.querySelector('.comment-input').selectionStart",
      ),
    };
  }

  assert.deepEqual(browser.errors, []);
  const report = {
    head: git("rev-parse", "HEAD"),
    tree: git("rev-parse", "HEAD^{tree}"),
    dirty: git("status", "--porcelain") !== "",
    baseline: baseline ? git("rev-parse", baseline) : null,
    browser: await send("Browser.getVersion"),
    viewport:
      "1440/390/320 x 1000, DPR 1, prefers-reduced-motion: reduce; checks at 1440x1000 light",
    fixture:
      "test-support/c514-fixture.tsx?roster=long: 40 synthetic active employees (long names and titles, names with spaces); not production data",
    cases,
    checks,
  };
  await writeFile(
    resolve(output, "measurements.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  if (!baseline) {
    for (const c of cases) {
      const label = `${c.width}/${c.theme}`;
      for (const row of [...c.open.rows, ...c.longName.rows]) {
        // While the title keeps any room, the name is never cut for it.
        if (row.metaBox && row.metaBox.client > 0)
          assert.equal(row.labelBox.truncated, false, `${label}: ${row.label}`);
        assert(row.title?.startsWith(row.label), `${label}: title`);
      }
      assert(c.open.popover.inViewport, `${label}: in view`);
      assert(c.open.scrollWidth <= c.open.innerWidth, `${label}: overflow`);
    }
    assert.deepEqual(checks.escapeThenNextComment.afterEscape, []);
    assert(checks.escapeThenNextComment.nextComment > 0, "next comment");
    assert.deepEqual(checks.rosterRefresh.options, ["王姐", "Ann"]);
    assert.equal(
      checks.rosterRefresh.reads[1],
      checks.rosterRefresh.reads[0] + 1,
    );
    assert.equal(
      checks.rosterRefresh.readsAfterTyping,
      checks.rosterRefresh.reads[1],
    );
    assert.deepEqual(checks.spaces.maryJ, ["Mary Jane", "Mary Jo"]);
    assert.deepEqual(checks.spaces.maryJa, ["Mary Jane"]);
    assert.equal(checks.spaces.chosen, "@Mary Jane ");
    assert.deepEqual(checks.spaces.afterText, []);
    assert.equal(checks.inside.value, "@Bob 请看");
    assert.equal(checks.inside.caret, "@Bob ".length);
  }
} finally {
  await browser?.close();
  await server.close();
}
