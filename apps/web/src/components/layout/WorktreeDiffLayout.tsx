import { type ComponentProps, type ReactNode, useId, useState } from "react";
import { ChevronRightIcon } from "../ui/icons.js";
import styles from "./WorktreeDiffLayout.module.css";

/**
 * C-703: the read-only changes of an Assignment's worktree (查看改动) in a
 * sheet: a title row with the close button, a 13/20 muted summary line, then
 * one folded row per file whose patch scrolls sideways inside its own box, so
 * the sheet never scrolls sideways at 390px.
 */
export function DiffSheetHeading({
  title,
  close,
}: {
  readonly title: ReactNode;
  readonly close: ReactNode;
}) {
  return (
    <div className={styles.heading}>
      <div className={styles.title}>{title}</div>
      {close}
    </div>
  );
}

/** The facts under the title (branch, HEAD, counts), joined by space-3. */
export function DiffSummary(props: Omit<ComponentProps<"p">, "className">) {
  return <p {...props} className={styles.summary} />;
}

/** A titled group of the sheet (已跟踪改动 / 未跟踪文件), 14/20 600. */
export function DiffGroup({
  title,
  count,
  children,
}: {
  readonly title: ReactNode;
  readonly count: number;
  readonly children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={styles.group}>
      <h3 id={id} className={styles.groupTitle}>
        {title}
        <span className={styles.muted}>（{count}）</span>
      </h3>
      {children}
    </section>
  );
}

/** Bordered rows, one per file. */
export function DiffFileList(props: Omit<ComponentProps<"ul">, "className">) {
  return <ul {...props} className={styles.files} />;
}

/**
 * One file: a 32px toggle row (chevron, path in 12px monospace cut with an
 * ellipsis and shown in full on hover, `+n −m`); open, its patch below.
 * Without `children` (an untracked file) the row is plain text.
 */
export function DiffFile({
  path,
  stats,
  children,
}: {
  readonly path: string;
  readonly stats?: ReactNode;
  readonly children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const label = (
    <>
      <span className={styles.path} title={path}>
        {path}
      </span>
      {stats && <span className={styles.stats}>{stats}</span>}
    </>
  );
  if (children === undefined)
    return (
      <li className={styles.file}>
        <span className={styles.row}>{label}</span>
      </li>
    );
  return (
    <li className={styles.file}>
      <button
        type="button"
        className={styles.row}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        <ChevronRightIcon aria-hidden="true" />
        {label}
      </button>
      <div id={id} hidden={!open} className={styles.body}>
        {open && children}
      </div>
    </li>
  );
}

/** Patch lines in 12/18 monospace; added and removed lines in state colours. */
export function DiffPatch({
  label,
  lines,
}: {
  readonly label: string;
  readonly lines: readonly string[];
}) {
  return (
    <section
      className={styles.patch}
      aria-label={label}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a wide patch scrolls by keyboard.
      tabIndex={0}
    >
      <pre>
        {lines.map((line, index) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: patch lines are positional.
            key={index}
            className={styles.line}
            data-op={
              line.startsWith("+") && !line.startsWith("+++")
                ? "add"
                : line.startsWith("-") && !line.startsWith("---")
                  ? "remove"
                  : line.startsWith("@@")
                    ? "hunk"
                    : undefined
            }
          >
            {line}
            {"\n"}
          </span>
        ))}
      </pre>
    </section>
  );
}

/** The sheet's only line when the worktree has no changes (没有改动). */
export function DiffEmpty(props: Omit<ComponentProps<"p">, "className">) {
  return <p {...props} className={styles.empty} />;
}
