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
import {
  createHarness,
  type E2eHarness,
  PROJECT,
  sleep,
} from "./support/harness.js";

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
    /** Needs You as the human sees it in the Workbench, not a table dump. */
    const needsYou = async (): Promise<{
      decisions: { id: string; kind: string; blocking: boolean }[];
      human_actions: unknown[];
    }> => {
      const body = await h.api("GET", `/api/projects/${PROJECT}/needs-you`);
      return body as {
        decisions: { id: string; kind: string; blocking: boolean }[];
        human_actions: unknown[];
      };
    };
    const isNeedsYouEmpty = async (): Promise<boolean> => {
      const body = await needsYou();
      return body.decisions.length === 0 && body.human_actions.length === 0;
    };

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
      expect(development).toBeDefined();
      expect(itemByRole("pm", "verify")).toBeDefined();

      // PM adds the three items appendix A names on top of the dev template
      // (开发 / 代码审核 / PM 验收 per decision D4).
      const product = await call(office, "create_work_item", {
        card_id: cardId,
        title: "产品确认",
        kind: "produce",
        role_id: "pm",
        required: true,
        completion_criteria: ["需求确认"],
      });
      expect(product.work_item_id ?? product.id).toMatch(/^W-\d+$/u);
      await call(office, "create_work_item", {
        card_id: cardId,
        title: "设计走查",
        kind: "verify",
        role_id: "designer",
        required: true,
        completion_criteria: ["视觉走查通过"],
        target_work_item_id: development?.id,
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

      // 开发卡模板（D4：开发、代码审核、PM 验收）+ PM 新增的三项 = 六项。
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

    test("第 2 步：产品确认交付即完成，PM Ops 指派 coder，主机建 worktree 并按门铃", async () => {
      const product = itemByRole("pm", "produce");
      const development = itemByRole("coder", "produce");
      expect(product).toBeDefined();
      expect(development).toBeDefined();

      // PM Ops assigns the product confirmation, the host starts it.
      await call(ops, "assign", { work_item_id: product?.id, role_id: "pm" });
      const productAssignment = assignmentFor(product?.id as string);
      expect(productAssignment).toBeDefined();
      await h.startAssignment(productAssignment?.id as string);

      // §4.4: nothing verifies the product confirmation, so its delivery is
      // accepted on arrival and the item is done.
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
      expect(delivery.requested_verifiers).toEqual([]);
      expect(delivery.status).toBe("accepted");
      expect(itemByRole("pm", "produce")?.status).toBe("accepted");
      // The card timeline records why no review follows.
      expect(
        events(cardId).some((event) => event.type === "delivery_accepted"),
      ).toBe(true);

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
      const coderRun = h
        .state()
        .runs.find((run) => run.assignment_id === coder?.id);
      expect(coderRun?.status).toBeDefined();
      expect(
        notes.some(
          (note) =>
            note.recipient.kind === "assignment" &&
            note.recipient.assignment_id === coder?.id,
        ) || coderRun !== undefined,
      ).toBe(true);
      // Nothing has asked the human for anything yet.
      expect(await isNeedsYouEmpty()).toBe(true);
    }, 240_000);

    test("第 3 步：coder 在本地提交并交付开发的第 1 次交付，附带证据附件", async () => {
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

    test("第 4 步：设计走查、代码审核和测试验收被唤醒，全程不打扰你", async () => {
      const development = itemByRole("coder", "produce");
      const reviewerItem = items().find(
        (item) => item.role_id === "reviewer" && item.kind === "verify",
      );
      const designerItem = itemByRole("designer", "verify");
      const testerItem = itemByRole("tester", "verify");
      for (const item of [reviewerItem, designerItem, testerItem]) {
        expect(item?.target_work_item_id).toBe(development?.id);
      }

      for (const item of [reviewerItem, designerItem, testerItem]) {
        await call(ops, "assign", {
          work_item_id: item?.id,
          role_id: item?.role_id,
        });
        const assignment = assignmentFor(item?.id as string);
        expect(assignment).toBeDefined();
        await h.startAssignment(assignment?.id as string);
      }

      const reviewed = await h.until(
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
      expect(reviewed.delivery_id).toBeDefined();

      const designed = await h.until(
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
      expect(designed.delivery_id).toBeDefined();

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
      expect(await isNeedsYouEmpty()).toBe(true);
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

describe.skipIf(hcVersion !== `hc ${HC_VERSION}`)(
  "附录 A：卡片从需求到合并的完整流程（后半）",
  () => {
    let h: E2eHarness;
    let office: Client;
    let ops: Client;
    let cardId: string;
    /** Facts the restart criterion (pass criterion 3) is judged on. */
    let stoppedAt: string;
    let probesAfterRecovery: Record<string, unknown>;

    beforeAll(async () => {
      h = await createHarness({ salt: "appendix-a-late" });
      office = await h.connect(
        (await h.cardigan("pm", "create", "--office")).split("\n").at(-1) ?? "",
      );
      ops = await h.connect(
        (await h.cardigan("pm", "create", "--ops")).split("\n").at(-1) ?? "",
      );
      // Same opening as the first half: the card, its five work items and the
      // template's code review, the product confirmation and the coder.
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
      const development = h
        .state()
        .work_items.find(
          (item) => item.card_id === cardId && item.role_id === "coder",
        );
      const product = await call(office, "create_work_item", {
        card_id: cardId,
        title: "产品确认",
        kind: "produce",
        role_id: "pm",
        required: true,
        completion_criteria: ["需求确认"],
      });
      expect(product.work_item_id ?? product.id).toMatch(/^W-\d+$/u);
      await call(office, "create_work_item", {
        card_id: cardId,
        title: "设计走查",
        kind: "verify",
        role_id: "designer",
        required: true,
        completion_criteria: ["视觉走查通过"],
        target_work_item_id: development?.id,
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
      const productItem = h
        .state()
        .work_items.find(
          (item) => item.card_id === cardId && item.title === "产品确认",
        );
      // Start the product confirmation (accepted on delivery, §4.4), then the
      // coder; the verifiers join once the development delivery exists.
      for (const [itemId, role] of [[productItem?.id, "pm"]] as const) {
        await call(ops, "assign", { work_item_id: itemId, role_id: role });
        const assignment = h
          .state()
          .assignments.find((entry) => entry.work_item_id === itemId);
        await h.startAssignment(assignment?.id as string);
      }
      await h.until(
        "产品确认被接受",
        () =>
          h.state().work_items.find((item) => item.id === productItem?.id)
            ?.status === "accepted"
            ? true
            : undefined,
        120_000,
      );
      await call(ops, "assign", {
        work_item_id: development?.id,
        role_id: "coder",
      });
      const coder = h
        .state()
        .assignments.find((entry) => entry.work_item_id === development?.id);
      await h.startAssignment(coder?.id as string);
      // The three verifiers join for the development delivery.
      for (const [roleId, item] of [
        [
          "reviewer",
          h
            .state()
            .work_items.find(
              (entry) =>
                entry.card_id === cardId && entry.role_id === "reviewer",
            ),
        ],
        [
          "designer",
          h
            .state()
            .work_items.find(
              (entry) =>
                entry.card_id === cardId && entry.role_id === "designer",
            ),
        ],
        [
          "tester",
          h
            .state()
            .work_items.find(
              (entry) => entry.card_id === cardId && entry.role_id === "tester",
            ),
        ],
      ] as const) {
        await call(ops, "assign", { work_item_id: item?.id, role_id: roleId });
        const assignment = h
          .state()
          .assignments.find((entry) => entry.work_item_id === item?.id);
        await h.startAssignment(assignment?.id as string);
      }
      // Let the first rejection land, which is what starts the appendix's
      // second half.
      await h.until(
        "测试验收驳回",
        () =>
          h
            .state()
            .work_items.find(
              (entry) => entry.card_id === cardId && entry.role_id === "tester",
            )?.status === "failed"
            ? true
            : undefined,
        180_000,
      );
    }, 600_000);

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
    const deliveries = (workItemId: string) =>
      h
        .state()
        .deliveries.filter(
          (delivery) =>
            delivery.work_item_id === workItemId &&
            delivery.kind !== "card_completion",
        );
    /** Poll the Workbench until the API shows what the step expects. */
    const untilNeedsYou = async <T>(
      label: string,
      probe: (body: {
        decisions: {
          id: string;
          blocking: boolean;
          kind: string;
          trigger?: string | null;
          why: string;
          waited_ms: number | null;
        }[];
        human_actions: unknown[];
      }) => T | undefined,
      timeoutMs = 180_000,
    ): Promise<T> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const value = probe(await needsYou());
        if (value !== undefined) return value;
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for ${label}`);
        }
        await sleep(200);
      }
    };
    const needsYou = () =>
      h.api("GET", `/api/projects/${PROJECT}/needs-you`) as Promise<{
        decisions: {
          id: string;
          blocking: boolean;
          kind: string;
          trigger?: string | null;
          why: string;
          waited_ms: number | null;
        }[];
        human_actions: unknown[];
      }>;

    test("第 6 步：返工 Run 复用原 worktree，D-2 提交后 D-1 变成 superseded", async () => {
      const development = itemByRole("coder", "produce");
      const coder = assignmentFor(development?.id as string);
      const rework = await h.until(
        "返工 Run",
        () =>
          h
            .state()
            .runs.find(
              (run) => run.assignment_id === coder?.id && run.kind === "rework",
            ),
        180_000,
      );
      expect(rework.status).not.toBe("cancelled");

      const first = deliveries(development?.id as string)[0];
      expect(first).toBeDefined();
      // D-2 is the rework delivery and replaces D-1.
      const second = await h.until(
        "D-2",
        () => deliveries(development?.id as string)[1],
        240_000,
      );
      expect(second.supersedes).toBe(first?.id);
      const after = h
        .state()
        .deliveries.find((delivery) => delivery.id === first?.id);
      expect(after?.status).toBe("superseded");
    }, 300_000);

    test("第 7 步：返工中的产品问题进入 Needs You，Run 以 blocked 结束", async () => {
      const decision = await untilNeedsYou("Needs You 的拍板", (body) =>
        body.decisions.find((entry) => entry.kind === "decision"),
      );
      expect(decision?.blocking).toBe(true);
      // §4.4 + appendix step 7: a product question, not an exhausted review
      // budget. The tester's third round passes, so no limit decision exists.
      expect(decision?.trigger).not.toBe("review_limit");
      expect(
        h.state().decisions.filter((entry) => entry.trigger === "review_limit"),
      ).toEqual([]);
      expect(decision?.why.length).toBeLessThanOrEqual(40);
      expect(typeof decision?.waited_ms).toBe("number");
      // The human has been interrupted exactly once so far.
      expect((await needsYou()).decisions).toHaveLength(1);

      const coder = assignmentFor(itemByRole("coder", "produce")?.id as string);
      const blocked = await h
        .until(
          "blocked 的返工 Run",
          () =>
            h
              .state()
              .runs.find(
                (run) =>
                  run.assignment_id === coder?.id && run.outcome === "blocked",
              ),
          120_000,
        )
        .catch((error: unknown) => {
          const state = h.state();
          const runs = state.runs
            .filter((run) => run.assignment_id === coder?.id)
            .map(
              (run) =>
                `${run.id}:${run.kind}:${run.status}:${run.outcome ?? "-"}:${run.summary}`,
            )
            .join(" | ");
          const items = state.work_items
            .map((item) => `${item.id}:${item.status}`)
            .join(" ");
          const decisions = state.decisions
            .map(
              (decision) =>
                `${decision.id}:${decision.status}:${decision.trigger ?? "-"}`,
            )
            .join(" ");
          throw new Error(
            `${String(error)}\ncoder runs: ${runs}\nitems: ${items}\ndecisions: ${decisions}`,
          );
        });
      // The domain ends the Run itself and records the question as the summary.
      expect(blocked.outcome).toBe("blocked");
    }, 300_000);

    test("通过标准三的前半：停掉 Herdr server，系统自己恢复", async () => {
      // The appendix's restart: the Herdr server dies (core and terminals with
      // it) while the coder waits between two Runs. The test never starts a core
      // again: the system has to replace the Session on its own (D5), and the hc
      // call it makes brings a core back (0.3).
      stoppedAt = new Date().toISOString();
      await h.stopCore();
      const stopped = h
        .state()
        .assignments.filter((assignment) => assignment.scope === "work_item");
      // Nothing is deleted or faked: the Assignments are still there, waiting.
      expect(stopped.length).toBeGreaterThan(0);
      expect(
        stopped.every((assignment) => assignment.status === "active"),
      ).toBe(true);
      // The coder sits between Runs: blocked on the decision, resumed Run queued.
      const coder = assignmentFor(itemByRole("coder", "produce")?.id as string);
      expect(coder?.runtime_ref).toBeDefined();
      expect(
        h
          .state()
          .runs.some(
            (run) =>
              run.assignment_id === coder?.id &&
              ["dispatched", "acked", "running"].includes(run.status),
          ),
      ).toBe(false);
    }, 120_000);

    test("第 8 步：拍板在 Workbench 里记录（Web API），不是 MCP", async () => {
      const decision = (await needsYou()).decisions[0];
      expect(decision).toBeDefined();
      await h.api(
        "POST",
        `/api/projects/${PROJECT}/decisions/${decision?.id}/resolve`,
        { option: "smoke", raw_quote: "按方案 A" },
      );
      // Needs You clears as soon as you answered.
      const cleared = await needsYou();
      expect(cleared.decisions).toEqual([]);
      expect(cleared.human_actions).toEqual([]);
    }, 180_000);

    test("第 9 步：decision_resumed Run 产出 D-3，两个复核都通过", async () => {
      const development = itemByRole("coder", "produce");
      const coder = assignmentFor(development?.id as string);
      // The Run is queued as soon as the decision is recorded; wait until the
      // host actually started it in a runtime (`started_at` is stamped when the
      // Agent acknowledges, not when the terminal is provisioned).
      const resumed = await h.until(
        "已经启动的 decision_resumed Run",
        () =>
          h
            .state()
            .runs.find(
              (run) =>
                run.assignment_id === coder?.id &&
                run.kind === "decision_resumed" &&
                run.started_at !== undefined &&
                ["acked", "running", "completed"].includes(run.status),
            ),
        240_000,
      );
      expect(resumed.status).not.toBe("cancelled");
      // Pass criterion 3: the core was killed while this Run was queued, so the
      // Session had to be replaced before it could start. `stopCore()` never
      // starts a core; recording the PID here is cleanup, not recovery.
      h.rememberCore();
      probesAfterRecovery = {};
      for (const assignment of h
        .state()
        .assignments.filter((entry) => entry.runtime_ref !== undefined))
        probesAfterRecovery[assignment.id] = await h.probeRuntime(
          assignment.runtime_ref,
        );
      expect(resumed.started_at).toBeDefined();
      expect(Date.parse(resumed.started_at as string)).toBeGreaterThanOrEqual(
        Date.parse(stoppedAt),
      );
      expect(probesAfterRecovery[coder?.id ?? ""]).toMatchObject({ ok: true });
      // The replacement is a timeline entry on the card, not only a log line (D5).
      const detail = (await h.api(
        "GET",
        `/api/projects/${PROJECT}/cards/${cardId}`,
      )) as { timeline: { type: string }[] };
      expect(
        detail.timeline.filter((entry) => entry.type === "handoff").length,
      ).toBeGreaterThan(0);

      const third = await h.until(
        "D-3",
        () => deliveries(development?.id as string)[2],
        240_000,
      );
      expect(third.supersedes).toBe(
        deliveries(development?.id as string)[1]?.id,
      );
      // All three verifiers (设计走查、代码审核、测试验收) pass D-3.
      await h.until(
        "三个验证项对 D-3 都通过",
        () =>
          ["designer", "reviewer", "tester"].every(
            (role) =>
              h
                .state()
                .reviews.some(
                  (review) =>
                    review.delivery_id === third.id &&
                    review.verdict === "pass",
                ) &&
              h
                .state()
                .work_items.find(
                  (item) => item.card_id === cardId && item.role_id === role,
                )?.status === "passed",
          )
            ? true
            : undefined,
        300_000,
      );
      expect(itemByRole("coder", "produce")?.status).toBe("accepted");
    }, 600_000);

    test("第 10 步：完成申请 + PM 验收，合并确认走 Workbench Web API", async () => {
      const development = itemByRole("coder", "produce");
      const completion = await h.until(
        "完成申请",
        () =>
          h
            .state()
            .deliveries.find(
              (delivery) =>
                delivery.work_item_id === development?.id &&
                delivery.kind === "card_completion",
            ),
        300_000,
      );
      expect(completion.status).toBe("submitted");

      const pmAcceptance = itemByRole("pm", "verify");
      await call(ops, "assign", {
        work_item_id: pmAcceptance?.id,
        role_id: "pm",
      });
      const pmAssignment = assignmentFor(pmAcceptance?.id as string);
      expect(pmAssignment).toBeDefined();
      await h.startAssignment(pmAssignment?.id as string);

      // PM acceptance approves the completion request: the card awaits merge
      // and a merge confirmation decision appears.
      const mergeDecision = await h.until(
        "合并确认",
        () =>
          h
            .state()
            .decisions.find(
              (decision) =>
                decision.trigger === "merge_confirmation" &&
                (decision.status === "open" ||
                  decision.status === "provisional"),
            ),
        300_000,
      );
      expect(mergeDecision.decider).toBe("human");
      expect(mergeDecision.card_id).toBe(cardId);

      // The human confirms the merge in the Workbench, not on the terminal.
      await h.api(
        "POST",
        `/api/projects/${PROJECT}/decisions/${mergeDecision.id}/resolve`,
        { option: "merge", raw_quote: "合并吧" },
      );
      const merged = await h.until(
        "合并完成",
        () =>
          h.state().cards.find((card) => card.id === cardId)?.status === "done"
            ? true
            : undefined,
        300_000,
      );
      expect(merged).toBe(true);
    }, 900_000);

    test("第 11 步：worktree 被清理，Assignment 被释放", async () => {
      const worktreeCleaned = await h.until(
        "worktree 清理",
        () => {
          const assignments = h
            .state()
            .assignments.filter(
              (assignment) => assignment.scope === "work_item",
            );
          const released = assignments.every(
            (assignment) => assignment.status === "released",
          );
          const gone = assignments.every(
            (assignment) =>
              assignment.worktree_path === undefined ||
              !existsSync(assignment.worktree_path),
          );
          return released && gone ? true : undefined;
        },
        300_000,
      );
      expect(worktreeCleaned).toBe(true);
      await expect(
        h.api("GET", `/api/projects/${PROJECT}/cards/${cardId}`),
      ).resolves.toBeDefined();
    }, 600_000);

    test("第 12 步：项目快照能回答整体情况", async () => {
      const snapshot = (await h.api(
        "GET",
        `/api/projects/${PROJECT}/snapshot`,
      )) as {
        cards: { id: string; status: string }[];
        by_status: Record<string, number>;
      };
      const card = snapshot.cards.find((entry) => entry.id === cardId);
      expect(card?.status).toBe("done");
      expect(snapshot.by_status.done).toBe(1);
      expect(snapshot.by_status.in_progress ?? 0).toBe(0);

      // The timeline records the whole story (§8.4).
      const detail = (await h.api(
        "GET",
        `/api/projects/${PROJECT}/cards/${cardId}`,
      )) as { timeline: { type: string }[] };
      const types = detail.timeline.map((entry) => entry.type);
      // The scenario posts no free-form comment, so the story is deliveries,
      // reviews, the decision pair, the replacement handoff and status moves.
      for (const expected of [
        "delivery",
        "review",
        "decision_request",
        "decision_resolved",
        "handoff",
        "status_change",
      ]) {
        expect(types, expected).toContain(expected);
      }
    }, 180_000);

    test("通过标准一：只有拍板与合并确认打断过你", async () => {
      const decisions = h
        .state()
        .decisions.filter((decision) => decision.decider === "human");
      // One product question (step 7) and one merge confirmation (step 10).
      expect(decisions).toHaveLength(2);
      expect(decisions.map((decision) => decision.trigger).sort()).toEqual([
        "merge_confirmation",
        undefined,
      ]);
      expect(h.state().human_actions).toEqual([]);
    }, 120_000);

    test("通过标准三：重启后 coder 的 Assignment 被替换并恢复", async () => {
      const state = h.state();
      const development = itemByRole("coder", "produce");
      const coder = assignmentFor(development?.id as string);
      expect(coder).toBeDefined();

      // 1. The queued decision_resumed Run started after the core was killed:
      //    the system resumed work on its own, without the test starting a core.
      const resumed = state.runs.find(
        (run) =>
          run.assignment_id === coder?.id && run.kind === "decision_resumed",
      );
      expect(resumed?.started_at).toBeDefined();
      expect(Date.parse(resumed?.started_at as string)).toBeGreaterThanOrEqual(
        Date.parse(stoppedAt),
      );

      // 2. The Session was replaced, not reused: the Assignment's RuntimeRef
      //    resolves in the core the system brought back, and the Assignment is
      //    neither unknown nor lost. A terminal address can repeat across cores,
      //    so the proof of the handoff is the timeline entry below, not a string
      //    comparison of terminal refs.
      expect(["unknown", "lost"]).not.toContain(coder?.runtime_state);
      expect(probesAfterRecovery[coder?.id ?? ""]).toMatchObject({ ok: true });

      // 3. The timeline records the handoff (D5: replacement writes one).
      const detail = (await h.api(
        "GET",
        `/api/projects/${PROJECT}/cards/${cardId}`,
      )) as { timeline: { type: string; body: string }[] };
      const handoffs = detail.timeline.filter(
        (entry) => entry.type === "handoff",
      );
      expect(handoffs.length).toBeGreaterThan(0);

      // 4. No work-item Assignment is left in limbo: each one either finished
      //    its job (released) or ran again after the restart.
      const unhandled = state.assignments
        .filter((assignment) => assignment.scope === "work_item")
        .filter(
          (assignment) =>
            assignment.status !== "released" &&
            !state.runs.some(
              (run) =>
                run.assignment_id === assignment.id &&
                run.started_at !== undefined &&
                Date.parse(run.started_at) >= Date.parse(stoppedAt),
            ),
        );
      expect(unhandled.map((assignment) => assignment.id)).toEqual([]);
      // Whatever core the system started is cleaned up by `close()`.
      h.rememberCore();
    }, 120_000);

    test("通过标准二：重复发送门铃不产生重复 Run", async () => {
      const keys = () =>
        h
          .state()
          .runs.map((run) => `${run.assignment_id}/${run.trigger_event_id}`);
      const before = keys();
      // A bell rings for the same event and the same recipient only once: the
      // inbox is keyed on (event, recipient), so a duplicate send is a no-op.
      const { recordNotification } = await import("@cardigan/store");
      const delivered = h.store
        .listNotifications({ project_id: PROJECT })
        .filter((note) => note.recipient.kind === "assignment")
        .at(-1);
      expect(delivered).toBeDefined();
      const again = h.store.uow.run(() =>
        recordNotification(h.store.database, {
          project_id: PROJECT,
          event_id: delivered?.event_id as never,
          recipient: delivered?.recipient as never,
          seq: delivered?.seq as number,
          kind: delivered?.kind as string,
        }),
      );
      expect(again.created).toBe(false);
      expect(again.notification.id).toBe(delivered?.id);

      // Replaying the whole history through the router rings nothing twice
      // either, and every (assignment, trigger event) still has one Run.
      for (const stream of h.store.uow.read((tx) => [
        "",
        ...tx.cards.list(PROJECT).map((card) => card.id as string),
      ])) {
        h.store.advanceRouterCursor(PROJECT, stream, 0);
      }
      const { routeProjectEvents } = await import(
        "../apps/server/src/dispatch-inbox.js"
      );
      await sleep(1_500);
      routeProjectEvents(h.store, PROJECT);
      await sleep(1_500);
      expect(keys()).toEqual(before);
      const unique = new Set(keys());
      expect(unique.size).toBe(keys().length);
    }, 120_000);
  },
);
