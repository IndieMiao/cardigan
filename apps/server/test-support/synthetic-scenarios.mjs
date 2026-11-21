import { decisionCategories, states } from "@cardigan/domain";
import { roleDocument } from "@cardigan/store";

export const MERGE_STATUSES = [
  "queued",
  "running",
  "passed",
  "failed",
  "timed_out",
  "interrupted",
  "executor_unreachable",
];
const roles = [
  "coder",
  "reviewer",
  "pm",
  "host_ops",
  "ui_ux_designer",
  "design_director",
  "independent_reviewer",
];
const plainSummary = {
  changed: "补齐合成工坊的展示内容。",
  impact: "便于核对列表、详情和拍板展示。",
  risk: "无",
};

/** Persist presentation snapshots; deliberately does not launch agents or replay commands. */
export function seedScenarios(
  tx,
  { size, project, now, random, eventId, avatar, blobs },
) {
  const date = (minutes) =>
    new Date(Date.parse(now) + minutes * 60000).toISOString();
  const counts = { events: 0, timeline: 0 };
  const firstEntries = new Map();
  const emit = (
    card,
    type,
    payload,
    timeline,
    at = now,
    actor = { kind: "system", project_id: project },
  ) => {
    const event = {
      id: eventId(),
      ...(card ? { card_id: card } : {}),
      seq: tx.ids.nextEventSequence(project, card),
      type,
      actor,
      payload,
      created_at: at,
    };
    tx.events.append(project, event);
    counts.events++;
    if (card && timeline) {
      const id = tx.ids.nextTimelineEntryId(project, card);
      const entry = {
        id,
        short_id: id,
        card_id: card,
        event_seq: event.seq,
        type: "system",
        author: "system",
        refs: [],
        mentions: [],
        retracted: false,
        created_at: at,
        ...timeline,
      };
      tx.timeline.put(project, entry);
      counts.timeline++;
      if (!firstEntries.has(card)) firstEntries.set(card, id);
    }
    return event.id;
  };
  const next = (kind) => tx.ids.next(project, kind);
  const sha = (i) => i.toString(16).padStart(40, "0");
  const actorFor = (assignment) => ({
    kind: "assignment",
    project_id: project,
    assignment_id: assignment.id,
    role_id: assignment.role_id,
    role_version: 1,
    allowed_tools: [],
    capabilities: [],
  });

  roles.forEach((role, i) => {
    const kind = ["pm", "host_ops"].includes(role)
      ? "standing"
      : ["coder", "ui_ux_designer"].includes(role)
        ? "produce"
        : "verify";
    tx.roles.put(
      project,
      roleDocument({
        role_id: role,
        version: 1,
        status: "active",
        display_name: `合成岗位 ${i + 1}`,
        kind,
        harness: ["codex", "pi", "claude-code"][i % 3],
        launch_profile_ref: `synthetic-profile-${(i % 3) + 1}`,
        core_prompt: "合成岗位说明，仅用于界面展示。",
        instructions: "合成岗位说明，仅用于界面展示。",
        allowed_tools: [],
        capabilities: [],
        abilities: [],
        worktree:
          kind === "standing"
            ? "none"
            : kind === "produce"
              ? "write"
              : "readonly",
        required_machine_tags: [],
      }),
    );
    const id = tx.global_ids.nextEmployeeId();
    tx.employees.put({
      id,
      name: `合成员工${String(i + 1).padStart(2, "0")}`,
      title: `合成岗位 ${i + 1}`,
      bio: "合成团队成员 🧶 Synthetic",
      avatar: i % 3 === 2 ? null : avatar,
      role_id: role,
      launch_profile_ref: `synthetic-profile-${(i % 3) + 1}`,
      status: "active",
      created_at: date(-525600),
      updated_at: now,
    });
  });
  const employeeFor = (role) => `E-${roles.indexOf(role) + 1}`;
  for (const [role, mode] of [
    ["pm", "office"],
    ["pm", "ops"],
    ["host_ops", undefined],
  ]) {
    tx.assignments.put(project, {
      id: next("assignment"),
      scope: "standing",
      ...(mode ? { standing_mode: mode } : {}),
      employee_id: employeeFor(role),
      role_id: role,
      role_version: 1,
      status: "active",
      runtime_state: "idle",
      machine_id: "synthetic-machine",
      runtime_ref: null,
      mcp_token_id: "synthetic-unused",
      created_at: date(-10000),
    });
  }

  const cards = [];
  for (let i = 1; i <= size.cards; i++) {
    const template =
      i === 2
        ? "story"
        : i >= 20 && i <= 26
          ? "dev"
          : ["dev", "general", "artifact", "design"][i % 4];
    const status =
      i === 1
        ? "backlog"
        : template === "story"
          ? "in_progress"
          : i >= 20 && i <= 26
            ? "awaiting_merge"
            : i >= 27 && i <= 30
              ? i === 27
                ? "done"
                : "cancelled"
              : [
                  "backlog",
                  "todo",
                  "in_progress",
                  "review",
                  "in_progress",
                  "done",
                  "cancelled",
                ][i % 7];
    const card = {
      id: next("card"),
      project_id: project,
      title:
        i === 3
          ? "超长标题 · Mixed 中文 English 🧶 — ".repeat(12)
          : `合成工坊 ${i} · ${["织纹", "星砂", "云团", "波纹"][random() % 4]}`,
      goal:
        i === 3
          ? "## 合成长正文\n\n中文与 English 混排 🧶✨，用于检查折行与展开。\n\n".repeat(
              200,
            )
          : "核对合成数据下的界面展示。",
      acceptance_criteria:
        i === 1
          ? []
          : ["列表、详情与关联信息可以阅读。", "窄屏与深色主题可以阅读。"],
      source:
        i === 5
          ? { kind: "decision", decision_id: "Q-1" }
          : { kind: "quote", text: "合成需求；未采集真实业务内容。" },
      out_of_scope: [],
      related_cards: i === 4 ? ["C-5"] : i === 5 ? ["C-4"] : [],
      priority: i % 5,
      status,
      ...(status === "done"
        ? { resolution: "done" }
        : status === "cancelled"
          ? {
              resolution:
                i === 28 ? "superseded" : i === 29 ? "duplicate" : "wontdo",
            }
          : {}),
      ...(i === 28 ? { superseded_by: "C-4", related_cards: ["C-4"] } : {}),
      template,
      template_version: 1,
      ...(template === "story" ? { story: {} } : {}),
      ...(i === 16 ? { parent_card_id: "C-2" } : {}),
      merge_policy: template === "dev" ? "confirm" : "none",
      ...(template === "dev"
        ? { repo: "synthetic-repository", base_branch: "main" }
        : {}),
      risk_tags:
        i >= 20 && i <= 26
          ? []
          : ["security", "permission", "numeric_rule"].filter(
              (_, bit) => (i - 6) & 7 & (1 << bit),
            ),
      ...(i === 14 ? { sensitive: true } : {}),
      created_by: "human",
      created_at: date(i === 3 ? -5256000 : -10000 - i),
    };
    cards.push(card);
    tx.cards.put(project, card);
    if (i > 1)
      emit(
        card.id,
        "card_created",
        { card_id: card.id },
        { body: "合成卡片已建立。", type: "status_change" },
        card.created_at,
      );
  }
  // Separate projects exercise empty/single lists without filters on a populated board.
  tx.cards.put("synthetic-single", {
    ...cards[0],
    id: tx.ids.next("synthetic-single", "card"),
    project_id: "synthetic-single",
    title: "合成单卡",
    risk_tags: [],
  });

  const work = [];
  const groups = new Map();
  const assignments = [];
  // Reserve one item for the standing Office; it has no work-item assignment or run.
  for (let i = 0; i < size.work_items - 1; i++) {
    const card = cards[2 + (Math.floor(i / 3) % (cards.length - 2))];
    const position = i % 3;
    const kind = position === 0 ? "produce" : "verify";
    const role =
      position === 0
        ? ["artifact", "design"].includes(card.template)
          ? "ui_ux_designer"
          : "coder"
        : position === 1
          ? card.template === "design"
            ? "design_director"
            : "reviewer"
          : "pm";
    const vocabulary = states[kind];
    let status = vocabulary[Math.floor(i / 3) % vocabulary.length];
    if (card.status === "done" || card.status === "awaiting_merge")
      status = kind === "produce" ? "accepted" : "passed";
    if (card.status === "cancelled") status = "cancelled";
    if (card.status === "backlog" || card.status === "todo") status = "todo";
    // Dedicated examples keep pass/must_fix and every nonterminal work state visible.
    if (card.id === "C-31")
      status = kind === "produce" ? "changes_requested" : "failed";
    if (card.id === "C-32") status = kind === "produce" ? "accepted" : "passed";
    const items = groups.get(card.id) ?? [];
    const item = {
      id: next("work_item"),
      card_id: card.id,
      title: `合成${kind === "produce" ? "产出" : "验证"} ${i + 1}`,
      kind,
      role_id: role,
      required: i % 5 !== 4,
      depends_on: [],
      completion_criteria: ["核对合成展示。"],
      status,
      ...(position === 0
        ? {
            template_key:
              card.template === "design"
                ? "design_production"
                : card.template === "artifact"
                  ? "production"
                  : "development",
          }
        : {
            max_review_rounds: 5,
            template_key:
              position === 2
                ? "pm_acceptance"
                : card.template === "design"
                  ? "design_review"
                  : "code_review",
            ...(position === 1 ? { target_work_item_id: items.at(-1).id } : {}),
          }),
      assignment_id: next("assignment"),
    };
    // Extra scale rows are optional custom work, not duplicate template keys.
    if (items.length >= 3) {
      delete item.template_key;
      item.required = false;
    }
    const assignment = {
      id: item.assignment_id,
      scope: "work_item",
      work_item_id: item.id,
      employee_id: employeeFor(role),
      role_id: role,
      role_version: 1,
      status:
        status === "cancelled"
          ? "released"
          : status === "blocked"
            ? "suspended"
            : "active",
      runtime_state: status === "cancelled" ? "released" : "idle",
      machine_id: "synthetic-machine",
      runtime_ref: null,
      mcp_token_id: "synthetic-unused",
      created_at: date(-5000),
    };
    work.push(item);
    items.push(item);
    groups.set(card.id, items);
    assignments.push(assignment);
    tx.work_items.put(project, item);
    tx.assignments.put(project, assignment);
  }
  tx.work_items.put(project, {
    id: next("work_item"),
    card_id: "C-2",
    template_key: "decomposition",
    title: "拆解",
    kind: "produce",
    role_id: "pm",
    required: true,
    depends_on: [],
    completion_criteria: cards[1].acceptance_criteria,
    status: "in_progress",
  });
  // Map the complete vocabulary onto open cards, independent of scale/distribution.
  for (const kind of ["produce", "verify"]) {
    const available = work.filter(
      (w) =>
        w.kind === kind &&
        !["done", "cancelled", "awaiting_merge", "backlog", "todo"].includes(
          cards[Number(w.card_id.slice(2)) - 1].status,
        ) &&
        !["C-31", "C-32"].includes(w.card_id),
    );
    states[kind].forEach((status, i) => {
      available[i].status = status;
      tx.work_items.put(project, available[i]);
    });
  }
  const firstRuns = new Map();
  for (let i = 0; i < size.runs; i++) {
    const assignment = assignments[i % assignments.length];
    const item = work[i % work.length];
    const status =
      i < assignments.length && i < states.run.length
        ? states.run[i]
        : "completed";
    const run = {
      id: next("run"),
      assignment_id: assignment.id,
      employee_id: assignment.employee_id,
      trigger_event_id: emit(
        item.card_id,
        "run_queued",
        { assignment_id: assignment.id },
        undefined,
        date(-4001 + i / 10),
      ),
      kind: ["initial", "rework", "decision_resumed", "followup", "fix"][i % 5],
      status,
      role_version: 1,
      model: `synthetic-model-${(i % 3) + 1}`,
      harness: ["codex", "pi", "claude-code"][i % 3],
      launch_profile_ref: `synthetic-profile-${(i % 3) + 1}`,
      agent_cli_version: "synthetic",
      effort: i % 2 ? "medium" : "high",
      outcome: ["completed", "failed", "cancelled"].includes(status)
        ? status === "completed"
          ? "completed"
          : "failed"
        : null,
      summary: "合成执行记录",
      ...(status !== "queued" ? { started_at: date(-4000 + i / 10) } : {}),
      ...(["completed", "failed", "cancelled"].includes(status)
        ? { finished_at: date(-3999 + i / 10) }
        : {}),
    };
    tx.runs.put(project, run);
    if (!firstRuns.has(item.id)) firstRuns.set(item.id, run.id);
  }
  const completions = new Map();
  for (const [cardId, items] of groups) {
    const card = cards[Number(cardId.slice(2)) - 1];
    const producer = items[0];
    if (
      !["delivered", "accepted", "changes_requested"].includes(producer.status)
    )
      continue;
    const reviewer = items[1];
    const delivery = {
      id: next("delivery"),
      work_item_id: producer.id,
      run_id: firstRuns.get(producer.id),
      kind: card.template === "dev" ? "code" : "design",
      summary: "合成产出已提交。",
      subject: {
        kind: card.template === "dev" ? "git_head" : "doc_version",
        value:
          card.template === "dev" ? sha(Number(cardId.slice(2))) : "合成版本一",
      },
      evidence: [],
      attachments: [],
      known_gaps: [],
      requested_verifiers: [reviewer.id],
      status:
        producer.status === "changes_requested"
          ? "rejected"
          : producer.status === "accepted"
            ? "accepted"
            : "submitted",
    };
    tx.deliveries.put(project, delivery);
    emit(
      cardId,
      "delivery_submitted",
      { delivery_id: delivery.id, work_item_id: producer.id },
      {
        type: "delivery",
        body: delivery.summary,
        delivery_id: delivery.id,
        work_item_id: producer.id,
        run_id: delivery.run_id,
        author: `assignment:${producer.assignment_id}`,
      },
    );
    if (["passed", "failed"].includes(reviewer.status)) {
      const pass = reviewer.status === "passed";
      const review = {
        id: next("review"),
        delivery_id: delivery.id,
        target_sha: delivery.subject.value,
        work_item_id: reviewer.id,
        run_id: firstRuns.get(reviewer.id),
        kind: card.template === "dev" ? "code" : "design",
        issues: pass
          ? []
          : [
              {
                severity: "major",
                description: "合成 must_fix：窄屏长标题需要折行。",
                must_fix: true,
                pre_existing: false,
              },
            ],
        verdict: pass ? "pass" : "reject",
        blocking: !pass,
        recheck_required: !pass,
        attachments: [],
      };
      tx.reviews.put(project, review);
      emit(
        cardId,
        "review_submitted",
        {
          review_id: review.id,
          delivery_id: delivery.id,
          verdict: review.verdict,
        },
        {
          type: "review",
          body: pass ? "合成审核通过。" : "合成审核要求修改。",
          delivery_id: delivery.id,
          work_item_id: reviewer.id,
          run_id: review.run_id,
          author: `assignment:${reviewer.assignment_id}`,
        },
      );
    }
    if (card.status === "awaiting_merge" || card.status === "done") {
      const completion = {
        ...delivery,
        id: next("delivery"),
        kind: "card_completion",
        summary: "合成验收标准均已覆盖。",
        plain_summary: plainSummary,
        requested_verifiers: card.template === "design" ? [] : [items[2].id],
        status: "accepted",
      };
      completions.set(cardId, completion);
      tx.deliveries.put(project, completion);
      emit(
        cardId,
        "delivery_submitted",
        { delivery_id: completion.id, work_item_id: producer.id },
        {
          type: "delivery",
          body: completion.summary,
          delivery_id: completion.id,
          work_item_id: producer.id,
          run_id: completion.run_id,
        },
      );
      if (completion.requested_verifiers.length) {
        const reviewer = items[2];
        const review = {
          id: next("review"),
          delivery_id: completion.id,
          target_sha: completion.subject.value,
          work_item_id: reviewer.id,
          run_id: firstRuns.get(reviewer.id),
          kind: "product",
          issues: [],
          verdict: "pass",
          blocking: false,
          recheck_required: false,
          attachments: [],
        };
        tx.reviews.put(project, review);
        emit(
          cardId,
          "review_submitted",
          { review_id: review.id, delivery_id: completion.id, verdict: "pass" },
          {
            type: "review",
            body: "合成完成验收通过。",
            delivery_id: completion.id,
            work_item_id: reviewer.id,
            run_id: review.run_id,
            author: `assignment:${reviewer.assignment_id}`,
          },
        );
      }
      if (card.status === "awaiting_merge") {
        const status = MERGE_STATUSES[Number(cardId.slice(2)) - 20];
        const payload = {
          attempt_id: `synthetic-check-${cardId}`,
          completion_id: completion.id,
          candidate_sha: completion.subject.value,
          tree_sha: sha(Number(cardId.slice(2)) + 1000),
          status,
          checks: ["queued", "running"].includes(status)
            ? []
            : [
                {
                  name: "合成检查",
                  status:
                    status === "executor_unreachable" ? "not_run" : status,
                  duration_ms: 123,
                },
              ],
          summary: "合成合并检查结果",
          updated_at: now,
        };
        emit(
          cardId,
          status === "queued"
            ? "merge_check_queued"
            : status === "running"
              ? "merge_check_started"
              : "merge_check_finished",
          payload,
          { body: `合成检查：${status}` },
        );
      }
    }
  }

  for (let i = 1; i <= size.decisions; i++) {
    const merge = i >= 5 && i <= 11;
    const cardId = merge
      ? `C-${i + 15}`
      : i === 2
        ? "C-3"
        : i === 1
          ? "C-4"
          : `C-${4 + (i % (cards.length - 4))}`;
    const category =
      merge || i === 4 || i === 12
        ? "general"
        : decisionCategories[(i - 1) % decisionCategories.length];
    const status =
      i === 1 || i === 4
        ? "resolved"
        : i <= 3
          ? "open"
          : merge
            ? states.decision[i - 5]
            : states.decision[(i - 12) % states.decision.length];
    const delegated =
      i === 4 ||
      (i >= 12 &&
        ["general", "feature_detail"].includes(category) &&
        i % 2 === 0);
    const id = next("decision");
    const kind = merge || i % 2 === 0 ? "approve" : "choose";
    const resolution = {
      option: merge ? "merge" : "continue",
      rationale: "合成核对已完成。",
      resolved_by: delegated ? "assignment:A-2" : "human",
      via: delegated ? "delegated" : "needs_you",
      raw_quote: "合成确认",
      via_chain: [],
      at: date(-60),
      ...(delegated
        ? {
            notice: "合成知会：展示核对已完成。",
            proxy_authority: "synthetic-delegation",
          }
        : {}),
    };
    const decision = {
      id,
      key: id,
      card_id: cardId,
      raised_by: "assignment:A-2",
      kind,
      category,
      question: `合成拍板 ${i} · ${merge ? "是否合并" : "选择展示方案"}？`,
      context: "合成上下文，全部选项仅用于展示。",
      options: merge
        ? [
            { key: "merge", description: "合并", impact: "合成展示" },
            { key: "hold", description: "暂缓", impact: "保留当前展示" },
            {
              key: "request_changes",
              description: "退回修改",
              impact: "显示修改要求",
            },
          ]
        : [
            { key: "continue", description: "继续", impact: "展示下一步" },
            { key: "pause", description: "暂缓", impact: "保留当前展示" },
          ],
      recommended: merge ? "merge" : "continue",
      plain_summary: plainSummary,
      ...(i === 2
        ? { attachment_ids: ["attachment-1", "attachment-2", "attachment-3"] }
        : {}),
      affected_cards: [cardId],
      affected_work_items: [],
      blocking: i % 3 === 0,
      decider: delegated ? "role:pm" : "human",
      doc_refs: [],
      status,
      ...(kind === "approve"
        ? {
            target: merge
              ? { delivery_id: completions.get(cardId).id }
              : { subject: { kind: "doc_version", value: "合成方案一" } },
          }
        : {}),
      ...(merge ? { trigger: "merge_confirmation" } : {}),
      ...(i === 2 || i === 3 ? { latest_by: date(i === 2 ? 5 : -5) } : {}),
      ...(["resolved", "provisional", "revoked"].includes(status)
        ? { resolution }
        : {}),
      ...(status === "superseded" ? { superseded_by: "Q-2" } : {}),
      ...(status === "snoozed"
        ? {
            snooze: {
              reason: "合成暂缓",
              until: date(30),
              at: date(-30),
              by: "human",
            },
          }
        : {}),
    };
    tx.decisions.put(project, decision);
    emit(
      cardId,
      "decision_requested",
      { decision_id: id },
      { type: "decision_request", body: decision.question, decision_id: id },
      date(-120),
    );
    if (decision.resolution)
      emit(
        cardId,
        "decision_resolved",
        { decision_id: id, ...resolution },
        {
          type: "decision_resolved",
          body: resolution.rationale,
          decision_id: id,
        },
        resolution.at,
        actorFor({ id: "A-2", role_id: "pm" }),
      );
  }
  for (let i = 0; i < 9; i++) {
    const id = next("human_action");
    const status = states.human_action[Math.floor(i / 3)];
    const triage = ["pm_ops", "human", "host"][i % 3];
    const action = {
      id,
      key: id,
      card_id: "C-4",
      requested_by: "assignment:A-2",
      instructions: "请核对合成图案的显示。",
      why_human: "需要人工观察图案。",
      expected_return: "记录合成核对结果。",
      triage,
      triage_rationale: "合成分拣结果。",
      blocked_work_items: [],
      status,
      ...(i === 2 ? { blocks_merge: true } : {}),
      ...(triage !== "pm_ops"
        ? {
            handoff: {
              title: "核对合成图案",
              summary: "合成展示事项。",
              why_human: "需要人工观察。",
              instructions: "打开合成卡片查看图案。",
              expected_outcome: "展示完整。",
              expected_return: "记录结果。",
              rewritten_by: "assignment:A-2",
              rewritten_at: now,
            },
          }
        : {}),
      ...(status !== "open"
        ? { result: { text: "合成事项已收尾。", attachments: [], at: now } }
        : {}),
    };
    tx.human_actions.put(project, action);
    emit(
      "C-4",
      "human_action_requested",
      { human_action_id: id },
      { type: "human_action", body: action.instructions, human_action_id: id },
    );
  }
  for (let i = 0; i < size.attachments; i++) {
    const blob = blobs[i % blobs.length];
    const cardId = i < 12 ? "C-3" : `C-${4 + (i % (cards.length - 4))}`;
    tx.attachments.put(project, {
      id: tx.ids.nextAttachmentId(project),
      ...blob,
      mime: ["image/png", "text/plain", "application/json"][i % 3],
      original_filename: `合成占位-${i + 1}.${["png", "txt", "json"][i % 3]}`,
      note: "全部内容由生成器构造。",
      card_id: cardId,
      uploaded_by: "human",
      storage_path: `attachments/${blob.sha256}`,
      attach_to: { kind: "timeline_entry", id: firstEntries.get(cardId) },
      kind: "evidence",
    });
  }
  // Exactly 300 timeline entries on the long-content card, then distribute the rest.
  let longCount = tx.timeline
    .list(project)
    .filter((entry) => entry.card_id === "C-3").length;
  while (longCount++ < 300)
    emit(
      "C-3",
      "comment_posted",
      { body: "合成长时间线评论 🧶" },
      {
        type: "comment",
        author: "human",
        body: `合成长时间线 ${longCount} · 中英 Mixed ✨`,
      },
      date(-5256000 + longCount * 10000),
    );
  while (counts.timeline < size.timeline) {
    const cardId = `C-${4 + (counts.timeline % (cards.length - 3))}`;
    const body = `合成讨论 ${counts.timeline}：布局与细节 ${random() % 1000}。`;
    emit(
      cardId,
      "comment_posted",
      { body },
      { type: "comment", body, author: "human" },
      date(-1000 + counts.timeline / 100),
    );
  }
  while (counts.events < size.events)
    emit(
      `C-${4 + (counts.events % (cards.length - 3))}`,
      "fixture_observed",
      { synthetic: true, ordinal: counts.events },
      undefined,
      date(-500 + counts.events / 1000),
    );
  if (counts.timeline !== size.timeline || counts.events !== size.events)
    throw new Error("合成场景超过档位预算");
}
