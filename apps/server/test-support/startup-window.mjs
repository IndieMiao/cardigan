/** C-583: a cold restart of both built roles and five minutes of ordinary,
 * sequential, authenticated board reads. Only creates a private synthetic DB. */
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { CentralRepositoryService } from "@cardigan/git-service";
import { CentralGitTransport } from "@cardigan/git-transport";
import { Store } from "@cardigan/store";
import { seedScenarios } from "./synthetic-scenarios.mjs";

process.umask(0o077);
const dir = mkdtempSync(join(tmpdir(), "w")),
  repo = join(dir, "source"),
  project = "synthetic";
const password = randomUUID(),
  children = [],
  abort = new AbortController();
const fd = process.env.CARDIGAN_PRIVATE_LIFETIME_FD;
const lifetime =
  fd === undefined
    ? undefined
    : new Socket({ fd: Number(fd), readable: true, writable: false });
lifetime
  ?.on("end", () => abort.abort())
  .on("error", () => abort.abort())
  .resume();
const env = {
  PATH: `${dir}:${process.env.PATH}`,
  TMPDIR: dir,
  HOME: dir,
  GIT_CONFIG_NOSYSTEM: "1",
  CARDIGAN_CONFIG_DIR: dir,
  CARDIGAN_DATA_DIR: dir,
  CARDIGAN_RUNTIME_MODE: "local",
  CARDIGAN_TICK_PROFILE: "1",
  CARDIGAN_MCP_PORT: "0",
  CARDIGAN_WEB_PORT: "0",
  CARDIGAN_HC_SESSION: "synthetic-window",
};
const git = (...args) =>
  execFileSync("git", args, {
    cwd: repo,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  })
    .toString()
    .trim();
const ticks = new Map(),
  errors = new Set();
