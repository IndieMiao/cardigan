import { useRef, useState } from "react";
import {
  type CardiganClient,
  describeWriteError,
  type MergeBlockingInput,
  type MergePrerequisite,
} from "../api.js";
import { StatusTag } from "./Foundation.js";
import { RequestFeedback } from "./RequestFeedback.js";
import { Button } from "./ui/button.js";
import { SelectControl } from "./ui/select-control.js";

export const PREREQUISITE_LABELS: Record<MergePrerequisite, string> = {
  credential: "凭据",
  external_account: "外部账号",
};

/** C-760: how an action relates to its card's merge, in one tag. */
export function mergeBlockingLabel(action: {
  readonly blocks_merge?: boolean;
  readonly prerequisite?: MergePrerequisite;
}) {
  return action.blocks_merge === true
    ? `挡合并${action.prerequisite ? `（${PREREQUISITE_LABELS[action.prerequisite]}）` : ""}`
    : "合并后跟进";
}

/**
 * C-760: the owner switches an open card action between holding the merge
 * and post-merge follow-up. Shared by Needs You and the card page.
 */
export function MergeBlockingControl({
  client,
  projectId,
  action,
  done,
}: {
  readonly client: CardiganClient;
  readonly projectId: string;
  readonly action: {
    readonly id: string;
    readonly blocks_merge?: boolean;
    readonly prerequisite?: MergePrerequisite;
  };
  readonly done: () => void;
}) {
  const holds = action.blocks_merge === true;
  const [choosing, setChoosing] = useState(false);
  const [prerequisite, setPrerequisite] = useState<MergePrerequisite | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState("");
  const keys = useRef(new Map<string, string>());
  const submit = async (input: MergeBlockingInput) => {
    if (busy) return;
    const request = JSON.stringify(input);
    const key = keys.current.get(request) ?? crypto.randomUUID();
    keys.current.set(request, key);
    setBusy(true);
    setError(undefined);
    setMessage("");
    try {
      await client.setActionMergeBlocking(projectId, action.id, input, key);
      keys.current.delete(request);
      setChoosing(false);
      setMessage("已提交");
      done();
    } catch (e) {
      setError(describeWriteError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="merge-blocking action-row"
      aria-label={`${action.id} 合并前置`}
    >
      <StatusTag
        status={holds ? "blocked" : "todo"}
        label={mergeBlockingLabel(action)}
      />
      {holds ? (
        <Button
          disabled={busy}
          onClick={() =>
            void submit({
              blocks_merge: false,
              reason: "所有者改为合并后跟进",
            })
          }
        >
          改为合并后跟进
        </Button>
      ) : choosing ? (
        <form
          className="action-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (!prerequisite) return;
            void submit({
              blocks_merge: true,
              prerequisite,
              reason: `所有者改为挡合并（${PREREQUISITE_LABELS[prerequisite]}前置）`,
            });
          }}
        >
          <label>
            前置类型
            <SelectControl
              required
              aria-label={`${action.id} 前置类型`}
              value={prerequisite}
              onValueChange={(v) =>
                setPrerequisite(
                  v === "credential" || v === "external_account" ? v : "",
                )
              }
            >
              <option value="">请选择</option>
              <option value="credential">凭据</option>
              <option value="external_account">外部账号</option>
            </SelectControl>
          </label>
          <Button type="submit" disabled={busy || !prerequisite}>
            确认挡合并
          </Button>
          <Button onClick={() => setChoosing(false)}>取消</Button>
        </form>
      ) : (
        <Button disabled={busy} onClick={() => setChoosing(true)}>
          改为挡合并
        </Button>
      )}
      <RequestFeedback
        interactive
        pending={busy}
        pendingMessage="提交中…"
        error={error}
        message={message}
      />
    </section>
  );
}
