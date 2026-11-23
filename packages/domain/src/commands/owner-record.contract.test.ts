import { describe, expect, test } from "vitest";
import {
  type Actor,
  type Assignment,
  type Attachment,
  type CommandEffect,
  type CommandState,
  type DecisionCategory,
  type Delivery,
  decisionHistory,
  postComment,
  type Result,
  recordDecision,
  requestDecision,
  resolveDelegatedDecision,
  standingTools,
  type TimelineEntry,
} from "../index.js";
import {
  actor,
  apply,
  assignment,
  fixture,
  human,
  id,
  now,
  ports,
  role,
  subject,
  value,
} from "./test-fixtures.js";

/**
 * C-617: PM Ops links the owner's answer already on the card to a PM-routed
 * decision. Linking never adds authority and never resolves twice.
 */
function setup() {
  let state = fixture();
  const io = ports();
  const { work_item_id: _work, ...base } = assignment(4, "pm");
  const ops: Assignment = { ...base, scope: "standing", standing_mode: "ops" };
  const office: Assignment = {
    ...base,
    id: id("assignment", 5),
    scope: "standing",
    standing_mode: "office",
  };
  state = {
    ...state,
    assignments: [
      ...state.assignments.filter((a) => a.id !== ops.id),
      ops,
      office,
    ],
  };
  const identity = (a: Assignment): Actor => ({
    kind: "assignment",
    project_id: human.project_id,
    assignment_id: a.id,
    ...role("pm"),
    allowed_tools: standingTools(
      role("pm").allowed_tools,
      a.standing_mode ?? "ops",
    ),
  });
  function commit<T>(result: Result<CommandEffect<T>>) {
    const effect = value(result);
    state = apply(state, effect);
    return effect.data;
  }
  const request = (
    category: DecisionCategory = "general",
    extra: {
      affected_work_items?: ReturnType<typeof id<"work_item">>[];
      wide?: boolean;
      firstKey?: string;
      subject?: Delivery["subject"];
    } = {},
  ) =>
    commit(
      requestDecision(
        state,
        extra.wide ? identity(office) : actor(),
        {
          card_id: id("card", 1),
          category,
          ...(extra.subject
            ? { kind: "approve" as const, target: { subject: extra.subject } }
            : { kind: "choose" as const }),
          question: "拆卡还是并入？",
          context: "补充的三项",
          options: [
            {
              key: extra.firstKey ?? "split",
              description: "拆成后续卡",
              impact: "本卡不变",
            },
            { key: "merge_in", description: "并入本卡", impact: "范围扩大" },
          ],
          recommended: extra.firstKey ?? "split",
          affected_cards: extra.wide
            ? [id("card", 1), id("card", 2)]
            : [id("card", 1)],
          affected_work_items: extra.affected_work_items ?? [],
          blocking: false,
          decider: "role:pm",
        },
        io,
      ),
    );
  const comment = (
    body: string,
    extra: Partial<Pick<TimelineEntry, "refs" | "reply_to" | "supersedes">> & {
      card?: number;
      by?: Actor;
    } = {},
  ) => {
    const { card = 1, by = human, ...rest } = extra;
    const effect = value(
      postComment(state, by, { card_id: id("card", card), body, ...rest }, io),
    );
    state = apply(state, effect);
    const entry = effect.timeline[0];
    if (!entry) throw new Error("no timeline entry");
    return entry;
  };
  const pm = identity(ops);
  const link = (
    decision_id: ReturnType<typeof request>["id"],
    owner_record: {
      timeline_entry_id: TimelineEntry["id"];
      attachment_id?: Attachment["id"];
    },
    option = "split",
    extra: Record<string, unknown> = {},
  ) =>
    resolveDelegatedDecision(
      state,
      pm,
      {
        decision_id,
        option,
        rationale: "所有者已在卡上明确选择拆卡",
        owner_record,
        ...extra,
      },
      io,
    );
  return {
    get state() {
      return state;
    },
    set state(next: CommandState) {
      state = next;
    },
    io,
    pm,
    front: identity(office),
    commit,
    request,
    comment,
    link,
  };
}

const error = (r: Result<unknown>) => (r.ok ? undefined : r.error);

