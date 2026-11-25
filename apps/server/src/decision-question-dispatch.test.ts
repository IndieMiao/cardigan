import { postComment, updateWorkItem } from "@cardigan/domain";
import { expect, test } from "vitest";
import { heldReviewer } from "../../../packages/domain/src/commands/decision-question/test-fixtures.js";
import { notificationBlocked } from "./candidate-index.js";

test.each(["legacy", "disputed"] as const)(
  "C-619 %s decision: the dispatcher admits only the current bound question for the held reviewer",
  async (path) => {
    const s = await heldReviewer(path);
    const { f, q } = s;
    const blocked = () =>
      notificationBlocked(f.state, s.lastEvent().id, f.reviewer.id);
    f.commit(
      postComment(
        f.state,
        s.pm,
        { card_id: f.card.id, body: "请看方案", mentions: [f.reviewer.id] },
        f.io,
      ),
    );
    expect(blocked()).toBe(true);
    f.commit(s.ask());
    const asked = s.lastEvent();
    expect(blocked()).toBe(false);
    // Another Assignment is never admitted on this question.
    expect(notificationBlocked(f.state, asked.id, f.coder.id)).toBe(true);
    f.commit(
      updateWorkItem(
        f.state,
        s.pm,
        {
          work_item_id: s.verifierId,
          review_limit_decision: {
            decision_id: q.id,
            option: "raise_limit",
            rationale: "已确认方向",
          },
        },
        f.io,
      ),
    );
    expect(notificationBlocked(f.state, asked.id, f.reviewer.id)).toBe(true);
  },
);
