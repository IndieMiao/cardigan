// biome-ignore-all lint/suspicious/noExplicitAny: the scripted scenario reads a
// few fields out of large tool payloads; pinning every response shape here
// would duplicate the MCP surface without testing anything extra.
/**
 * Appendix A, steps 1–5 (M5 plan §4 M5.5; development plan 附录 A).
 *
 * Real server, real herdr-core, real Git and scripted Agents that only speak the
 * Card MCP protocol: the human asks PM Office for a feature, PM Office creates
 * the card with the five work items, product confirmation unlocks development,
 * PM Ops assigns the coder and the host builds a worktree and branch, the coder
 * delivers with an attachment, and the two verification Assignments are woken to
 * pass and reject it — all without interrupting the human.
 *
 * Steps 6–12 (rework, the decision, the resumed Run, completion, the merge
 * confirmation, cleanup, the snapshot and the restart criterion) follow in the
 * next PR of this milestone.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createHarness, type E2eHarness, PROJECT } from "./support/harness.js";

const HC_VERSION = "0.1.18";

const hcVersion = (() => {
  try {
    return execFileSync("hc", ["--version"], { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
})();

if (hcVersion !== `hc ${HC_VERSION}`) {
  // A visible note, not a silent skip: the run needs the pinned runtime.
  process.stdout.write(
    `[e2e] 跳过附录 A：需要 hc ${HC_VERSION}，当前是 ${hcVersion ?? "未安装"}\n`,
  );
}

type ToolResult = {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content: { text: string }[];
};

const READ_ONLY = new Set([
  "whoami",
  "get_card",
  "get_updates",
  "project_snapshot",
  "list_needs_you",
]);
let keyCounter = 0;

/** Call a tool; write tools get a fresh idempotency key, like a real caller. */
const call = async (
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, any>> => {
  keyCounter += 1;
  const withKey = READ_ONLY.has(name)
    ? args
    : { idempotency_key: `appendix-a-${keyCounter}`, ...args };
  const result = (await client.callTool({
    name,
    arguments: withKey,
  })) as ToolResult;
  if (result.isError === true) {
    throw new Error(`${name} failed: ${JSON.stringify(result)}`);
  }
  return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, any>;
};

/** The token `cardigan pm create` prints, or `token issue` for an Assignment. */
const lastLine = (text: string): string =>
  (text.split("\n").at(-1) ?? "").trim();

describe.skipIf(hcVersion !== `hc ${HC_VERSION}`)(
  "附录 A：卡片从需求到合并的完整流程（前半）",
  () => {
    let h: E2eHarness;
    let office: Client;
    let ops: Client;
    let cardId: string;

    beforeAll(async () => {
      h = await createHarness();
      office = await h.connect(
        lastLine(await h.cardigan("pm", "create", "--office")),
      );
      ops = await h.connect(
        lastLine(await h.cardigan("pm", "create", "--ops")),
      );
    }, 180_000);

    afterAll(async () => {
      await h.close();
    }, 180_000);

    const items = () =>
      h.state().work_items.filter((item) => item.card_id === cardId);
    const itemByRole = (role: string, kind: "produce" | "verify") =>
      items().find((item) => item.role_id === role && item.kind === kind);
    const assignmentFor = (workItemId: string) =>
      h
        .state()
        .assignments.find(
          (assignment) =>
            assignment.scope === "work_item" &&
            assignment.work_item_id === workItemId,
        );
    const events = (card: string) =>
      h.store.uow.read((tx) => tx.events.listAfter(PROJECT, card as never, 0));
    const needsYou = () =>
      h.store.listNotifications({
        project_id: PROJECT,
        recipient_kind: "needs_you",
      });

    test("准 备：PM Office 与 Ops 的 Token 都可用", async () => {
      const o = await call(office, "whoami");
      expect(o.role_id).toBe("pm");
      expect(o.scope).toBe("standing");
      const p = await call(ops, "whoami");
      expect(p.role_id).toBe("pm");
      expect(p.scope).toBe("standing");
      expect(o.assignment_id).not.toBe(p.assignment_id);
      const snapshot = await call(ops, "project_snapshot");
      expect(snapshot.cards).toEqual([]);
    }, 60_000);

    test("第 1 步：PM Office 建卡，工作项按附录 A 的五项", async () => {
      const card = await call(office, "create_card", {
        title: "0.2.5 发版后的相关改动与验收",
        goal: "把 0.2.5 之后的改动带上真机验收",
        acceptance_criteria: ["真机上没有空白帧"],
        source: { kind: "quote", text: "在 PM Office 里说的原话" },
        repo: "example/repo",
        base_branch: "main",
        template: "dev",
      });
      cardId = card.card_id ?? card.id;
      expect(cardId).toMatch(/^C-\d+$/u);

      const development = itemByRole("coder", "produce");
      const pmAcceptance = itemByRole("pm", "verify");
      expect(development).toBeDefined();
      expect(pmAcceptance).toBeDefined();

      const product = await call(office, "create_work_item", {
        card_id: cardId,
        title: "产品确认",
        kind: "produce",
        role_id: "pm",
        required: true,
        completion_criteria: ["需求确认"],
      });
      const productId = product.work_item_id ?? product.id;
      expect(productId).toMatch(/^W-\d+$/u);

      // 设计走查 verifies the product confirmation: every delivery must request
      // at least one required verifier, and the appendix gives 产品确认 no other
      // verification step of its own.
      await call(office, "create_work_item", {
        card_id: cardId,
        title: "设计走查",
        kind: "verify",
        role_id: "designer",
        required: true,
        completion_criteria: ["视觉走查通过"],
        target_work_item_id: productId,
      });
      await call(office, "create_work_item", {
        card_id: cardId,
        title: "测试验收",
        kind: "verify",
        role_id: "tester",
        required: true,
        completion_criteria: ["真机回归通过"],
        target_work_item_id: development?.id,
      });

      // The dev template also ships a code review item; the template's required
      // items cannot be disabled, so the reviewer walked the development
      // delivery as a third verification.
      const codeReview = items().find(
        (item) => item.role_id === "reviewer" && item.kind === "verify",
      );
      expect(codeReview).toBeDefined();

      const roles = items().map(
        (item) => `${item.title}:${item.role_id}:${item.kind}`,
      );
      expect(roles.sort()).toEqual(
        [
          "产品确认:pm:produce",
          "开发:coder:produce",
          "代码审核:reviewer:verify",
          "PM 验收:pm:verify",
          "测试验收:tester:verify",
          "设计走查:designer:verify",
        ].sort(),
      );
    }, 120_000);

    test("第 2 步：产品确认完成后开发 ready，PM Ops 指派 coder，主机建 worktree 并按门铃", async () => {
      const product = itemByRole("pm", "produce");
      const development = itemByRole("coder", "produce");
      const designerItem = itemByRole("designer", "verify");
      expect(product).toBeDefined();
      expect(development).toBeDefined();
      expect(designerItem?.target_work_item_id).toBe(product?.id);

      // PM Ops assigns the product confirmation and its design walkthrough;
      // the host starts both Assignments.
      await call(ops, "assign", {
        work_item_id: product?.id,
        role_id: "pm",
      });
      await call(ops, "assign", {
        work_item_id: designerItem?.id,
        role_id: "designer",
      });
      for (const item of [product, designerItem]) {
        const assignment = assignmentFor(item?.id as string);
        expect(assignment).toBeDefined();
        await h.startAssignment(assignment?.id as string);
      }

      // The product owner delivers a confirmation; the designer walks it.
      const delivery = await h.until(
        "产品确认交付",
        () =>
          h
            .state()
            .deliveries.find(
              (entry) =>
                entry.work_item_id === product?.id &&
                entry.status !== "superseded",
            ),
        120_000,
      );
      expect(delivery.kind).toBe("doc");
      expect(delivery.requested_verifiers).toEqual([designerItem?.id]);
      await h.until(
        "设计走查通过",
        () =>
          h
            .state()
            .reviews.find(
              (review) =>
                review.work_item_id === designerItem?.id &&
                review.verdict === "pass",
            ),
        120_000,
      );
      expect(itemByRole("pm", "produce")?.status).toBe("accepted");

      // 产品确认完成之后 PM Ops 才指派 coder；模板的依赖不可编辑，顺序由指派
      // 保证，开发项在 Run 启动时经 ready 进入 in_progress。
      await call(ops, "assign", {
        work_item_id: development?.id,
        role_id: "coder",
      });
      const coder = assignmentFor(development?.id as string);
      expect(coder).toBeDefined();
      await h.startAssignment(coder?.id as string);

      // The host built the worktree and branch, and the Agent got its bell.
      const seated = await h.until(
        "coder 的 worktree 与分支",
        () => {
          const assignment = h
            .state()
            .assignments.find((entry) => entry.id === coder?.id);
          return assignment?.worktree_path !== undefined &&
            assignment.branch !== undefined &&
            assignment.runtime_ref !== undefined
            ? assignment
            : undefined;
        },
        90_000,
      );
      expect(seated.worktree_path).toContain(
        join("worktrees", PROJECT, String(coder?.id)),
      );
      expect(seated.branch).toBe(`agent/${cardId}/${development?.id}`);
      expect(existsSync(seated.worktree_path as string)).toBe(true);
      expect(seated.runtime_state).toBe("running");
      // The produce item left todo when the Run started; a fast Agent may
      // already have delivered by the time this line runs.
      expect(["in_progress", "delivered"]).toContain(
        itemByRole("coder", "produce")?.status,
      );

      const notes = h.store.listNotifications({ project_id: PROJECT });
      const coderNotes = notes.filter(
        (note) =>
          note.recipient.kind === "assignment" &&
          note.recipient.assignment_id === coder?.id,
      );
      const coderRun = h
        .state()
        .runs.find((run) => run.assignment_id === coder?.id);
      expect(["dispatched", "acked", "running"]).toContain(coderRun?.status);
      // Either the routed bell was delivered to the live terminal, or the host
      // started the Assignment with its first prompt — both are a wake-up.
      expect(
        coderNotes.length > 0 || coderRun !== undefined,
        JSON.stringify({
          notes: coderNotes.map((note) => note.status),
          run: coderRun?.status,
        }),
      ).toBe(true);
      // Nothing has asked the human for anything yet.
      expect(needsYou()).toEqual([]);
    }, 240_000);

    test("第 3 步：coder 在本地提交并交付 D-1，附带证据附件", async () => {
      const development = itemByRole("coder", "produce");
      const delivery = await h.until(
        "D-1",
        () =>
          h
            .state()
            .deliveries.find(
              (entry) =>
                entry.work_item_id === development?.id &&
                entry.status === "submitted",
            ),
        120_000,
      );
      expect(delivery.kind).toBe("code");
      // A real commit: the verifier accepted the SHA from the worktree branch.
      expect(delivery.subject.kind).toBe("git_head");
      expect(delivery.subject.value).toMatch(/^[0-9a-f]{40}$/u);

      const attachment = await h.until(
        "交付附件",
        () =>
          h
            .state()
            .attachments.find(
              (entry) =>
                entry.attach_to.kind === "delivery" &&
                entry.attach_to.id === delivery.id,
            ),
        60_000,
      );
      expect(attachment.mime).toBe("image/png");
      expect(attachment.kind).toBe("evidence");
      expect(attachment.sha256).toMatch(/^[0-9a-f]{64}$/u);
      // The blob is on disk, so the Workbench can serve it.
      expect(
        existsSync(join(h.dataDir, "attachments", attachment.sha256)),
      ).toBe(true);

      // The delivery is on the card's timeline, not just in the database.
      const entry = events(cardId).find(
        (event) => event.type === "delivery_submitted",
      );
      expect(entry).toBeDefined();
    }, 180_000);

    test("第 4 步：代码审核和测试验收被唤醒，全程不打扰你", async () => {
      const development = itemByRole("coder", "produce");
      const reviewerItem = items().find(
        (item) => item.role_id === "reviewer" && item.kind === "verify",
      );
      const testerItem = itemByRole("tester", "verify");
      expect(reviewerItem?.target_work_item_id).toBe(development?.id);
      expect(testerItem?.target_work_item_id).toBe(development?.id);

      for (const item of [reviewerItem, testerItem]) {
        await call(ops, "assign", {
          work_item_id: item?.id,
          role_id: item?.role_id,
        });
        const assignment = assignmentFor(item?.id as string);
        expect(assignment).toBeDefined();
        await h.startAssignment(assignment?.id as string);
      }

      const passed = await h.until(
        "代码审核通过",
        () =>
          h
            .state()
            .reviews.find(
              (review) =>
                review.work_item_id === reviewerItem?.id &&
                review.verdict === "pass",
            ),
        120_000,
      );
      expect(passed.delivery_id).toBeDefined();

      const rejected = await h.until(
        "测试验收驳回",
        () =>
          h
            .state()
            .reviews.find(
              (review) =>
                review.work_item_id === testerItem?.id &&
                review.verdict === "reject",
            ),
        120_000,
      );
      expect(rejected.issues.some((issue) => issue.must_fix)).toBe(true);

      // "全程不打扰你": nothing reached Needs You for these rounds.
      expect(needsYou()).toEqual([]);
    }, 300_000);

    test("第 5 步：驳回回写了卡片与交付的状态，且没有产生重复 Run", async () => {
      const testerItem = itemByRole("tester", "verify");
      const development = itemByRole("coder", "produce");
      await h.until(
        "测试验收项失败",
        () =>
          itemByRole("tester", "verify")?.status === "failed"
            ? true
            : undefined,
        60_000,
      );
      expect(itemByRole("designer", "verify")?.status).toBe("passed");
      expect(development).toBeDefined();

      // Every Run belongs to exactly one (assignment, trigger event): a
      // duplicated bell cannot create a second Run for the same event.
      const runs = h.state().runs;
      const keys = runs.map(
        (run) => `${run.assignment_id}/${run.trigger_event_id}`,
      );
      expect(new Set(keys).size).toBe(keys.length);
      expect(testerItem).toBeDefined();
    }, 120_000);
  },
);

void PROJECT;
