// Real App + HTTP client + SQLite projection; controlled response ordering,
// not a performance test. No production configuration or background loops.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";
import { Store } from "../../../packages/store/dist/index.js";
import { readNeedsState } from "../../server/dist/web/needs-state.js";
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
  notifyHeld;
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
                ],
              });
              return;
            }
            if (url.pathname === `/api/projects/${FIXTURE_PROJECT}/needs-you`) {
              reads++;
              const value = {
                project_id: FIXTURE_PROJECT,
                ...needsYou(
                  readNeedsState(store, FIXTURE_PROJECT),
                  FIXTURE_NOW,
                  "enabled",
                ),
              };
              if (arm) {
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
  await browser.send("Page.navigate", { url });
  await browser.evaluate(
    `new Promise(resolve=>{if(window.raceDrain)resolve();else window.addEventListener('load',resolve,{once:true});}).then(()=>window.raceDrain())`,
  );
  await browser.evaluate(
    `new Promise(resolve=>{const f=document.createElement('iframe');f.src=${JSON.stringify(url)};f.onload=resolve;document.body.append(f);}).then(()=>frames[0].raceDrain())`,
  );
  const started = new Promise((resolve) => {
    notifyHeld = resolve;
  });
  arm = true;
  await browser.evaluate(
    `window.raceStream.change({stream:'C-2',seq:100,type:'decision_requested'})`,
  );
  await started;
  store.uow.run((tx) => {
    const q = tx.decisions.get(FIXTURE_PROJECT, "Q-2");
    tx.decisions.put(FIXTURE_PROJECT, {
      ...q,
      id: "Q-90001",
      card_id: "C-1",
      question: "Synthetic newest decision",
      status: "open",
    });
  });
  await browser.evaluate(
    `frames[0].raceStream.change({stream:'C-1',seq:100,type:'decision_requested'});frames[0].raceStream.change({stream:'C-2',seq:100,type:'decision_requested'});frames[0].raceWait(()=>frames[0].raceCalls.length>=2)`,
  );
  await browser.evaluate(
    `window.raceStream.change({stream:'C-1',seq:100,type:'decision_requested'});window.raceWait(()=>window.raceCalls.length>=3 && window.raceCalls.at(-1).result===213)`,
  );
  held.res.end(held.body);
  held = undefined;
  await browser.evaluate(
    `Promise.all([window.raceDrain(),frames[0].raceDrain()])`,
  );
  const observed = await browser.evaluate(`(async()=>{
    const snapshot=w=>({calls:w.raceCalls,count:Number([...(w.document.querySelector('a[href$="/needs-you"]')?.textContent??'')].filter(c=>c>='0'&&c<='9').join('')),newDecisionPresent:w.document.body.textContent.includes('Synthetic newest decision')});
    await window.raceWait(()=>snapshot(window).newDecisionPresent);
    await frames[0].raceWait(()=>snapshot(frames[0]).newDecisionPresent);
    return {a:snapshot(window),b:snapshot(frames[0]),locks:await navigator.locks.query()};
  })()`);
  if (
    !observed.a.newDecisionPresent ||
    !observed.b.newDecisionPresent ||
    observed.a.count !== 214 ||
    observed.b.count !== 214 ||
    observed.a.calls[1].key === observed.b.calls[1].key
  )
    throw new Error(
      `Cross-stream response regression: ${JSON.stringify(observed)}`,
    );
  const reconnect = await browser.evaluate(`(async()=>{
    window.raceStream.ready(); frames[0].raceStream.ready();
    await Promise.all([window.raceWait(()=>window.raceCalls.length>=4),frames[0].raceWait(()=>frames[0].raceCalls.length>=3)]);
    await Promise.all([window.raceDrain(),frames[0].raceDrain()]);
    return {a:window.raceCalls.at(-1),b:frames[0].raceCalls.at(-1)};
  })()`);
  if (
    reconnect.a.result !== 213 ||
    reconnect.b.result !== 213 ||
    JSON.parse(reconnect.a.key)[0] !== 1 ||
    reconnect.a.key !== reconnect.b.key
  )
    throw new Error("Reconnect version regression");
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
        reconnect,
        ...observed,
        browserErrors: browser.errors,
      },
      null,
      2,
    ),
  );
} finally {
  held?.res.destroy();
  await browser?.close();
  await server?.close();
  store?.close();
  await rm(directory, { recursive: true, force: true });
}
