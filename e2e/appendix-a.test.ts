// biome-ignore-all lint/suspicious/noExplicitAny: the scripted scenario reads a
// few fields out of large tool payloads; pinning every response shape here
// would duplicate the MCP surface without testing anything extra.
/**
 * M5.5 / M5.T1: Appendix A's 12 steps, real server/hc/Git and MCP-only Agents.
 * D-n denotes the coder's nth code delivery, not the project's global Delivery ID.
 * The first half checks initial setup; the second repeats it and completes the flow.
 * Human business writes use Web API. CLI is only host provisioning/launch setup.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_EVENT_STREAM } from "@cardigan/store";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  interruptionSnapshot,
  printInterruptionFailure,
} from "./support/diagnostics.js";
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

/**
 * `GET /api/projects/:id/needs-you`: everything that asks the human (§8.2).
 * `incidents` is M5.6's runtime view: an active Assignment whose Session is
 * unknown or lost has to be handled by the human too.
 */
type NeedsYouBody = {
  incidents: {
    id: string;
    role_id: string;
    runtime_state: string;
    card_id: string | null;
    disconnected_at: string | null;
    lost_at: string | null;
  }[];
  decisions: {
    id: string;
    kind: string;
    blocking: boolean;
    trigger?: string | null;
    why: string;
    waited_ms: number | null;
  }[];
  human_actions: unknown[];
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
      await h?.close();
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
    const needsYou = async (): Promise<NeedsYouBody> =>
      (await h.api(
        "GET",
        `/api/projects/${PROJECT}/needs-you`,
      )) as NeedsYouBody;
    const isNeedsYouEmpty = async (): Promise<boolean> => {
      const body = await needsYou();
      return (
        body.decisions.length === 0 &&
        body.human_actions.length === 0 &&
        body.incidents.length === 0
      );
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

    test("第 1 步：PM Office 建卡，工作项按附录 A 的六项", async () => {
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
      await h.awaitAgent(productAssignment?.id as string);

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
      // M5.S S6: the assign bell alone must start the Agent — the test never
      // runs `assignment start`. `awaitAgent` only waits for the host to do it.
      await h.awaitAgent(coder?.id as string);

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

    test("通过标准二：向存活终端重复发送原门铃，不新增 Run 或业务写入", async () => {
      const coder = assignmentFor(itemByRole("coder", "produce")?.id as string);
      if (!coder?.runtime_ref) throw new Error("Missing coder terminal");
      const run = await h.until("首轮 Run 完成", () =>
        h
          .state()
          .runs.find(
            (r) => r.assignment_id === coder.id && r.status === "completed",
          ),
      );
      await h.until("Agent 完成首轮协议", () =>
        h.markers().includes(`marker-done-${run.id}`) ? true : undefined,
      );
      const before = h.state(),
        count = () =>
          h.agentLog().split(`duplicate prompt for ${run.id}, ignored`).length -
          1;
      const seen = count();
      const bell = readFileSync(
        join(h.dataDir, "runs", PROJECT, coder.id, "first.md"),
        "utf8",
      );
      await h.repeatBell(coder.runtime_ref, bell);
      await h.until(
        "两次重复门铃都已处理",
        () => (count() >= seen + 2 ? true : undefined),
        5000,
      );
      await sleep(500); // Give Dispatcher several ticks to expose accidental follow-up work.
      const after = h.state();
      expect(after.runs).toEqual(before.runs);
      expect(after.deliveries).toEqual(before.deliveries);
      expect(after.reviews).toEqual(before.reviews);
      expect(after.timeline).toEqual(before.timeline);
    }, 30000);

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
        await h.awaitAgent(assignment?.id as string);
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
      expect(reviewed.kind).toBe("code");

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
      expect(designed.kind).toBe("design");

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
      expect(rejected.kind).toBe("test");

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
    /** Step 7's blocked Run and the terminal it used: both go into the handoff. */
    let blockedRunId: string;
    let oldTerminalRef: string;
    let initialCoder: { worktree_path?: string; runtime_ref: unknown };
    let stoppedCorePid: number | undefined;
    let restartCohort: ReturnType<E2eHarness["state"]>["assignments"];
    let completedBeforeStop = new Set<string>();

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
        await h.awaitAgent(assignment?.id as string);
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
      await h.awaitAgent(coder?.id as string);
      const launchedCoder = h
        .state()
        .assignments.find((a) => a.id === coder?.id);
      if (!launchedCoder) throw new Error("Missing initial coder Assignment");
      initialCoder = {
        ...(launchedCoder.worktree_path
          ? { worktree_path: launchedCoder.worktree_path }
          : {}),
        runtime_ref: launchedCoder.runtime_ref,
      };
      // A readonly reviewer needs the real delivery SHA, not merely a connected coder.
      await h.until(
        "首份代码交付已提交",
        () =>
          h
            .state()
            .deliveries.find(
              (d) =>
                d.work_item_id === development?.id &&
                d.kind === "code" &&
                d.status === "submitted",
            ),
        120_000,
      );
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
        await h.awaitAgent(assignment?.id as string);
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
      await h?.close();
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
      probe: (body: NeedsYouBody) => T | undefined,
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
    const needsYou = async (): Promise<NeedsYouBody> =>
      (await h.api(
        "GET",
        `/api/projects/${PROJECT}/needs-you`,
      )) as NeedsYouBody;

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
      expect(assignmentFor(development?.id as string)).toMatchObject(
        initialCoder,
      );
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
      blockedRunId = blocked.id;
      const history = deliveries(itemByRole("coder", "produce")?.id as string);
      expect(history).toHaveLength(2); // The decision happens before D-3.
      expect(itemByRole("coder", "produce")?.status).toBe("waiting_decision");
      const tester = itemByRole("tester", "verify");
      for (const delivery of history)
        expect(h.state().reviews).toContainEqual(
          expect.objectContaining({
            delivery_id: delivery.id,
            work_item_id: tester?.id,
            verdict: "reject",
          }),
        );
    }, 300_000);

    test("通过标准三的前半：停掉 Herdr server，系统自己恢复", async () => {
      // The appendix's restart: the Herdr server dies (core and terminals with
      // it) while the coder waits between two Runs. The test never starts a core
      // again: the system has to replace the Session on its own (D5), and the hc
      // call it makes brings a core back (0.3).
      stoppedAt = new Date().toISOString();
      const coderBeforeStop = assignmentFor(
        itemByRole("coder", "produce")?.id as string,
      );
      oldTerminalRef = coderBeforeStop?.runtime_ref?.terminal_ref ?? "";
      expect(oldTerminalRef).not.toBe("");
      stoppedCorePid = h.core.remember();
      expect(stoppedCorePid).toBeTypeOf("number");
      restartCohort = h
        .state()
        .assignments.filter(
          (a) => a.runtime_ref !== null && a.runtime_ref !== undefined,
        );
      completedBeforeStop = new Set(
        h
          .state()
          .work_items.filter(
            (w) =>
              (w.kind === "produce"
                ? w.status === "accepted"
                : w.status === "passed") &&
              h
                .state()
                .runs.filter((r) => r.assignment_id === w.assignment_id)
                .every((r) =>
                  ["completed", "failed", "cancelled"].includes(r.status),
                ),
          )
          .map((w) => w.assignment_id as string),
      );
      await h.stopCore();
      h.core.assertStopped();
      const stopped = h
        .state()
        .assignments.filter((assignment) => assignment.scope === "work_item");
      // Nothing is deleted or faked: the Assignments are still there, waiting.
      expect(stopped.length).toBeGreaterThan(0);
      expect(
        stopped.every((assignment) => assignment.status === "active"),
      ).toBe(true);
      // The coder is blocked between Runs; answering step 8 will queue decision_resumed.
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
      // Needs You clears as soon as you answered — and the lost runtime of the
      // killed Herdr server never turns into an incident for the human (M5.6).
      const cleared = await needsYou();
      expect(cleared.decisions).toEqual([]);
      expect(cleared.human_actions).toEqual([]);
      expect(cleared.incidents).toEqual([]);
    }, 180_000);

    test("第 9 步：decision_resumed Run 产出 D-3，三个复核都通过", async () => {
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
      expect(h.rememberCore()).not.toBe(stoppedCorePid);
      expect(h.core.pid).toBeTypeOf("number");
      probesAfterRecovery = {};
      for (const assignment of h
        .state()
        .assignments.filter(
          (entry) =>
            entry.runtime_ref !== undefined && entry.runtime_ref !== null,
        ))
        probesAfterRecovery[assignment.id] = await h.probeRuntime(
          assignment.runtime_ref,
        );
      expect(resumed.started_at).toBeDefined();
      expect(Date.parse(resumed.started_at as string)).toBeGreaterThanOrEqual(
        Date.parse(stoppedAt),
      );
      expect(probesAfterRecovery[coder?.id ?? ""]).toMatchObject({ ok: true });
      // The recovery did not hand a runtime incident to the human: no Assignment
      // is left unknown or lost once the Session has been replaced.
      expect((await needsYou()).incidents).toEqual([]);
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
      const productDecision = h
        .state()
        .decisions.find((d) => d.trigger === undefined);
      expect(productDecision).toMatchObject({
        status: "resolved",
        resolution: { raw_quote: "按方案 A" },
      });
      const artifact = await h.until("D-3 的拍板依据附件", () =>
        h
          .state()
          .attachments.find(
            (a) =>
              a.attach_to.kind === "delivery" && a.attach_to.id === third.id,
          ),
      );
      expect(artifact).toMatchObject({
        kind: "artifact",
        basis: productDecision?.id,
      });
      for (const earlier of deliveries(development?.id as string).slice(0, 2)) {
        const evidence = h
          .state()
          .attachments.find(
            (a) =>
              a.attach_to.kind === "delivery" && a.attach_to.id === earlier.id,
          );
        expect(evidence?.kind).toBe("evidence");
        expect(evidence?.basis).toBeUndefined();
      }
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
                    review.work_item_id === itemByRole(role, "verify")?.id &&
                    review.target_sha === third.subject.value &&
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
      // S12: a cache from D-1 survives into the rework cycles; D-3 is inspected
      // in the refreshed checkout and creates another cache for cleanup.
      const firstCode = deliveries(development?.id as string).find(
        (d) => d.kind === "code",
      );
      expect(h.markers()).toContain(`marker-reviewer-cache-${firstCode?.id}`);
      expect(h.markers()).toContain(`marker-reviewer-cache-${third.id}`);
      expect(
        h
          .state()
          .deliveries.find(
            (d) => d.id === deliveries(development?.id as string)[1]?.id,
          )?.status,
      ).toBe("superseded");
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
      await h.awaitAgent(pmAssignment?.id as string);

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
      const state = h.state();
      expect(state.cards.find((c) => c.id === cardId)?.status).toBe(
        "awaiting_merge",
      );
      expect(state.reviews).toContainEqual(
        expect.objectContaining({
          work_item_id: pmAcceptance?.id,
          delivery_id: completion.id,
          verdict: "pass",
        }),
      );
      expect((await needsYou()).decisions.map((d) => d.id)).toEqual([
        mergeDecision.id,
      ]);

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
      const latest = deliveries(development?.id as string).at(-1);
      execFileSync("git", [
        "-C",
        join(h.dataDir, "central", `${PROJECT}.git`),
        "merge-base",
        "--is-ancestor",
        latest?.subject.value as string,
        "refs/heads/main",
      ]);
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
          return released &&
            gone &&
            !existsSync(join(h.dataDir, "agent", "worktrees", PROJECT))
            ? true
            : undefined;
        },
        300_000,
      );
      expect(worktreeCleaned).toBe(true);
      expect(
        h.state().decisions.filter((d) => d.trigger === "worktree_cleanup"),
      ).toEqual([]);
      expect((await needsYou()).decisions).toEqual([]);
      expect(existsSync(join(h.dataDir, "agent", "worktrees", PROJECT))).toBe(
        false,
      );
      // S17: persisted "released" is insufficient. Every actual hc terminal,
      // including PM/produce seats with no worktree, must have been removed.
      const terminalRefs = h
        .state()
        .assignments.filter((a) => a.scope === "work_item" && a.runtime_ref)
        .map((a) => a.runtime_ref);
      expect(terminalRefs.length).toBeGreaterThan(2);
      await expect
        .poll(
          () => Promise.all(terminalRefs.map((ref) => h.probeRuntime(ref))),
          { timeout: 60_000, interval: 100 },
        )
        .toEqual(
          terminalRefs.map(() => ({
            ok: false,
            error: expect.objectContaining({ code: "runtime_not_found" }),
          })),
        );
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
      const officeSnapshot = await call(office, "project_snapshot");
      expect(officeSnapshot.cards).toContainEqual(
        expect.objectContaining({ id: cardId, status: "done" }),
      );
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
      const observed: Record<string, unknown> = {};
      try {
        const decisions = h
          .state()
          .decisions.filter((decision) => decision.decider === "human");
        observed.human_decisions = decisions;
        // One product question (step 7) and one merge confirmation (step 10).
        expect(decisions).toHaveLength(2);
        expect(decisions.map((decision) => decision.trigger).sort()).toEqual([
          "merge_confirmation",
          undefined,
        ]);
        const actions = h.state().human_actions;
        observed.human_actions = actions;
        expect(actions).toEqual([]);

        // M5.6's runtime view is part of Needs You: after the Session was replaced
        // and the card reached Done, nothing may be left for the human to look at.
        const you = await needsYou();
        observed.extra_needs_you = you;
        expect(you.incidents).toEqual([]);
        expect(you.decisions).toEqual([]);
        expect(you.human_actions).toEqual([]);

        // The restart must not have disturbed the human. Needs You notifications
        // are the escalation channel behind the list, so nothing but the two
        // card decisions (step 7's product question and step 10's merge
        // confirmation) may ever reach the PM Office or the Needs You list:
        // `runtime_lost` / `runtime_disconnected` / `bell_delivery_failed`
        // escalations all fail here.
        const pendingRequests = h
          .state()
          .events.filter((e) => e.type === "decision_requested");
        // Card completion/cleanup can outrun the Router's next tick. Wait for its
        // persisted consumption checkpoint, not for the desired notification contents.
        await h.until(
          "Router 已消费全部拍板请求",
          () =>
            pendingRequests.every(
              (event) =>
                h.store.routerCursor(
                  PROJECT,
                  event.card_id ?? PROJECT_EVENT_STREAM,
                ) >= event.seq,
            )
              ? true
              : undefined,
          10000,
        );
        const state = h.state();
        const notifications = h.store.listNotifications({
          project_id: PROJECT,
        });
        observed.interruptions = interruptionSnapshot(state, notifications);
        const escalating = notifications
          .filter((note) =>
            ["pm_office", "needs_you"].includes(note.recipient.kind),
          )
          .map(
            (note) =>
              state.events.find((event) => event.id === note.event_id)?.type ??
              `missing:${note.event_id}`,
          );
        expect(new Set(escalating)).toEqual(new Set(["decision_requested"]));
        const requests = state.events.filter(
          (e) => e.type === "decision_requested",
        );
        expect(requests).toHaveLength(2);
        for (const kind of ["pm_office", "needs_you"])
          expect(
            h.store
              .listNotifications({ project_id: PROJECT })
              .filter((n) => n.recipient.kind === kind)
              .map((n) => n.event_id)
              .sort(),
          ).toEqual(requests.map((e) => e.id).sort());
      } catch (error) {
        await printInterruptionFailure(h, observed);
        throw error;
      }
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

      // 3. The timeline records the handoff (D5: replacement writes one), and
      //    it says enough for a fresh Session to pick the work up: why the
      //    Session went away, which terminal it replaces, and which Run was the
      //    last one (step 7's blocked rework).
      const detail = (await h.api(
        "GET",
        `/api/projects/${PROJECT}/cards/${cardId}`,
      )) as { timeline: { type: string; body: string }[] };
      const coderHandoff = detail.timeline
        .filter((entry) => entry.type === "handoff")
        .find((entry) => entry.body.includes(blockedRunId));
      expect(coderHandoff).toBeDefined();
      const handoff = coderHandoff?.body ?? "";
      expect(handoff).toContain("运行时失联");
      expect(handoff).toContain(`"terminal_ref":"${oldTerminalRef}"`);
      expect(handoff).toContain(`最近 Run：${blockedRunId}`);
      expect(handoff).toContain("outcome：blocked");
      expect(handoff).toContain("get_updates");

      // Completion after recovery cannot hide an Assignment that never resumed.
      for (const prior of restartCohort) {
        const current = state.assignments.find((a) => a.id === prior.id);
        expect(current?.status, prior.id).toBe("released");
        if (!completedBeforeStop.has(prior.id))
          expect(
            state.runs.some(
              (r) =>
                r.assignment_id === prior.id &&
                r.status === "completed" &&
                r.started_at &&
                Date.parse(r.started_at) >= Date.parse(stoppedAt),
            ),
            prior.id,
          ).toBe(true);
      }
      // Standing PMs deliberately have no terminal in this harness. Verify the actual MCP sessions
      // still serve their identities; this is not evidence of a PM terminal restart.
      for (const pm of [office, ops])
        expect(await call(pm, "whoami")).toMatchObject({
          scope: "standing",
          role_id: "pm",
        });
      // Whatever core the system started is cleaned up by `close()`.
      h.rememberCore();
    }, 120_000);
  },
);
