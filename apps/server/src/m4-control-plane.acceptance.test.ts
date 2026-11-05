/** M4.T2: public-flow expectations from plan §3.3/§3.6/§3.8, §16. */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { git, type M4Cross, m4Cross } from "../test-support/m4-cross.js";
import { CleanupExecutor } from "./cleanup-loop.js";

let f: M4Cross | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
}, 60_000);
const wait = <T>(read: () => T) =>
  expect.poll(read, { timeout: 10_000, interval: 30 });
const events = (s: M4Cross, type: string) =>
  s.state().events.filter((e) => e.type === type);
const decisions = (s: M4Cross) =>
  s.state().decisions.filter((d) => d.trigger === "worktree_cleanup");
async function accepted(options: Parameters<typeof m4Cross>[0] = {}) {
  const s = await m4Cross(options);
  f = s;
  const d = await s.deliver(
    s.primary,
    await s.change(s.primary.owner, "shared.txt", "delivery\n"),
  );
  expect(git(s.center, "rev-parse", `refs/cardigan/deliveries/${d.id}`)).toBe(
    d.subject.value,
  );
  await s.review(s.primary.verifier, d);
  await s.complete(d);
  expect(s.state().cards[0]?.status).toBe("awaiting_merge");
  return { s, d };
}

test.each(["missing", "other-branch"] as const)(
  "E01 §16: MCP refuses %s SHA without a delivery, event or candidate",
  async (kind) => {
    const s = await m4Cross();
    f = s;
    let sha = "f".repeat(40);
    if (kind === "other-branch") {
      const other = await s.extra();
      sha = await s.change(other.owner, "other.txt", "separate commit\n");
      await s.deliver(other, sha); // Object really exists in the host's center.
      expect(git(s.center, "cat-file", "-t", sha)).toBe("commit");
    }
    await s.start(s.primary.owner);
    const before = s.state(),
      refs = git(s.center, "show-ref");
    const result = await s.raw(s.primary.owner, "submit_delivery", {
      work_item_id: s.primary.owner.work_item_id,
      kind: "code",
      summary: "Untrusted SHA",
      subject: { kind: "git_head", value: sha },
      requested_verifiers: [s.primary.verifier.work_item_id],
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: "validation_failed" },
    });
    expect(s.state().deliveries).toEqual(before.deliveries);
    expect(events(s, "delivery_submitted")).toEqual(
      before.events.filter((e) => e.type === "delivery_submitted"),
    );
    const fixed = (text: string) =>
      text
        .split("\n")
        .filter((line) => /cardigan\/(candidates|deliveries)\//.test(line));
    expect(fixed(git(s.center, "show-ref"))).toEqual(fixed(refs));
  },
);

test.each([false, true])(
  "E02 §3.8: persisted confirmation merges, releases and cleans after restart (hc=%s)",
  async (hc) => {
    const { s, d } = await accepted({ hc });
    const path = s.path(s.primary.owner),
      oldToken = s.token(s.primary.owner);
    const initial = git(s.center, "rev-parse", "main");
    expect(await s.cli("merge", "status", s.card.id)).toContain(
      "awaiting_merge",
    );
    await s.confirm();
    expect(s.state().cards[0]?.status).toBe("awaiting_merge"); // No executor yet.
    await s.restart();
    await wait(() => s.state().cards[0]?.status).toBe("done");
    await wait(() => existsSync(path)).toBe(false);
    const head = git(s.center, "rev-parse", "main");
    expect(
      git(s.center, "rev-list", "--parents", "-n", "1", head).split(" "),
    ).toEqual([head, initial, d.subject.value]);
    for (const a of s.state().assignments)
      expect(a.status).toBe(a.scope === "standing" ? "active" : "released");
    expect(s.released).toContainEqual(s.current(s.primary.owner).runtime_ref);
    expect(s.store().verifyToken(oldToken as string)).toBeUndefined();
    for (const name of ["whoami", "get_card", "get_updates"]) {
      const response = await fetch(s.url(), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${oldToken}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: { card_id: s.card.id } },
        }),
      });
      expect(response.status).toBe(401);
      await response.body?.cancel();
    }
    await s.restart();
    expect(git(s.center, "rev-parse", "main")).toBe(head);
    expect(events(s, "card_merged")).toHaveLength(1);
    expect(decisions(s)).toHaveLength(0);
  },
  60_000,
);

test("E03 §3.8: merge conflict dispatches a fix Run; a new reviewed delivery completes the cycle", async () => {
  const { s } = await accepted();
  await writeFile(join(s.source, "shared.txt"), "upstream\n");
  git(s.source, "add", ".");
  git(s.source, "commit", "-qm", "Upstream advances");
  const upstream = git(s.source, "rev-parse", "HEAD");
  await s.confirm();
  await s.restart();
  await wait(() => events(s, "merge_conflicted").length).toBe(1);
  await wait(() =>
    s
      .state()
      .runs.some(
        (r) =>
          r.assignment_id === s.primary.owner.id &&
          r.kind === "fix" &&
          r.status === "dispatched",
      ),
  ).toBe(true);
  expect(s.state().cards[0]?.status).toBe("in_progress");
  expect(git(s.center, "rev-parse", "main")).toBe(upstream);
  expect(
    s.bells.some(
      (b) =>
        b.ref.terminal_ref ===
        s.current(s.primary.owner).runtime_ref?.terminal_ref,
    ),
  ).toBe(true);
  // Stop timers, preserving the actual Dispatcher-created fix Run.
  await s.restart(false);
  await s.start(s.primary.owner);
  git(s.path(s.primary.owner), "fetch", s.center, "main");
  git(
    s.path(s.primary.owner),
    "merge",
    "--no-edit",
    "-s",
    "ours",
    "FETCH_HEAD",
  );
  const next = await s.deliver(
    s.primary,
    git(s.path(s.primary.owner), "rev-parse", "HEAD"),
  );
  await s.review(s.primary.verifier, next);
  await s.complete(next);
  await s.confirm();
  await s.restart();
  await wait(() => s.state().cards[0]?.status).toBe("done");
  await wait(() => existsSync(s.path(s.primary.owner))).toBe(false);
  expect(events(s, "card_merged")).toHaveLength(1);
  expect(events(s, "merge_conflicted")).toHaveLength(1);
}, 30_000);

