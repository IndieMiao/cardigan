// biome-ignore-all lint/security/noDangerouslySetInnerHtml: Markdown is rendered by the existing safe renderer.
import { useState } from "react";
import { renderMarkdown } from "../markdown.js";
import { routeHash } from "../route.js";
export function Markdown({ body }: { body: string }) {
  return (
    <div
      className="markdown"
      dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }}
    />
  );
}
export function CardLink({
  projectId,
  id,
}: {
  projectId: string;
  id: string | null;
}) {
  return id ? (
    <a href={routeHash({ kind: "card", projectId, cardId: id })}>{id}</a>
  ) : (
    <span>项目级事项</span>
  );
}
export function Feedback({
  pending,
  error,
  retry,
}: {
  pending: boolean;
  error: string | undefined;
  retry: () => void;
}) {
  return (
    <>
      {pending && <p role="status">正在加载…</p>}
      {error && (
        <div role="alert" className="error-panel">
          {error}{" "}
          <button type="button" onClick={retry}>
            重试
          </button>
        </div>
      )}
    </>
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
      </button>{" "}
      <span role="status">{message}</span>
    </div>
  );
}
