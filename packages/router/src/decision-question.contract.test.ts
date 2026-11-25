import {
  postComment,
  type TimelineEntry,
  updateWorkItem,
} from "@cardigan/domain";
import { expect, test } from "vitest";
import { heldReviewer } from "../../domain/src/commands/decision-question/test-fixtures.js";
import { required } from "../../domain/src/commands/flow-review-limit/test-fixtures.js";
import { routeEvent } from "./route.js";

test.each(["legacy", "disputed"] as const)(
  "C-619 %s decision: the bound question wakes only the held reviewer and the reply reaches PM Ops",
  async (path) => {
    const s = await heldReviewer(path);
    const { f, q } = s;
    const route = () =>
      routeEvent({ event: s.lastEvent(), snapshot: f.state }).notifications;

    // An ordinary PM comment on the card does not ring the waiting reviewer.
    f.commit(
      postComment(
        f.state,
        s.pm,
        { card_id: f.card.id, body: "请看方案" },
        f.io,
      ),
    );
    expect(route().map((n) => n.recipient.assignment_id)).not.toContain(
      f.reviewer.id,
    );

    const entry = required(f.commit(s.ask())) as TimelineEntry;
    const asked = s.lastEvent();
    const bells = route();
    expect(bells).toEqual([
      expect.objectContaining({
        recipient: { kind: "assignment", assignment_id: f.reviewer.id },
        kind: "instruction",
        work_item_id: s.verifierId,
        summary: expect.stringContaining("不能提交审核结论"),
      }),
    ]);
    expect(bells[0]?.summary).toContain(q.id);

    // The asked reviewer's reply goes back to PM Ops; nobody else's does.
    f.commit(s.queue(asked));
    f.start(f.reviewer);
    f.commit(
      postComment(
        f.state,
        f.actor(f.reviewer),
        { card_id: f.card.id, body: "方向同意。", reply_to: entry.id },
        f.io,
      ),
    );
    expect(route()).toContainEqual(
      expect.objectContaining({
        recipient: { kind: "pm_ops" },
        rule: "6.4/decision question answered",
        summary: expect.stringContaining(q.id),
      }),
    );
    s.finish(f.reviewer);
    f.start(f.coder);
    f.commit(
      postComment(
        f.state,
        f.actor(f.coder),
        { card_id: f.card.id, body: "补充一点。", reply_to: entry.id },
        f.io,
      ),
    );
    expect(
      route().filter((n) => n.rule === "6.4/decision question answered"),
    ).toEqual([]);

    // Once the decision is settled the old question never rings again.
    f.commit(
      updateWorkItem(
        f.state,
        s.pm,
        {
          work_item_id: s.verifierId,
          review_limit_decision: {
            decision_id: q.id,
            option: "raise_limit",
            rationale: "审核员已确认方向",
          },
        },
        f.io,
      ),
    );
    expect(
      routeEvent({ event: asked, snapshot: f.state }).notifications,
    ).toEqual([]);
  },
);
