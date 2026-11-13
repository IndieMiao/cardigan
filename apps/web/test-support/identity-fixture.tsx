import { createRoot } from "react-dom/client";
import { CardRecords } from "../src/components/CardRecords.js";
import { EmployeeIdentity } from "../src/components/EmployeeIdentity.js";
import { IdentityRow } from "../src/components/IdentityRow.js";
import { IdTag } from "../src/components/IdTag.js";
import { TimelineContent } from "../src/components/TimelineContent.js";
import { ID_TYPES } from "../src/id-types.js";
import {
  cardDetail,
  fakeClient,
  NOW,
  timelineEntry,
} from "../src/testing/fixtures.js";
import { ExecutionPage } from "../src/views/ExecutionPage.js";
import { NeedsYouPage } from "../src/views/NeedsYouPage.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/styles.css";

const employee = {
  id: "E-1",
  name: "孙悟空",
  title: "开发工程师",
  role_id: "coder",
  avatar: null,
};
const delivery = {
  id: "D-8",
  work_item_id: "W-586",
  work_item_title: "开发",
  kind: "code",
  status: "accepted",
  summary: "统一编号与同行对齐。",
  subject: { kind: "git_head" as const, value: "d9cf21d630b1".padEnd(40, "0") },
  employee,
  submitted_at: NOW,
};
const detail = cardDetail({ deliveries: [delivery], attachments: [] });
const entry = timelineEntry({
  type: "delivery",
  delivery_id: delivery.id,
  employee,
});
const client = fakeClient({
  needsYou: async () => ({
    decisions: [
      {
        id: "Q-1",
        question: "确认合并",
        context: "共享展示组件已完成。",
        why: "确认合并",
        status: "open",
        blocking: true,
        decider: "human",
        card_id: "C-1",
        affected_cards: [],
        options: [],
        recommended: "merge",
        waited_ms: 0,
        trigger: "merge_confirmation",
        category: "general",
        assignment_id: null,
        related_cards: [],
        employee,
        merge_confirmation: {
          completion: delivery,
          deliveries: [delivery],
          reviews: [],
          known_gaps: [],
        },
      },
    ],
    human_actions: [],
    incidents: [],
  }),
  execution: async () => ({
    assignments: [
      {
        id: "A-1",
        role_id: "coder",
        role_version: 1,
        status: "active",
        runtime_state: "running",
        machine_id: "fixture",
        standing_mode: null,
        card_id: "C-1",
        card_status: "in_progress",
        work_item_id: "W-586",
        worktree_path: null,
        branch: null,
        session_ref: null,
        runtime_ref: null,
        last_mcp_activity_at: null,
        cursors: [],
        employee,
      },
    ],
    runs: [],
    machines: [],
  }),
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
  <>
    <h1>编号与同行组件核对</h1>
    <p>本地模拟数据；使用产品组件和样式，头像演示缺图回退。</p>
    <section className="card-section">
      <h2>类型与窄屏边界</h2>
      <IdentityRow>
        {ID_TYPES.map(({ prefix }) => (
          <IdTag key={prefix} id={`${prefix}-12`} />
        ))}
        <IdTag id="C-12#34" />
        <IdTag id="ZZ-12" />
      </IdentityRow>
      <IdentityRow id="identity-example">
        <EmployeeIdentity employee={employee} />
        <IdTag id="W-586" label="开发" />
        <code>d9cf21d630b1</code>
        <a href="#/p/p-1/cards/C-1">查看改动</a>
      </IdentityRow>
      <IdentityRow id="identity-long">
        <EmployeeIdentity
          employee={{
            ...employee,
            name: "这是一位需要完整显示姓名的开发工程师",
          }}
        />
        <IdTag
          id="W-123456"
          label="这是一段很长的工作项说明，需要在编号右边完整换行而不截断"
        />
      </IdentityRow>
    </section>
    <section>
      <NeedsYouPage client={client} projectId="p-1" />
    </section>
    <section>
      <ExecutionPage client={client} projectId="p-1" />
    </section>
    <section className="card-main">
      <CardRecords detail={detail} projectId="p-1" onLocate={undefined} />
    </section>
    <section className="card-section timeline-entry">
      <TimelineContent
        entry={entry}
        detail={detail}
        projectId="p-1"
        cardId="C-1"
      />
    </section>
  </>,
);