test("E04 §3.6: dirty worktree enters Needs You; keep survives restart without duplicate decisions or merges", async () => {
  const { s } = await accepted();
  const path = s.path(s.primary.owner);
  await writeFile(join(path, "shared.txt"), "unfinished\n");
  await s.confirm();
  await s.restart();
  await wait(() => decisions(s).length).toBe(1);
  const decision = decisions(s)[0];
  expect(decision?.status).toBe("open");
  expect(existsSync(path)).toBe(true);
  expect(await s.cli("needs-you")).toContain(decision?.key);
  expect(await s.cli("worktree", "diff", s.primary.owner.id)).toContain(
    "unfinished",
  );
  await s.restart();
  await wait(() => s.released.length).toBeGreaterThan(0);
  expect(decisions(s)).toHaveLength(1);
  await s.cli("worktree", "keep", s.primary.owner.id);
  await s.restart();
  await new CleanupExecutor({
    store: s.store(),
    git: s.binding(),
    runtime: s.runtime,
  }).tick();
  expect(decisions(s)).toHaveLength(1);
  expect(decisions(s)[0]?.resolution?.option).toBe("keep");
  expect(readFileSync(join(path, "shared.txt"), "utf8")).toBe("unfinished\n");
  expect(events(s, "card_merged")).toHaveLength(1);
}, 30_000);

test("E05 §3.6: force-clean records the human decision and saves a private patch", async () => {
  const { s } = await accepted();
  const path = s.path(s.primary.owner);
  await writeFile(join(path, "shared.txt"), "unfinished\n");
  await writeFile(join(path, "notes.txt"), "untracked\n");
  await s.confirm();
  await s.restart();
  await wait(() => decisions(s).length).toBe(1);
  await s.cli("worktree", "clean", s.primary.owner.id, "--force");
  await wait(() => existsSync(path)).toBe(false);
  const dir = join(s.dataDir, "cleanup", s.project.project_id),
    patches = readdirSync(dir);
  expect(patches).toHaveLength(1);
  const patch = join(dir, patches[0] as string);
  expect(statSync(patch).mode & 0o777).toBe(0o600);
  expect(readFileSync(patch, "utf8")).toContain("+unfinished");
  expect(readFileSync(patch, "utf8")).toContain("notes.txt");
  expect(decisions(s)[0]?.resolution).toMatchObject({
    option: "force_clean",
    resolved_by: "human",
    via: "needs_you",
  });
  await s.restart();
  expect(decisions(s)).toHaveLength(1);
}, 30_000);

test("E06 §14: Agent Git stays behind the execution entry throughout delivery, merge and cleanup", async () => {
  const { s } = await accepted({ agent: true });
  await writeFile(
    join(s.path(s.primary.owner), "shared.txt"),
    "uncommitted Agent edit\n",
  );
  expect(
    (
      await s.binding().diffWorktree({
        project: s.project,
        assignment: s.current(s.primary.owner),
      })
    ).patch,
  ).toContain("Agent edit");
  await s.agentRun(["-C", s.path(s.primary.owner), "restore", "shared.txt"]);
  await s.confirm();
  await s.restart();
  await wait(() => s.state().cards[0]?.status).toBe("done");
  await wait(() => existsSync(s.path(s.primary.owner))).toBe(false);
  const calls = readFileSync(s.trace, "utf8")
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as { side: string; cwd: string; args: string[] },
    );
  expect(
    calls.filter((c) => c.side === "host" && c.cwd?.startsWith(s.agentRoot)),
  ).toEqual([]);
  for (const command of ["status", "diff", "worktree", "branch"])
    expect(
      calls.some((c) => c.side === "agent" && c.args.includes(command)),
    ).toBe(true);
  expect(
    calls.some(
      (c) =>
        c.side === "agent" && c.args.some((a) => a.includes("upload-pack")),
    ),
  ).toBe(true);
  expect(
    calls.some(
      (c) =>
        c.side === "agent" && c.args.some((a) => a.includes("receive-pack")),
    ),
  ).toBe(true);
}, 60_000);

test("E07 §3.6: released Assignment cannot read while its token awaits revocation", async () => {
  const s = await m4Cross();
  f = s;
  await s.start(s.primary.owner);
  await s.finish(s.primary.owner);
  const token = s.token(s.primary.owner) as string;
  s.release(s.primary.owner); // Public command; cleanup has not run yet.
  expect(s.store().verifyToken(token)).toBeDefined();
  for (const name of ["whoami", "get_card", "get_updates"]) {
    const response = await fetch(s.url(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: { card_id: s.card.id } },
      }),
    });
    expect(response.status).toBe(401);
    await response.body?.cancel();
  }
});
