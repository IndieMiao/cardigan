import type { DecisionView } from "../api.js";

/** Keep the human-only reason visible without opening the detailed context. */
export function DecisionRouting({ decision }: { decision: DecisionView }) {
  if (decision.human_required_reason)
    return (
      <p className="decision-routing">
        <strong>须由你亲自决定：</strong>
        {decision.human_required_reason}
      </p>
    );
  if (decision.decider === "role:pm" && decision.delegation_authority)
    return <p className="decision-routing">已按常驻授权转给 PM</p>;
  return null;
}
