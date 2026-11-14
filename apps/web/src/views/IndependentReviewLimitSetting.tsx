import { useRef, useState } from "react";
import {
  type CardiganClient,
  describeWriteError,
  type PreferencesView,
} from "../api.js";
import { RequestFeedback } from "../components/RequestFeedback.js";

export function IndependentReviewLimitSetting({
  initial,
  client,
  projectId,
  saved,
}: {
  initial: PreferencesView;
  client: CardiganClient;
  projectId: string;
  saved: () => void;
}) {
  const [enabled, setEnabled] = useState(
    initial.independent_review_limit_delegation === true,
  );
  const approvedMax = initial.independent_review_limit_delegation_ceiling;
  const max = enabled
    ? approvedMax
    : (initial.independent_review_limit_delegation_max ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const sending = useRef(false);
  const keys = useRef(new Map<string, string>());
  const valid =
    !enabled ||
    (approvedMax !== undefined &&
      Number.isSafeInteger(approvedMax) &&
      approvedMax > 0);
  const dirty =
    enabled !== (initial.independent_review_limit_delegation === true);
  return (
    <form
      aria-label="独立复核加轮授权"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!valid || sending.current) return;
        sending.current = true;
        setBusy(true);
        setError("");
        setMessage("");
        const input = JSON.stringify([enabled, max]);
        const key = keys.current.get(input) ?? crypto.randomUUID();
        keys.current.set(input, key);
        try {
          await client.setIndependentReviewLimitDelegation(
            projectId,
            enabled,
            max ?? null,
            key,
          );
          keys.current.delete(input);
          setMessage("独立复核加轮授权已保存");
          saved();
        } catch (cause) {
          setError(describeWriteError(cause));
        } finally {
          sending.current = false;
          setBusy(false);
        }
      }}
    >
      <h3>独立复核加轮授权</h3>
      <p>
        默认关闭；开启后，有新版本需要复核时，后台项目经理可在累计上限内代批加一轮，减少打扰，也可能让你更晚发现反复返工。
      </p>
      <label>
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        允许后台代批独立复核加一轮
      </label>
      <p className="hint">
        {dirty
          ? "有更改，待保存"
          : initial.independent_review_limit_delegation
            ? "已保存：授权开启"
            : "已保存：授权关闭"}
      </p>
      <p>每个复核项累计最多代批 {approvedMax ?? "—"} 次。</p>
      <p className="hint">
        达到上限、没有新版本、敏感卡片、涉及花钱、账号、权限、删除数据、需求范围变化或已升级给人的事项，仍由你处理。加轮不等于复核通过或自动合并。
      </p>
      <p className="hint">
        关闭后，未处理的代批事项转交给你；再次开启不重置累计次数，也不接回已交人的事项。代批记录可在
        Needs You 的知会区查看。
      </p>
      <RequestFeedback
        error={
          !valid ? "暂时无法读取已批准的累计上限，请刷新后再开启。" : undefined
        }
      />
      <button type="submit" disabled={busy || !valid || !dirty}>
        保存加轮授权
      </button>
      <RequestFeedback
        interactive
        pending={busy}
        pendingMessage="保存加轮授权中…"
        error={error}
        message={message}
      />
    </form>
  );
}