async function start(entry) {
  const then = performance.now();
  const child = spawn(
    process.execPath,
    [new URL(`../dist/${entry}.js`, import.meta.url).pathname],
    { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const ready = Promise.withResolvers();
  const exited = new Promise((resolve) =>
    child.once("exit", (code) => {
      resolve(code);
      ready.reject(Error(`exit ${entry} ${code}`));
    }),
  );
  children.push({ child, exited });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  const timeout = setTimeout(() => ready.reject(Error("ready timeout")), 20000);
  createInterface({ input: child.stdout }).on("line", (line) => {
    let data;
    try {
      data = JSON.parse(line);
    } catch {
      return;
    }
    if (data.ready)
      ready.resolve({ ...data, ms: Math.round(performance.now() - then) });
    if (data.event === "tick_profile") {
      const a = ticks.get(data.loop) ?? [];
      a.push(data.wall_ms);
      ticks.set(data.loop, a);
      if (a.length === 1)
        console.log(
          JSON.stringify({
            first: data.loop,
            ms: data.wall_ms,
            spans: data.spans,
          }),
        );
    }
    if (data.dispatch_error && !errors.has(data.dispatch_error)) {
      if (!data.dispatch_error.includes(" slow tick: duration_ms="))
        errors.add(data.dispatch_error);
      console.error(data.dispatch_error);
    }
  });
  try {
    return await ready.promise;
  } finally {
    clearTimeout(timeout);
  }
}
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: values.length,
    p95: Math.round(sorted[Math.ceil(sorted.length * 0.95) - 1]),
    max: Math.round(sorted.at(-1)),
  };
}
try {
  mkdirSync(repo);
  git("init", "-q", "-b", "main");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=f@example.invalid",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "fixture",
  );
  const central = await new CentralRepositoryService(
    new CentralGitTransport({ dataDir: dir }),
    { dataDir: dir },
  ).ensureCentral({
    project_id: project,
    source_repo: repo,
    base_branch: "main",
  });
  mkdirSync(join(dir, "agent", "repos"), { recursive: true });
  git("clone", "-q", central, join(dir, "agent", "repos", project));
  writeFileSync(join(dir, "hc"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  writeFileSync(join(dir, "launch.yaml"), "providers: {}\nprofiles: {}\n");
  const store = Store.open({ dataDir: dir }),
    now = new Date().toISOString();
  const size = {
    cards: 580,
    work_items: 1920,
    runs: 10400,
    events: 165000,
    timeline: 27000,
    attachments: 4200,
    decisions: 1093,
  };
  store.createProject({ id: project });
  store.setProjectRepo({
    project_id: project,
    repo_path: repo,
    base_branch: "main",
  });
  store.setWebPassword(password);
  let seed = 583,
    serial = 0;
  const sha = git("rev-parse", "HEAD");
  mkdirSync(join(dir, "artifacts"));
  store.uow.run((tx) => {
    seedScenarios(tx, {
      size,
      project,
      now,
      random: () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0),
      eventId: () => `fixture-${++serial}`,
      avatar: null,
      blobs: [{ sha256: "a".repeat(64), size: 1 }],
    });
    // Historical work has finished; no external agents or unconsumed event flood.
    for (const c of tx.cards.list(project))
      tx.cards.put(project, {
        ...c,
        status: Number(c.id.slice(2)) <= 12 ? "backlog" : "done",
      });
    for (const a of tx.assignments.list(project))
      tx.assignments.put(project, {
        ...a,
        status: "released",
        runtime_state: "released",
        ...(a.scope === "work_item"
          ? { worktree_path: join(dir, "worktrees", a.id) }
          : {}),
      });
    for (const r of tx.runs.list(project))
      tx.runs.put(project, {
        ...r,
        status: "completed",
        outcome: "completed",
        finished_at: now,
      });
    for (const [i, a] of tx.attachments.list(project).slice(0, 160).entries()) {
      const blob_id = randomUUID();
      writeFileSync(join(dir, "artifacts", blob_id), "x");
      tx.attachments.put(project, {
        ...a,
        size: 1,
        storage_path: `artifacts/${blob_id}`,
        streamed_artifact: {
          blob_id,
          run_id: "R-1",
          created_at:
            i % 2
              ? now
              : new Date(Date.parse(now) - 40 * 86400000).toISOString(),
        },
      });
    }
    for (const d of tx.deliveries.list(project))
      if (d.subject.kind === "git_head") {
        tx.deliveries.put(project, {
          ...d,
          subject: { kind: "git_head", value: sha },
        });
        git(
          "--git-dir",
          join(dir, "central", `${project}.git`),
          "update-ref",
          `refs/cardigan/deliveries/${d.id}`,
          sha,
        );
      }
  });
  for (const { stream, seq } of store.database
    .prepare("SELECT stream,MAX(seq) AS seq FROM events GROUP BY stream")
    .all())
    store.advanceRouterCursor(project, stream, seq);
  mkdirSync(join(dir, "attachments"));
  for (let i = 0; i < 4200; i++)
    writeFileSync(
      join(dir, "attachments", i.toString(16).padStart(64, "0")),
      "x",
    );
  const counts = Object.fromEntries(
    [...Object.keys(size), "assignments"].map((t) => [
      t,
      store.database.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n,
    ]),
  );
  console.log(JSON.stringify({ counts }));
  store.close();
  const web = await start("bin"),
    url = web.web_url;
  const login = await fetch(`${url}/api/login`, {
    method: "POST",
    headers: { origin: url, "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!login.ok) throw Error(`login ${login.status}`);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  env.CARDIGAN_MCP_PORT = new URL(web.url).port;
  env.CARDIGAN_WEB_PORT = new URL(url).port;
  const begin = performance.now(),
    bg = start("background-bin"),
    samples = [];
  const probe = async () => {
    do {
      const start = performance.now();
      const res = await fetch(
        `${url}/api/projects/${project}/cards?view=summary&mode=board&limit=10`,
        {
          headers: { cookie },
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(20000)]),
        },
      );
      if (!res.ok) throw Error(`board ${res.status}`);
      await res.arrayBuffer();
      samples.push(performance.now() - start);
      await delay(2000, undefined, { signal: abort.signal });
    } while (performance.now() - begin < 300000);
  };
  const [background] = await Promise.all([bg, probe()]);
  const report = {
    web_ready_ms: web.ms,
    background_ready_ms: background.ms,
    window_ms: Math.round(performance.now() - begin),
    web: stats(samples),
    ticks: Object.fromEntries([...ticks].map(([k, v]) => [k, stats(v)])),
  };
  console.log(JSON.stringify(report));
  if (
    errors.size ||
    report.web.p95 > 2000 ||
    ["dispatcher", "cleanup", "reconcile", "attachments", "run_resource"].some(
      (loop) => !report.ticks[loop] || report.ticks[loop].max > 3000,
    )
  )
    throw Error("Incomplete or slow window");
} finally {
  abort.abort();
  for (const { child } of children.reverse()) child.kill("SIGTERM");
  await Promise.all(children.map((c) => c.exited));
  lifetime?.destroy();
  rmSync(dir, { recursive: true, force: true });
}