describe("owner record linking", () => {
  test("records the owner's quote, source and time apart from the registrar", () => {
    const f = setup();
    const q = f.request();
    expect(q.decider).toBe("role:pm");
    const entry = f.comment(`${q.id} 选 split，这三项分开做`);
    const resolved = f.commit(f.link(q.id, { timeline_entry_id: entry.id }));
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolution).toMatchObject({
      option: "split",
      via: "delegated",
      resolved_by: `assignment:${id("assignment", 4)}`,
      // Q-1198: the formal answer and rationale are PM's own.
      raw_quote: "所有者已在卡上明确选择拆卡",
      rationale: "所有者已在卡上明确选择拆卡",
      owner_record: {
        author: "human",
        card_id: id("card", 1),
        timeline_entry_id: entry.id,
        quote: entry.body,
        at: now,
      },
    });
    expect(resolved.resolution?.owner_record).not.toHaveProperty(
      "registered_by",
    );
    const event = f.state.events.findLast(
      (e) => e.type === "decision_resolved",
    );
    expect(event?.payload).toMatchObject({
      owner_record: { timeline_entry_id: entry.id, author: "human" },
    });
    const body = f.state.timeline.findLast(
      (e) => e.type === "decision_resolved",
    )?.body;
    // PM's answer first; the owner's words follow as cited evidence.
    expect(body?.startsWith("所有者已在卡上明确选择拆卡")).toBe(true);
    expect(body).toContain(`依据：所有者原话（${entry.id}，${now}）`);
    expect(body).toContain(`> ${entry.body}`);
    // History: PM decided under delegation; never shown as the owner's own confirmation.
    const history = decisionHistory(f.state).find((h) => h.id === q.id);
    expect(history?.decision_maker).toBe("pm");
    expect(
      decisionHistory(f.state, { decider: "human" }).map((h) => h.id),
    ).not.toContain(q.id);
    expect(history?.resolution.owner_record?.author).toBe("human");
    // One decision cannot be closed twice, even with the same record.
    expect(error(f.link(q.id, { timeline_entry_id: entry.id }))?.code).toBe(
      "stale_target",
    );
  });

  test("accepts a reply to the decision request and an affected card", () => {
    const f = setup();
    const q = f.request("general", { wide: true });
    const request = f.state.timeline.find(
      (e) =>
        e.type === "decision_request" &&
        e.decision_id === q.id &&
        e.card_id === id("card", 2),
    );
    expect(request).toBeDefined();
    const entry = f.comment("选择：并入本卡", {
      card: 2,
      reply_to: request?.id as TimelineEntry["id"],
    });
    const resolved = f.commit(
      f.link(q.id, { timeline_entry_id: entry.id }, "merge_in"),
    );
    expect(resolved.resolution?.owner_record?.card_id).toBe(id("card", 2));
  });

  test("keeps an owner-uploaded attachment on the quoted entry", () => {
    const f = setup();
    const q = f.request();
    const entry = f.comment(`${q.id}：选 split，见标注图`);
    const file = (n: number, extra: Partial<Attachment> = {}): Attachment =>
      ({
        id: `att-${n}`,
        sha256: "b".repeat(64),
        mime: "image/png",
        size: 1,
        card_id: id("card", 1),
        uploaded_by: "human",
        storage_path: "x",
        attach_to: { kind: "timeline_entry", id: entry.id },
        kind: "evidence",
        ...extra,
      }) as Attachment;
    f.state = {
      ...f.state,
      attachments: [
        file(1),
        file(2, { uploaded_by: `assignment:${id("assignment", 4)}` }),
      ],
    };
    expect(
      error(
        f.link(q.id, {
          timeline_entry_id: entry.id,
          attachment_id: "att-2",
        }),
      )?.message,
    ).toContain("附件须由所有者本人上传");
    const resolved = f.commit(
      f.link(q.id, {
        timeline_entry_id: entry.id,
        attachment_id: "att-1",
      }),
    );
    expect(resolved.resolution?.owner_record?.attachment_id).toBe("att-1");
    expect(
      f.state.timeline.findLast((e) => e.type === "decision_resolved")?.body,
    ).toContain(`附件 ${"att-1"}`);
  });

  test("rejects records that are not the owner's own explicit answer", () => {
    const f = setup();
    const q = f.request();
    const byAgent = f.comment(`${q.id} 所有者说 split`, { by: f.pm });
    expect(
      error(f.link(q.id, { timeline_entry_id: byAgent.id }))?.message,
    ).toContain("不认代理转述");
    const unbound = f.comment("split 吧");
    expect(
      error(f.link(q.id, { timeline_entry_id: unbound.id }))?.message,
    ).toContain(`引用 ${q.id}`);
    const vague = f.comment(`${q.id} 按你们的意思办`);
    expect(
      error(f.link(q.id, { timeline_entry_id: vague.id }))?.message,
    ).toContain("明确写出所选选项");
    const both = f.comment(`${q.id} split 或 merge_in 都行`);
    expect(
      error(f.link(q.id, { timeline_entry_id: both.id }))?.message,
    ).toContain("不提及其它选项");
    const other = f.comment(`${q.id} 选 merge_in`);
    // The option PM submits must be the one the owner wrote.
    expect(
      error(f.link(q.id, { timeline_entry_id: other.id }, "split"))?.code,
    ).toBe("validation_failed");
    expect(f.state.decisions.find((d) => d.id === q.id)?.status).toBe("open");
  });

  test.each([
    ["bare mention", "Q split"],
    ["negation", "Q 不选 split"],
    ["question", "Q 选 split？"],
    ["question word", "Q 选 split 吗"],
    ["hedge", "Q 选 split 还是再想想"],
    ["english negation", "Q don't choose split"],
  ])("rejects an unclear answer: %s", (_name, body) => {
    const f = setup();
    const q = f.request();
    const entry = f.comment(body.replace("Q", q.id));
    expect(
      error(f.link(q.id, { timeline_entry_id: entry.id }))?.message,
    ).toContain("明确写出所选选项");
  });

  test("a reply in the answer's thread overtakes it even without citing the decision", () => {
    const f = setup();
    const q = f.request();
    const entry = f.comment(`${q.id} 选 split`);
    const reply = f.comment("算了，再等等", { reply_to: entry.id });
    expect(
      error(f.link(q.id, { timeline_entry_id: entry.id }))?.message,
    ).toContain(reply.id);
  });

  test("rejects answers given before the question, superseded, or overtaken", () => {
    const f = setup();
    const q = f.request();
    const early: TimelineEntry = {
      id: "C-1#0" as TimelineEntry["id"],
      short_id: "C-1#0" as TimelineEntry["id"],
      card_id: id("card", 1),
      event_seq: 0,
      type: "comment",
      author: "human",
      refs: [{ kind: "decision", id: q.id }],
      retracted: false,
      body: `${q.id} 选 split`,
      mentions: [],
      created_at: now,
    };
    f.state = { ...f.state, timeline: [early, ...f.state.timeline] };
    expect(
      error(f.link(q.id, { timeline_entry_id: early.id }))?.message,
    ).toContain("提出之后");
    const first = f.comment(`${q.id} 选 split`);
    const edited = f.comment(`${q.id} 选 merge_in`, { supersedes: first.id });
    expect(
      error(f.link(q.id, { timeline_entry_id: first.id }))?.message,
    ).toContain("已撤回或已被改写");
    const later = f.comment(`${q.id} 改选 split`);
    expect(
      error(f.link(q.id, { timeline_entry_id: edited.id }, "merge_in"))
        ?.message,
    ).toContain(later.id);
    f.commit(f.link(q.id, { timeline_entry_id: later.id }));
  });

  test("rejects other cards and other projects", () => {
    const f = setup();
    const q = f.request();
    const foreign: TimelineEntry = {
      id: "C-9#1" as TimelineEntry["id"],
      short_id: "C-9#1" as TimelineEntry["id"],
      card_id: id("card", 9),
      event_seq: 99,
      type: "comment",
      author: "human",
      refs: [{ kind: "decision", id: q.id }],
      retracted: false,
      body: `${q.id} 选 split`,
      mentions: [],
      created_at: now,
    };
    const card9 = {
      ...f.state.cards[0],
      id: id("card", 9),
    } as CommandState["cards"][number];
    f.state = {
      ...f.state,
      cards: [...f.state.cards, { ...card9, project_id: "other" as never }],
      timeline: [...f.state.timeline, foreign],
    };
    expect(
      error(f.link(q.id, { timeline_entry_id: foreign.id }))?.message,
    ).toContain("本项目");
    f.state = {
      ...f.state,
      cards: [...f.state.cards.filter((c) => c.id !== card9.id), card9],
    };
    // Same project but neither the decision card nor an affected card.
    expect(
      error(f.link(q.id, { timeline_entry_id: foreign.id }))?.message,
    ).toContain("受影响的卡片");
  });

  test.each([true, false])(
    "rejects a record when the deliveries changed after the answer (work item listed: %s)",
    (listed) => {
      const f = setup();
      const q = f.request("general", {
        affected_work_items: listed ? [id("work_item", 1)] : [],
      });
      const entry = f.comment(`${q.id} 选 split`);
      const delivery: Delivery = {
        id: id("delivery", 1),
        work_item_id: id("work_item", 1),
        run_id: id("run", 1),
        kind: "code",
        summary: "新版本",
        subject,
        evidence: [],
        attachments: [],
        known_gaps: [],
        requested_verifiers: [],
        status: "submitted",
      } as Delivery;
      const seq = Math.max(
        ...f.state.events
          .filter((e) => e.card_id === id("card", 1))
          .map((e) => e.seq),
      );
      f.state = {
        ...f.state,
        deliveries: [delivery],
        events: [
          ...f.state.events,
          {
            id: "E-delivery" as never,
            card_id: id("card", 1),
            seq: seq + 1,
            type: "delivery_submitted",
            actor: actor(),
            payload: { delivery_id: delivery.id, superseded: [] },
            created_at: now,
          },
        ],
      };
      expect(
        error(f.link(q.id, { timeline_entry_id: entry.id }))?.message,
      ).toContain("交付有变化");
    },
  );

  test("never adds authority: human-only, undelegated and routing rules stay", () => {
    const f = setup();
    const spending = f.request("spending");
    const quote = f.comment(`${spending.id} 选 split`);
    const spendingResult = f.link(spending.id, { timeline_entry_id: quote.id });
    expect(spending.decider).toBe("role:pm");
    expect(error(spendingResult)?.message).toContain(
      "所有者原话不构成新的授权",
    );
    expect(
      f.state.decisions.find((d) => d.id === spending.id)?.status,
    ).not.toBe("resolved");

    const q = f.request();
    const entry = f.comment(`${q.id} 选 split`);
    const humanOnly = {
      ...(f.state.decisions.find(
        (d) => d.id === q.id,
      ) as CommandState["decisions"][number]),
      human_required_reason: "须由人亲自确认",
    };
    const saved = f.state;
    f.state = {
      ...saved,
      decisions: [...saved.decisions.filter((d) => d.id !== q.id), humanOnly],
    };
    expect(
      error(f.link(q.id, { timeline_entry_id: entry.id }))?.message,
    ).toMatch(/无须由人亲自确认|未授权/);
    f.state = saved;
    // Cannot be smuggled into an escalation or another basis.
    expect(
      error(
        f.link(q.id, { timeline_entry_id: entry.id }, "split", {
          escalate: true,
        }),
      )?.message,
    ).toContain("不能与交人");
    // PM Office still cannot record a PM-routed decision, quote or not.
    const office = recordDecision(
      f.state,
      f.front,
      {
        decision_id: q.id,
        option: "split",
        rationale: "转录",
        raw_quote: entry.body,
      },
      f.io,
    );
    expect(office.ok).toBe(false);
    expect(error(office)?.message).toContain("PM Office 不能代记");
    f.commit(f.link(q.id, { timeline_entry_id: entry.id }));
  });

  test("a resolution without an owner record is unchanged", () => {
    const f = setup();
    const q = f.request();
    const resolved = f.commit(
      resolveDelegatedDecision(
        f.state,
        f.pm,
        { decision_id: q.id, option: "split", rationale: "按授权拆卡" },
        f.io,
      ),
    );
    expect(resolved.resolution?.owner_record).toBeUndefined();
    expect(resolved.resolution?.raw_quote).toBe("按授权拆卡");
  });
  test.each([
    ["negation inside the clause", "Q 不要选 split，等实测"],
    ["negation without hedge", "Q 不要选 split"],
    ["english negation", "Q we should not pick split"],
  ])("V-3045: a negated choice stays open (%s)", (_name, body) => {
    const f = setup();
    const q = f.request();
    const entry = f.comment(body.replace("Q", q.id));
    expect(f.link(q.id, { timeline_entry_id: entry.id }).ok).toBe(false);
    expect(f.state.decisions.find((d) => d.id === q.id)?.status).toBe("open");
    expect(
      f.state.events.some(
        (e) =>
          e.type === "decision_resolved" &&
          (e.payload as { decision_id?: string }).decision_id === q.id,
      ),
    ).toBe(false);
  });

  test("V-3045: a choice addressed to another decision stays open", () => {
    const f = setup();
    const q1 = f.request();
    const q2 = f.request();
    const entry = f.comment(`${q1.id} 先放着，${q2.id} 选 split`);
    expect(
      error(f.link(q1.id, { timeline_entry_id: entry.id }))?.message,
    ).toContain(q2.id);
    expect(f.state.decisions.find((d) => d.id === q1.id)?.status).toBe("open");
    // A clean, unique answer to the same decision still links.
    const clean = f.comment(`${q1.id} 选 split`);
    expect(
      f.commit(f.link(q1.id, { timeline_entry_id: clean.id })).status,
    ).toBe("resolved");
  });

  test("V-3045: option keys with hyphens match literally instead of throwing", () => {
    const f = setup();
    const q = f.request("general", { firstKey: "follow-up" });
    const other = f.comment(`${q.id} 选 merge_in`);
    expect(
      error(f.link(q.id, { timeline_entry_id: other.id }, "follow-up"))?.code,
    ).toBe("validation_failed");
    const entry = f.comment(`${q.id} 选 follow-up`);
    const resolved = f.commit(
      f.link(q.id, { timeline_entry_id: entry.id }, "follow-up"),
    );
    expect(resolved.resolution?.option).toBe("follow-up");
  });

  test("V-3045: an approval bound by full subject resolves to its one current delivery", () => {
    const f = setup();
    const delivery = {
      id: id("delivery", 1),
      work_item_id: id("work_item", 1),
      run_id: id("run", 1),
      kind: "code",
      summary: "当前版本",
      subject,
      evidence: [],
      attachments: [],
      known_gaps: [],
      requested_verifiers: [],
      status: "accepted",
    } as Delivery;
    f.state = {
      ...f.state,
      deliveries: [delivery],
      events: [
        ...f.state.events,
        {
          id: "E-delivery" as never,
          card_id: id("card", 1),
          seq: 1,
          type: "delivery_submitted",
          actor: actor(),
          payload: { delivery_id: delivery.id, superseded: [] },
          created_at: now,
        },
      ],
    };
    const q = f.request("general", { subject });
    const entry = f.comment(`${q.id} 选 split`);
    // Superseded or missing versions are still stale.
    const saved = f.state;
    f.state = {
      ...saved,
      deliveries: [{ ...delivery, status: "superseded" }],
    };
    expect(error(f.link(q.id, { timeline_entry_id: entry.id }))?.code).toBe(
      "stale_target",
    );
    f.state = saved;
    expect(f.commit(f.link(q.id, { timeline_entry_id: entry.id })).status).toBe(
      "resolved",
    );
  });

  test("V-3045: an edited change of mind in the answer's thread keeps the old answer open", () => {
    const f = setup();
    const q = f.request();
    const first = f.comment(`${q.id} 选 split`);
    const changed = f.comment("改选 merge_in", { reply_to: first.id });
    const edited = f.comment("改选 merge_in（更正措辞）", {
      supersedes: changed.id,
    });
    expect(
      error(f.link(q.id, { timeline_entry_id: first.id }))?.message,
    ).toContain(edited.id);
    expect(f.state.decisions.find((d) => d.id === q.id)?.status).toBe("open");
  });

  test("V-3045: a quote on a sensitive card is not copied onto a less restricted card", () => {
    const f = setup();
    const q = f.request("general", { wide: true });
    f.state = {
      ...f.state,
      cards: f.state.cards.map((c) =>
        c.id === id("card", 2) ? { ...c, sensitive: true } : c,
      ),
    };
    const entry = f.comment(`${q.id} 选 split`, { card: 2 });
    expect(
      error(f.link(q.id, { timeline_entry_id: entry.id }))?.message,
    ).toContain("敏感卡");
    expect(
      f.state.timeline.some(
        (e) =>
          e.card_id === id("card", 1) &&
          e.body.includes(entry.body) &&
          e.id !== entry.id,
      ),
    ).toBe(false);
  });
});
