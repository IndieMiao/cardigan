import { useRef, useState } from "react";
import {
  type CardiganClient,
  type CardView,
  describeWriteError,
} from "../api.js";
import { RequestFeedback } from "./RequestFeedback.js";
import { Button } from "./ui/button.js";

export function CardHoldDetails({
  card,
  compact = false,
}: {
  card: Pick<CardView, "hold">;
  compact?: boolean;
}) {
  if (!card.hold) return null;
  return (
    <div className={`card-hold-details${compact ? " card-hold-compact" : ""}`}>
      <strong className="card-hold-tag">已暂停</strong>
      <p title={compact ? card.hold.reason : undefined}>
        原因：{card.hold.reason}
      </p>
      <p title={compact ? card.hold.resume_condition : undefined}>
        恢复条件：{card.hold.resume_condition}
      </p>
    </div>
  );
}

/**
 * C-700: pausing and editing the pause moved to the ⋯ menu (a dialog); while
 * a card is paused, resuming stays here as a direct action.
 */
export function CardHoldActions({
  card,
  client,
  projectId,
  onSaved,
  disabled = false,
}: {
  card: CardView;
  client: CardiganClient;
  projectId: string;
  onSaved: () => void;
  disabled?: boolean;
}) {
  const closed = ["done", "cancelled"].includes(card.status);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const sending = useRef(false);
  const keys = useRef(new Map<string, string>());
  const resume = async () => {
    if (sending.current) return;
    sending.current = true;
    setPending(true);
    setError("");
    setMessage("");
    const request = "resume";
    const key = keys.current.get(request) ?? crypto.randomUUID();
    keys.current.set(request, key);
    try {
      await client.updateCard(projectId, card.id, { hold: null }, key);
      keys.current.delete(request);
      setMessage("已解除暂停，按当前依赖和原有门禁继续。");
      onSaved();
    } catch (cause) {
      setError(describeWriteError(cause));
    } finally {
      sending.current = false;
      setPending(false);
    }
  };
  return (
    <section className="card-hold" aria-label="卡片暂停">
      <CardHoldDetails card={card} />
      {!closed && card.hold && (
        <div className="card-action-buttons">
          <Button
            type="button"
            variant="ghost"
            disabled={pending || disabled}
            onClick={() => void resume()}
          >
            解除暂停
          </Button>
        </div>
      )}
      <RequestFeedback
        pending={pending}
        error={error}
        message={message}
        interactive
      />
    </section>
  );
}
