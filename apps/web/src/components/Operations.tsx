// biome-ignore-all lint/security/noDangerouslySetInnerHtml: Markdown is rendered by the existing safe renderer.

import { useState } from "react";
import { renderMarkdown } from "../markdown.js";
import { routeHash } from "../route.js";
import { IdTag, LongContent } from "./Foundation.js";
import { RequestFeedback } from "./RequestFeedback.js";
import { Tooltip } from "./Tooltip.js";
export function Markdown({ body }: { body: string }) {
  return (
    <LongContent>
      <div
        className="markdown"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }}
      />
    </LongContent>
  );
}
export function CardLink({
  projectId,
  id,
  label = "卡片",
}: {
  projectId: string;
  id: string | null;
  label?: string;
}) {
  return id ? (
    <IdTag
      id={id}
      label={label}
      href={routeHash({ kind: "card", projectId, cardId: id })}
    />
  ) : (
    <span>项目级事项</span>
  );
}
export function Feedback({
  pending,
  error,
  retry,
  interactive,
}: {
  interactive?: boolean;
  pending: boolean;
  error: string | undefined;
  retry: () => void;
}) {
  return (
    <RequestFeedback
      pending={pending}
      interactive={interactive}
      error={error}
      retry={retry}
    />
  );
}
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
export const cliCommand = (project: string, action: string, id?: string) =>
  `cardigan ${action}${id ? ` ${quote(id)}` : ""} --project ${quote(project)}`;
export function CopyCommand({
  label,
  command,
}: {
  label: string;
  command: string;
}) {
  const [message, setMessage] = useState("");
  return (
    <div className="copy-command">
      <span>{label}：</span>
      <code>{command}</code>{" "}
      <Tooltip
        content={
          <>
            需要先用 <code>deploy/install-cli.sh</code> 安装 cardigan 命令。
          </>
        }
      >
        <button
          type="button"
          className="quiet"
          aria-label={`复制${label}`}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(command);
              setMessage("已复制");
            } catch {
              setMessage("复制失败，请选中命令手动复制。");
            }
          }}
        >
          复制
        </button>
      </Tooltip>{" "}
      <RequestFeedback message={message} />
    </div>
  );
}
export function AttachCommands({
  projectId,
  assignmentId,
  label = "在 Herdr 中打开",
}: {
  projectId: string;
  assignmentId: string;
  label?: string;
}) {
  // The CLI defaults to observe mode; only --interactive enables input.
  const command = cliCommand(projectId, "assignment attach", assignmentId);
  return (
    <div>
      <CopyCommand label={`${label}（只看不动）`} command={command} />
      <details>
        <summary>需要接管输入？</summary>
        <p className="attach-command-warning">
          <strong>你的输入会直接发给正在工作的 Agent，可能打断它</strong>
        </p>
        <CopyCommand label="接管输入" command={`${command} --interactive`} />
      </details>
    </div>
  );
}
