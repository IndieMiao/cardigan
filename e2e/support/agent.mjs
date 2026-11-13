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
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
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
/** Runs this process already acted on; a merged bell can repeat one. */
const handledRuns = new Set();

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
  // `get_card` lists deliveries newest first; the whole list (superseded ones
  // included) tells us which round this Run belongs to.
  const history = (card.deliveries ?? []).filter(
    (delivery) =>
      delivery.work_item_id === item.id && delivery.kind !== "card_completion",
  );
  const latest = history[0];
  // A delivery that is still under review means someone else acts next.
  if (latest && ["submitted", "accepted"].includes(latest.status)) {
    log(`${who.role_id}: ${latest.id} is ${latest.status}, nothing to do`);
    return;
  }

  // Appendix A step 7: the second rework finds a product question. The Run asks
  // for the decision and ends blocked **without delivering** — a produce item
  // that is already delivered cannot end its own Run, so this must happen before
  // the next delivery, and the decision_resumed Run delivers D-3.
  if (
    who.role_id === "coder" &&
    history.length === 2 &&
    latest?.status === "rejected"
  ) {
    if ((card.open_decisions ?? []).length > 0) {
      log("coder: already waiting for the decision");
      return;
    }
    if (!existsSync(marker("decision-asked"))) {
      const asked = await call("request_decision", {
        idempotency_key: `${idempotencySalt}-decision-${runId}`,
        card_id: card.card_id ?? card.card.id,
        kind: "choose",
        category: "general",
        question: "返工发现需要改变产品行为：发布前是否补一次真机冒烟？",
        context: "第 2 轮返工发现现有验收标准覆盖不到起飞画面。",
        options: [
          {
            key: "smoke",
            description: "补一次真机冒烟再发布",
            impact: "推迟一天，覆盖空白帧",
          },
          {
            key: "ship",
            description: "按现状发布",
            impact: "空白帧留给下个版本",
          },
        ],
        recommended: "smoke",
        affected_cards: [card.card?.id ?? card.card_id],
        affected_work_items: [item.id],
        blocking: true,
        decider: "human",
        // C-202: a decision for the human carries a plain summary.
        plain_summary: {
          changed: "返工时发现起飞画面会闪一帧空白，现有验收标准没覆盖到",
          impact: "选补测会推迟一天发布；选照常发布，空白帧留到下个版本",
          risk: "无",
        },
      });
      mark("decision-asked");
      log(`coder: decision ${JSON.stringify(asked).slice(0, 160)}`);
      await finish(runId, "blocked", "等拍板：真机冒烟");
      mark(`done-${runId}`);
      return;
    }
    log("coder: decision already recorded, delivering the next version");
  }
  // One delivery per round; the count is the round number, so a resumed Run
  // after the decision continues from where the rework stopped.
  const round =
    (card.deliveries ?? []).filter(
      (delivery) =>
        delivery.work_item_id === item.id &&
        delivery.kind !== "card_completion",
    ).length + 1;

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
    // The first decision happens before D-3. Earlier screenshots are evidence;
    // the post-decision artifact records the approved basis read through MCP.
    const basis =
      round >= 3
        ? (
            await call("get_updates", { card_id: card.card.id, since_seq: 0 })
          ).events.find((event) => event.type === "decision_resolved")?.payload
            ?.decision_id
        : undefined;
    if (round >= 3 && !basis)
      throw new Error("D-3 artifact requires the recorded product decision");
    const uploaded = await call("upload_attachment", {
      idempotency_key: `${idempotencySalt}-attachment-${runId}`,
      card_id: card.card.id,
      file: PNG.toString("base64"),
      sha256: createHash("sha256").update(PNG).digest("hex"),
      mime: "image/png",
      kind: basis ? "artifact" : "evidence",
      ...(basis ? { basis } : {}),
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
  if (
    who.role_id === "reviewer" &&
    (!who.worktree_path || git("rev-parse", "HEAD") !== target.subject.value)
  ) {
    throw new Error(`Readonly reviewer checkout does not match ${target.id}`);
  }
  if (who.role_id === "reviewer") {
    mkdirSync(join(process.cwd(), "__pycache__"), { recursive: true });
    writeFileSync(
      join(process.cwd(), "__pycache__", `${target.id}.pyc`),
      "fixture test cache",
    );
    mark(`reviewer-cache-${target.id}`);
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
          : item.role_id === "reviewer"
            ? "code"
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
  // A stable marker for "the first test round already rejected", so later rounds
  // pass: the per-delivery marker above cannot be found by a fixed name.
  if (blocking) mark("tester-reject");
}

/** All required verifications passed and no completion request exists yet. */
function readyForCompletion(card) {
  const item = card.work_items.find((entry) => entry.id === who.work_item_id);
  if (!item || item.kind !== "produce") return false;
  const accepted = (entry) =>
    entry.kind === "produce"
      ? entry.status === "accepted"
      : entry.status === "passed";
  const pending = card.work_items.filter(
    (entry) =>
      entry.required &&
      entry.id !== item.id &&
      !(entry.kind === "verify" && entry.role_id === "pm") &&
      !accepted(entry),
  );
  const asked = (card.deliveries ?? []).some(
    (delivery) => delivery.kind === "card_completion",
  );
  return pending.length === 0 && !asked;
}

async function completionWork(card, runId) {
  const item = card.work_items.find((entry) => entry.id === who.work_item_id);
  const pmAcceptance = card.work_items.find(
    (entry) => entry.kind === "verify" && entry.role_id === "pm",
  );
  // The completion request binds to the current product delivery's subject.
  const product = currentDelivery(card, item?.id ?? "");
  if (!item || !pmAcceptance || !product) return false;
  const delivery = await call("submit_delivery", {
    idempotency_key: `${idempotencySalt}-completion-${runId}`,
    work_item_id: item.id,
    kind: "card_completion",
    summary: "所有必需项通过，申请完成",
    subject: product.subject,
    requested_verifiers: [pmAcceptance.id],
    // C-202: a completion request carries a plain change note.
    plain_summary: {
      changed: "所有必需的开发和验证都已通过，申请把这张卡合并",
      impact: "合并后新版本带上本卡的改动",
      risk: "无",
    },
  });
  log(`coder: completion ${JSON.stringify(delivery).slice(0, 160)}`);
  mark("completion");
  return true;
}

const cardIdFrom = (card) => card.card.id;

async function workOn(prompt) {
  const match = /run=(R-\d+)/u.exec(prompt);
  if (!match) {
    log(`no run in prompt: ${JSON.stringify(prompt.slice(0, 80))}`);
    return;
  }
  const runId = match[1];
  // Merged bells can deliver the same Run twice; the second prompt is stale by
  // definition and must not touch the (possibly closed) Run again.
  if (handledRuns.has(runId)) {
    log(`duplicate prompt for ${runId}, ignored`);
    return;
  }
  handledRuns.add(runId);
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
    if (item?.kind === "produce" && readyForCompletion(card)) {
      await completionWork(card, runId);
    } else if (item?.kind === "produce") await produceWork(card, runId);
    else if (who.role_id === "designer" || who.role_id === "reviewer")
      await reviewWork(card, runId, "pass");
    else if (who.role_id === "tester") {
      // Appendix A: 测试验收 rejects D-1 and D-2, then passes D-3. The round is
      // this verifier's review count, so the behaviour follows the delivery
      // stream instead of a marker that would drift.
      // Appendix A: the first two test rounds reject, the third passes. The
      // count comes from the timeline the server keeps for this work item, so
      // it cannot drift with superseded deliveries or agent restarts.
      // `since_seq: 0` is the full history; the default continues from the ACK
      // cursor, which would always look like the first round.
      const updates = await call("get_updates", {
        card_id: who.card_id,
        since_seq: 0,
      });
      const round =
        (updates.timeline ?? []).filter(
          (entry) =>
            entry.type === "review" && entry.work_item_id === who.work_item_id,
        ).length + 1;
      log(`tester: review round ${round}`);
      await reviewWork(card, runId, round <= 2 ? "reject" : "pass");
    } else if (who.role_id === "pm") await reviewWork(card, runId, "pass");
    await ack(who.card_id);
    await finish(runId, "completed", `${who.role_id} acted`);
    mark(`done-${runId}`);
    log(`finished ${runId}`);
  } catch (error) {
    const text = String(error);
    // A bell can arrive after this Agent already finished its Run (the Run is
    // closed, so no tool accepts another write); that is a stale prompt, not a
    // failure of the scenario.
    const stale =
      text.includes("Exactly one running Run is required") ||
      text.includes("Cannot apply complete to run:completed") ||
      text.includes("run:completed");
    log(`${stale ? "stale" : "error"} ${text}`);
    if (stale) return;
    try {
      await finish(runId, "failed", text.slice(0, 200));
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
