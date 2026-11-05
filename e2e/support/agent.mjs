/**
 * The simulated Agent for the Appendix A end-to-end run (M5 plan §4 M5.5).
 *
 * It is a real process started by herdr-core through the launch wrapper, and it
 * speaks nothing but the Card MCP protocol: `whoami`, `get_card`, the delivery
 * and review tools, and `finish_run`. Each Run's bell arrives either as argv
 * (the first prompt) or on stdin (`hc send`), and the Agent decides what to do
 * from the card it reads — the same information a real Agent would have.
 *
 * Every action is logged to `$CARDIGAN_AGENT_DIR/agent.log`, and every completed
 * action leaves a marker file, so the test can wait for a step instead of
 * sleeping.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The SDK is resolved by the harness (it lives in `@cardigan/mcp-server`'s
// dependency tree, not at the repository root).
const { Client } = await import(process.env.CARDIGAN_E2E_SDK_CLIENT);
const { StreamableHTTPClientTransport } = await import(
  process.env.CARDIGAN_E2E_SDK_TRANSPORT
);

const stateDir = process.env.CARDIGAN_AGENT_DIR ?? "/tmp/cardigan-agent";
const idempotencySalt = process.env.CARDIGAN_E2E_SALT ?? "e2e";
mkdirSync(stateDir, { recursive: true });

const log = (line) => {
  writeFileSync(join(stateDir, "agent.log"), `${line}\n`, { flag: "a" });
};
const marker = (name) => join(stateDir, `marker-${name}`);
const mark = (name) => writeFileSync(marker(name), "1");

const client = new Client({ name: "appendix-a-agent", version: "1" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(process.env.CARDIGAN_MCP_URL), {
    requestInit: {
      headers: { Authorization: `Bearer ${process.env.MCP_TOKEN}` },
    },
  }),
);
const payload = (result) => JSON.parse(result.content[0].text);
const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError === true) {
    throw new Error(`${name} failed: ${JSON.stringify(result).slice(0, 300)}`);
  }
  return payload(result);
};
const ack = async (cardId) => {
  if (!cardId) return;
  const updates = await call("get_updates", { card_id: cardId });
  await call("ack_events", {
    card_id: cardId,
    up_to_seq: updates.latest_seq,
  });
};
const finish = async (runId, outcome, summary) => {
  await call("finish_run", {
    idempotency_key: `finish-${idempotencySalt}-${runId}-${outcome}`,
    run_id: runId,
    outcome,
    summary,
  });
};

/** `git` in the worktree the launch flow placed us in. */
const git = (...args) =>
  execFileSync(
    "git",
    [
      "-c",
      "user.name=appendix-agent",
      "-c",
      "user.email=agent@example.invalid",
      ...args,
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  ).trim();

const who = await call("whoami", {});
log(`whoami ${JSON.stringify(who)}`);

const currentDelivery = (card, workItemId) =>
  [...card.deliveries]
    .filter(
      (delivery) =>
        delivery.work_item_id === workItemId &&
        delivery.kind !== "card_completion" &&
        delivery.status !== "superseded",
    )
    .at(-1);

/** `get_card` reports reviews through the review matrix, not a review list. */
const reviewBy = (card, workItemId, deliveryId) =>
  (card.review_matrix ?? []).find(
    (row) =>
      row.work_item_id === workItemId &&
      row.delivery_id === deliveryId &&
      row.verdict !== null,
  );

/** The PNG the coder attaches as before/after evidence. */
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001" +
    "0d0a2db40000000049454e44ae426082",
  "hex",
);

async function produceWork(card, runId) {
  const item = card.work_items.find((entry) => entry.id === who.work_item_id);
  if (!item) {
    log(`${who.role_id}: no work item ${who.work_item_id}`);
    return;
  }
  const latest = currentDelivery(card, item.id);
  // A delivery that is still under review means someone else acts next.
  if (latest && ["submitted", "accepted"].includes(latest.status)) {
    log(`${who.role_id}: ${latest.id} is ${latest.status}, nothing to do`);
    return;
  }
  const round = existsSync(join(stateDir, `marker-${who.role_id}-1`)) ? 2 : 1;

  // A writing role works in the real worktree; every other produce item is a
  // document delivery, which needs no checkout.
  let subject = { kind: "doc_version", value: `${who.role_id}-v${round}` };
  if (!who.worktree_path && who.role_id === "coder") {
    log("coder: no worktree, cannot deliver a commit");
    return;
  }
  if (who.role_id === "coder") {
    const file = join(process.cwd(), `work-${round}.txt`);
    writeFileSync(file, `round ${round}\n`);
    git("add", ".");
    git("commit", "-qm", `round ${round}`);
    subject = { kind: "git_head", value: git("rev-parse", "HEAD") };
  }

  const verifiers = card.work_items
    .filter(
      (entry) =>
        entry.kind === "verify" && entry.target_work_item_id === item.id,
    )
    .map((entry) => entry.id);
  const delivery = await call("submit_delivery", {
    idempotency_key: `${idempotencySalt}-delivery-${runId}`,
    work_item_id: item.id,
    kind: who.role_id === "coder" ? "code" : "doc",
    summary: `第 ${round} 轮产出`,
    subject,
    // Required by the tool; an empty list is a produce item nobody verifies.
    requested_verifiers: verifiers,
  });
  log(`${who.role_id}: submitted ${JSON.stringify(delivery).slice(0, 200)}`);

  // Appendix A step 3: the delivery comes with a before/after attachment.
  if (who.role_id === "coder") {
    const uploaded = await call("upload_attachment", {
      idempotency_key: `${idempotencySalt}-attachment-${runId}`,
      card_id: card.card.id,
      file: PNG.toString("base64"),
      sha256: createHash("sha256").update(PNG).digest("hex"),
      mime: "image/png",
      kind: "evidence",
      attach_to: { kind: "delivery", id: delivery.delivery_id ?? delivery.id },
    });
    log(`coder: attachment ${JSON.stringify(uploaded).slice(0, 160)}`);
  }
  mark(`${who.role_id}-${round}`);
}

