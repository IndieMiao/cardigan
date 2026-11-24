import { File as FileIcon, FileText, Film, Image, X } from "lucide-react";
import type { ReactNode } from "react";

/**
 * C-615: files waiting to be sent with a form (e.g. a comment), one compact
 * row each: type icon, name, size, an optional field and a remove button.
 */
export function FileChipList({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <ul className="ui-file-chips" aria-label={label}>
      {children}
    </ul>
  );
}

export function FileChip({
  name,
  size,
  kind,
  onRemove,
  removeDisabled = false,
  children,
}: {
  name: string;
  /** Already formatted, e.g. `1.2 MiB`. */
  size: string;
  kind: "image" | "video" | "pdf" | "text" | "file";
  onRemove: () => void;
  removeDisabled?: boolean;
  /** Extra controls, e.g. a note field. */
  children?: ReactNode;
}) {
  const Icon =
    kind === "image"
      ? Image
      : kind === "video"
        ? Film
        : kind === "file"
          ? FileIcon
          : FileText;
  return (
    <li className="ui-file-chip" title={`${name} · ${size}`}>
      <Icon className="ui-file-chip-icon" aria-hidden="true" />
      <span className="ui-file-chip-name">{name}</span>
      <span className="ui-file-chip-size">{size}</span>
      {children}
      <button
        type="button"
        className="ui-file-chip-remove"
        aria-label={`移除 ${name}`}
        disabled={removeDisabled}
        onClick={onRemove}
      >
        <X aria-hidden="true" />
      </button>
    </li>
  );
}

/** One line per file that was not added, with the reason. */
export function FileProblems({
  problems,
}: {
  problems: readonly { readonly name: string; readonly reason: string }[];
}) {
  if (!problems.length) return null;
  return (
    <ul className="ui-file-problems" role="alert">
      {problems.map((problem, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: one report, never reordered.
        <li key={index}>
          {problem.name}：{problem.reason}
        </li>
      ))}
    </ul>
  );
}
