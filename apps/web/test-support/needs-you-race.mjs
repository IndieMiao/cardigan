// Real App + HTTP client + SQLite projection; controlled response ordering,
// not a performance test. No production configuration or background loops.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";
import { Store } from "../../../packages/store/dist/index.js";
import { readNeedsState } from "../../server/dist/web/needs-state.js";
import { readNeedsVersion } from "../../server/dist/web/needs-version.js";
import { needsYou } from "../../server/dist/web/read.js";
import {
  FIXTURE_NOW,
  FIXTURE_PROJECT,
  generateFixture,
} from "../../server/test-support/synthetic-fixture.mjs";
import { chromium } from "./chromium.mjs";

const directory = await mkdtemp(join(tmpdir(), "needs-race-"));
let store,
  server,
  browser,
  held,
  arm = false,
  reads = 0,
  notifyHeld,
  holdInitial = false,
  initialHeld,
  notifyInitial;
try {
  const data = join(directory, "data");
  const manifest = await generateFixture({ out: data, profile: "needs-you" });
  store = Store.open({ dataDir: data });
  server = await createServer({
    root: resolve("apps/web"),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "needs-race-synthetic",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            const evaluate = browser.evaluate.bind(browser);
            browser.evaluate = async (expression) => {
              try {
                return await evaluate(expression);
              } catch (error) {
                console.error(
                  "Browser stage failed:",
                  expression.slice(0, 260),
                );
                console.error(
                  await evaluate(
                    `(async()=>JSON.stringify({calls:window.raceCalls,frameCalls:frames[0]?.raceCalls,text:document.body.textContent.slice(0,300),locks:await navigator.locks.query()}))()`,
                  ),
                );
                throw error;
              }
            };
            const url = new URL(req.url, "http://fixture.invalid");
            const send = (data, status = 200) => {
              res.writeHead(status, {
                "Content-Type": "application/json",
                "Cache-Control": "no-store",
              });
              res.end(JSON.stringify(data));
            };
            if (url.pathname === "/__race") {
              res.setHeader("Content-Type", "text/html");
              res.end(
                await vite.transformIndexHtml(
                  "/__race",
                  '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test-support/needs-you-race.tsx"></script></body></html>',
                ),
              );
              return;
            }
            if (url.pathname === "/api/session") {
              send({
                authenticated: true,
                password_configured: true,
                read_scope: "synthetic-race-scope",
              });
              return;
            }
            if (url.pathname === "/api/projects") {
              send({
                projects: [
                  {
                    id: FIXTURE_PROJECT,
                    name: "Synthetic regression",
                    created_at: FIXTURE_NOW,
                  },
                  {
                    id: "synthetic-empty",
                    name: "Empty synthetic",
                    created_at: FIXTURE_NOW,
                  },
                ],
              });
              return;
            }
            if (url.pathname.endsWith("/needs-you/version")) {
              const project = decodeURIComponent(url.pathname.split("/")[3]);
              send({
                read_scope: "synthetic-race-scope",
                revision: readNeedsVersion(
                  store,
                  project,
                  "synthetic-enabled",
                  FIXTURE_NOW,
                ),
                at: FIXTURE_NOW,
              });
              return;
            }
            const full = /^\/api\/projects\/([^/]+)\/needs-you$/.exec(
              url.pathname,
            );
            if (full) {
              const project = decodeURIComponent(full[1]);
              reads++;
              res.setHeader("X-Cardigan-Read-Scope", "synthetic-race-scope");
              res.setHeader("X-Cardigan-Read-At", FIXTURE_NOW);
              const value = {
                project_id: project,
                ...needsYou(
                  readNeedsState(store, project),
                  FIXTURE_NOW,
                  "enabled",
                ),
              };
              if (holdInitial) {
                holdInitial = false;
                res.writeHead(200, {
                  "Content-Type": "application/json",
                  "Cache-Control": "no-store",
                });
                initialHeld = { res, body: JSON.stringify(value) };
                notifyInitial();
              } else if (arm) {
                arm = false;
                res.writeHead(200, {
                  "Content-Type": "application/json",
                  "Cache-Control": "no-store",
                });
                held = { res, body: JSON.stringify(value) };
                notifyHeld();
              } else send(value);
              return;
            }
            if (url.pathname.startsWith("/api/")) {
              send(
                {
                  error: {
                    code: "synthetic_scope",
                    message: "Synthetic read fixture",
                  },
                },
                404,
              );
              return;
            }
            next();
          });
        },
      },
    ],
  });
  await server.listen();
  browser = await chromium();
  const url = `${server.resolvedUrls.local[0]}__race#/p/${FIXTURE_PROJECT}/needs-you`;
  const openA = async () => {
    await browser.send("Page.navigate", { url });
    await browser.evaluate(
      `new Promise(resolve=>{if(window.raceDrain)resolve();else window.addEventListener('load',resolve,{once:true});}).then(()=>window.raceDrain())`,
    );
  };
  const openB = async (drain = true) => {
    await browser.evaluate(
      `new Promise(resolve=>{const f=document.createElement('iframe');f.src=${JSON.stringify(url)};f.onload=resolve;document.body.append(f);})${drain ? ".then(()=>frames[0].raceDrain())" : ""}`,
    );
  };
  const emit = (who, events) =>
    browser.evaluate(`{
    const w=${who};
    for(const [stream,seq] of ${JSON.stringify(events)}) w.raceStream.change({stream,seq,type:'decision_requested'});
  }`);
  const settled = () =>
    browser.evaluate(
      `Promise.all([window.raceDrain(),...Array.from(frames).map(w=>w.raceDrain())])`,
    );
  const waitCall = (who, count, result) =>
    browser.evaluate(
      `${who}.raceWait(()=>${who}.raceCalls.length>=${count}${result === undefined ? "" : ` && ${who}.raceCalls.at(-1).result===${result}`})`,
    );
  const armRead = () => {
    arm = true;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Held request did not start")),
        30000,
      );
      timer.unref();
      notifyHeld = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  };
  const release = () => {
    held.res.end(held.body);
    held = undefined;
  };
  let serial = 90000;
  const add = () =>
    store.uow.run((tx) => {
      const q = tx.decisions.get(FIXTURE_PROJECT, "Q-2");
      tx.decisions.put(FIXTURE_PROJECT, {
        ...q,
        id: `Q-${++serial}`,
        card_id: "C-1",
        question: `Synthetic newest decision ${serial}`,
        status: "open",
      });
    });
  const bump = () =>
    store.uow.run((tx) =>
      tx.events.append(FIXTURE_PROJECT, {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(FIXTURE_PROJECT),
        type: "fixture_observed",
        actor: { kind: "system", project_id: FIXTURE_PROJECT },
        payload: { synthetic: true },
        created_at: FIXTURE_NOW,
      }),
    );
  const sourceCount = () =>
    needsYou(readNeedsState(store, FIXTURE_PROJECT), FIXTURE_NOW, "enabled")
      .decisions.length;
  const capture = async () =>
    browser.evaluate(`(async()=>{
    const count=w=>Number([...(w.document.querySelector('a[href$="/needs-you"]')?.textContent??'')].filter(c=>c>='0'&&c<='9').join(''));
    await window.raceWait(()=>count(window)===window.raceCalls.at(-1).result+1);
    await frames[0].raceWait(()=>count(frames[0])===frames[0].raceCalls.at(-1).result+1);
    return {a:{calls:window.raceCalls,count:count(window)},b:{calls:frames[0].raceCalls,count:count(frames[0])},locks:await navigator.locks.query()};
  })()`);
  const scenarios = [];

  // Original cross-stream delayed-response counterexample.
  await openA();
  await openB();
  bump();
  let base = sourceCount();
  let started = armRead();
  await emit("window", [["C-2", 100]]);
  await started;
  add();
  await emit("frames[0]", [
    ["C-1", 100],
    ["C-2", 100],
  ]);
  await waitCall("frames[0]", 2, base + 1);
  await emit("window", [["C-1", 100]]);
  await waitCall("window", 3, base + 1);
  release();
  await settled();
  let observed = await capture();
  if (
    observed.a.calls.at(-1).result !== base + 1 ||
    observed.b.calls.at(-1).result !== base + 1 ||
    observed.a.count !== observed.b.count
  )
    throw new Error("Cross-stream regression");
  scenarios.push({ scenario: "cross-stream-delayed-response", ...observed });

  // A ready read from an earlier snapshot must not rewind a late page's initial read.
  await openA();
  base = sourceCount();
  bump();
  started = armRead();
  await browser.evaluate(`window.raceStream.ready()`);
  await started;
  add();
  const initialStarted = new Promise((resolve) => {
    notifyInitial = resolve;
  });
  holdInitial = true;
  await openB(false);
  await initialStarted;
  await browser.evaluate(`frames[0].raceStream.ready()`);
  await waitCall("frames[0]", 2);
  initialHeld.res.end(initialHeld.body);
  initialHeld = undefined;
  await waitCall("frames[0]", 2, base + 1);
  await emit("window", [["C-1", 200]]);
  await waitCall("window", 3, base + 1);
  release();
  await settled();
  observed = await capture();
  if (
    observed.b.calls.at(-1).result !== base + 1 ||
    observed.a.count !== observed.b.count
  )
    throw new Error("Late ready response rewound new data");
  scenarios.push({
    scenario: "late-initial-and-ready-delayed-response",
    ...observed,
  });

  // Sequential event delivery must reuse one result even for different local histories.
  const oneRefresh = async (label) => {
    const before = reads,
      expected = sourceCount() + 1;
    const lengths = await browser.evaluate(
      `[window.raceCalls.length,frames[0].raceCalls.length]`,
    );
    add();
    await emit("window", [["C-3", ++serial]]);
    await waitCall("window", lengths[0] + 1, expected);
    // Deliberately deliver B only AFTER A's full read has completed.
    await emit("frames[0]", [["C-3", serial]]);
    await waitCall("frames[0]", lengths[1] + 1, expected);
    await settled();
    const value = await capture();
    if (reads - before !== 1 || value.a.count !== value.b.count)
      throw new Error(`${label}: duplicate full read`);
    scenarios.push({ scenario: label, full_reads: reads - before, ...value });
  };
  await emit("window", [["historical", 1]]);
  await settled();
  await oneRefresh("late-page-with-different-history");
  // Changing projects destroys the local cache; returning can adopt A's validated revision.
  await browser.evaluate(
    `frames[0].location.hash='#/p/synthetic-empty/needs-you';frames[0].raceWait(()=>frames[0].raceCalls.at(-1)?.project==='synthetic-empty' && frames[0].raceCalls.at(-1)?.result===0)`,
  );
  await browser.evaluate(
    `frames[0].location.hash='#/p/synthetic/needs-you';frames[0].raceWait(()=>frames[0].raceCalls.at(-1)?.project==='synthetic' && frames[0].raceCalls.at(-1)?.result!==undefined)`,
  );
  await settled();
  await oneRefresh("project-return-with-different-history");
  await browser.evaluate(
    `{const n=frames[0].raceCalls.length;frames[0].raceStream.ready();frames[0].raceWait(()=>frames[0].raceCalls.length>n && frames[0].raceCalls.at(-1)?.result!==undefined)}`,
  );
  await settled();
  await oneRefresh("reconnect-with-different-history");
  const beforeHidden = reads,
    expectedAfterHidden = sourceCount() + 1;
  const countsBefore = await browser.evaluate(
    `[window.raceCalls.length,frames[0].raceCalls.length]`,
  );
  await browser.evaluate(
    `Object.defineProperty(document,'hidden',{value:true,configurable:true});document.dispatchEvent(new Event('visibilitychange'))`,
  );
  add();
  await emit("frames[0]", [["C-4", ++serial]]);
  await waitCall("frames[0]", countsBefore[1] + 1, expectedAfterHidden);
  await browser.evaluate(
    `Object.defineProperty(document,'hidden',{value:false,configurable:true});document.dispatchEvent(new Event('visibilitychange'))`,
  );
  await waitCall("window", countsBefore[0] + 1, expectedAfterHidden);
  await settled();
  observed = await capture();
  if (reads - beforeHidden !== 1 || observed.a.count !== observed.b.count)
    throw new Error("Hidden owner handoff failed");
  scenarios.push({
    scenario: "hidden-owner-and-restored-page",
    full_reads: reads - beforeHidden,
    ...observed,
  });
  console.log(
    JSON.stringify(
      {
        synthetic: true,
        gate: "enabled",
        rows: Object.fromEntries(
          [
            "cards",
            "events",
            "timeline",
            "notifications",
            "decisions",
            "runs",
          ].map((t) => [t, manifest.tables[t].count]),
        ),
        reads,
        scenarios,
        browserErrors: browser.errors,
      },
      null,
      2,
    ),
  );
} finally {
  held?.res.destroy();
  initialHeld?.res.destroy();
  await browser?.close();
  await server?.close();
  store?.close();
  await rm(directory, { recursive: true, force: true });
}