async function reviewWork(card, runId, verdict) {
  const item = card.work_items.find((entry) => entry.id === who.work_item_id);
  if (!item) {
    log(`${who.role_id}: no work item ${who.work_item_id}`);
    return;
  }
  const target =
    item.target_work_item_id === undefined
      ? [...card.deliveries]
          .filter(
            (delivery) =>
              delivery.kind === "card_completion" &&
              delivery.status === "submitted",
          )
          .at(-1)
      : currentDelivery(card, item.target_work_item_id);
  if (!target) {
    log(`${who.role_id}: nothing to review`);
    return;
  }
  if (target.status !== "submitted") {
    log(`${who.role_id}: ${target.id} is ${target.status}, nothing to review`);
    return;
  }
  if (reviewBy(card, item.id, target.id)) {
    log(`${who.role_id}: already reviewed ${target.id}`);
    return;
  }
  const rejections = existsSync(join(stateDir, "marker-tester-reject")) ? 1 : 0;
  const blocking = verdict === "reject";
  await call("submit_review", {
    idempotency_key: `${idempotencySalt}-review-${runId}-${item.id}`,
    delivery_id: target.id,
    target_sha: target.subject.value,
    kind:
      item.role_id === "designer"
        ? "design"
        : item.role_id === "pm"
          ? "product"
          : "test",
    issues: blocking
      ? [
          {
            severity: "major",
            description: "真机上起飞有空白帧",
            must_fix: true,
            pre_existing: false,
          },
        ]
      : [],
    attachments: [],
    recheck_required: blocking,
  });
  log(
    `${who.role_id}: reviewed ${target.id} (${blocking ? "reject" : "pass"}, rejections ${rejections})`,
  );
  mark(`${who.role_id}-${blocking ? "reject" : "pass"}-${target.id}`);
}

async function workOn(prompt) {
  const match = /run=(R-\d+)/u.exec(prompt);
  if (!match) {
    log(`no run in prompt: ${JSON.stringify(prompt.slice(0, 80))}`);
    return;
  }
  const runId = match[1];
  try {
    if (!who.card_id) {
      // A standing Assignment (PM Office / Ops) has no card; the scripted Agent
      // only acknowledges the prompt, recording is the test's job.
      log(
        `${who.role_id}: standing prompt ${JSON.stringify(prompt.slice(0, 60))}`,
      );
      await finish(runId, "completed", "standing prompt noted");
      mark(`done-${runId}`);
      return;
    }
    const card = await call("get_card", { card_id: who.card_id });
    const item = card.work_items.find((entry) => entry.id === who.work_item_id);
    if (item?.kind === "produce") await produceWork(card, runId);
    else if (who.role_id === "designer" || who.role_id === "reviewer")
      await reviewWork(card, runId, "pass");
    else if (who.role_id === "tester") {
      // §5 of the appendix: the first test round rejects, later rounds pass.
      const round = existsSync(join(stateDir, "marker-tester-reject"))
        ? "pass"
        : "reject";
      await reviewWork(card, runId, round);
    } else if (who.role_id === "pm") await reviewWork(card, runId, "pass");
    await ack(who.card_id);
    await finish(runId, "completed", `${who.role_id} acted`);
    mark(`done-${runId}`);
    log(`finished ${runId}`);
  } catch (error) {
    log(`error ${String(error)}`);
    try {
      await finish(runId, "failed", String(error).slice(0, 200));
    } catch {
      // The Run may already be closed; nothing else to do.
    }
  }
}

await workOn(process.argv.slice(2).join(" "));
// The hc idle marker: herdr-core reads this to know the Agent is waiting.
process.stdout.write(
  `${String.fromCharCode(27)}]7501;state=idle${String.fromCharCode(7)}`,
);

let buffer = "";
let queue = Promise.resolve();
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.includes("run=")) continue;
    queue = queue.then(() => workOn(line));
  }
});
setInterval(() => undefined, 1000);
void readFileSync;
