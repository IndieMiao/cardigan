// Synthetic browser regression entry; never imported by the product bundle.
import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import { HttpCardiganClient } from "../src/api.js";
import type { StreamCallbacks } from "../src/stream.js";
import "../src/styles.css";

declare global {
  interface Window {
    raceStream?: StreamCallbacks;
    raceCalls: { key?: string; project: string; result?: number }[];
    raceWait: (predicate: () => boolean) => Promise<void>;
    raceDrain: () => Promise<void>;
  }
}
Date.now = () => Date.parse("2026-06-15T12:00:00.000Z");
const client = new HttpCardiganClient();
client.subscribe = (_project, callbacks) => {
  window.raceStream = callbacks;
  callbacks.status("live");
  return () => {
    window.raceStream = undefined;
  };
};
window.raceCalls = [];
const read = client.needsYou.bind(client);
client.needsYou = (project, key) => {
  const call: { key?: string; project: string; result?: number } =
    key === undefined ? { project } : { project, key };
  window.raceCalls.push(call);
  window.dispatchEvent(new Event("race-read"));
  return read(project, key).then((data) => {
    call.result = data.decisions.length;
    window.dispatchEvent(new Event("race-read"));
    return data;
  });
};
window.raceWait = (predicate) =>
  new Promise((resolve) => {
    const check = () => {
      if (!predicate()) return;
      observer.disconnect();
      window.removeEventListener("race-read", check);
      resolve();
    };
    const observer = new MutationObserver(check);
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    window.addEventListener("race-read", check);
    check();
  });
window.raceDrain = async () => {
  await window.raceWait(
    () =>
      window.raceCalls.length > 0 &&
      window.raceCalls.every((c) => c.result !== undefined),
  );
  // Other contexts can intentionally hold older reads; drain only this page.
};
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<App client={client} />);
