// Real browser contexts; no timers, delays, load generation, credentials or DB.

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { chromium } from "./chromium.mjs";

const source = stripTypeScriptTypes(
  await readFile(new URL("../src/shared-read.ts", import.meta.url), "utf8"),
);
let reads = 0;
const server = createServer((req, res) => {
  if (req.url === "/shared.js") {
    res.writeHead(200, { "Content-Type": "text/javascript" });
    res.end(source);
    return;
  }
  if (req.url === "/read") {
    reads++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ value: reads }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(
    `<script type="module">import {sharePendingRead} from '/shared.js'; window.read=(key='same')=>sharePendingRead('synthetic-session','synthetic-project',key,()=>fetch('/read').then(r=>r.json())); window.hold=(key)=>sharePendingRead('synthetic-session','synthetic-project',key,()=>{ parent.postMessage('holding',location.origin); return new Promise(()=>{}); }); window.ready=true;</script>`,
  );
});
let browser;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium();
  const url = `http://127.0.0.1:${server.address().port}`;
  await browser.send("Page.navigate", { url });
  await browser.evaluate(
    `new Promise(resolve=>{if(window.ready)resolve();else window.addEventListener('load',resolve,{once:true});})`,
  );
  await browser.evaluate(
    `new Promise(resolve=>{const frame=document.createElement('iframe');frame.src='/';frame.onload=()=>resolve();document.body.append(frame);})`,
  );
  const result = await browser.evaluate(
    `Promise.all([window.read(),frames[0].read()])`,
  );
  if (reads !== 1 || result[0].value !== 1 || result[1].value !== 1)
    throw new Error("Overlapping contexts did not share one request");
  const next = await browser.evaluate(
    `Promise.all([window.read('new-a'),frames[0].read('new-b')])`,
  );
  if (reads !== 3 || next[0].value === next[1].value)
    throw new Error("Invalidations were not isolated");
  await browser.evaluate(`window.read()`);
  if (reads !== 4) throw new Error("A completed response was retained");
  const recovered = await browser.evaluate(`new Promise(resolve=>{
    window.addEventListener('message', async function holding(event) {
      if(event.data!=='holding') return;
      window.removeEventListener('message',holding);
      const next=window.read('exit');
      document.querySelector('iframe').remove();
      resolve(await next);
    });
    frames[0].hold('exit');
  })`);
  if (reads !== 5 || recovered.value !== 5)
    throw new Error("Exited leader blocked another context");
  await browser.evaluate(
    `new Promise(resolve=>{const frame=document.createElement('iframe');frame.src='/';frame.onload=()=>resolve();document.body.append(frame);})`,
  );
  const resumed = await browser.evaluate(`new Promise(resolve=>{
    window.addEventListener('message', async function holding(event) {
      if(event.data!=='holding') return;
      window.removeEventListener('message',holding);
      const next=window.read('hidden-leader');
      const context=frames[0];
      Object.defineProperty(context.document,'hidden',{value:true,configurable:true});
      context.document.dispatchEvent(new context.Event('visibilitychange'));
      resolve(await next);
    });
    frames[0].hold('hidden-leader').catch(()=>{});
  })`);
  if (reads !== 6 || resumed.value !== 6)
    throw new Error("Hidden leader blocked another context");
  console.log(
    JSON.stringify({
      browser: "Chromium",
      contexts: 2,
      overlapping_network_reads: 1,
      isolated_network_reads: 2,
      fresh_network_reads: 1,
      exited_leader_recovered: true,
      hidden_leader_recovered: true,
      errors: browser.errors,
    }),
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
