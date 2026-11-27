import { type ComponentProps, type ReactNode, useId } from "react";
import styles from "./DecisionBriefLayout.module.css";

/**
 * C-810: a decision's parts in one column, 12px apart: what to confirm,
 * attachments, criteria, plain summary, options, then 详细信息.
 */
export function DecisionBriefLayout(
  props: Omit<ComponentProps<"section">, "className">,
) {
  return <section {...props} className={styles.brief} />;
}
/** What the human is asked to confirm (the decision's question), 14/20 600. */
export function DecisionBriefQuestion({
  children,
}: {
  readonly children: ReactNode;
}) {
  return <p className={styles.question}>{children}</p>;
}
/** A titled part of the brief (验收标准); title 13/20 600 muted. */
export function DecisionBriefPart({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={styles.part}>
      <h3 id={id} className={styles.partTitle}>
        {title}
      </h3>
      {children}
    </section>
  );
}
/** Numbered criteria, 14/20, 4px apart. */
export function DecisionBriefCriteria(
  props: Omit<ComponentProps<"ol">, "className">,
) {
  return <ol {...props} className={styles.criteria} />;
}
/** “还有 N 个” after the thumbnails; a 28px-high link line. */
export function DecisionBriefMore(
  props: Omit<ComponentProps<"a">, "className">,
) {
  return <a {...props} className={styles.more} />;
}
/** Options shown without answering here (timeline, Needs You-only kinds). */
export function DecisionBriefOptions(
  props: Omit<ComponentProps<"ul">, "className">,
) {
  return <ul {...props} className={styles.options} />;
}
/** One read-only option: name (14/20) with tags, a 13/20 muted detail line. */
export function DecisionBriefOption({
  label,
  tags,
  detail,
}: {
  readonly label: ReactNode;
  readonly tags?: ReactNode;
  readonly detail?: ReactNode;
}) {
  return (
    <li className={styles.option}>
      <span className={styles.optionName}>
        {label}
        {tags}
      </span>
      {detail && <span className={styles.optionDetail}>{detail}</span>}
    </li>
  );
}
/** 详细信息: a 28px muted toggle; its content 8px apart. */
export function DecisionBriefDetails({
  summary,
  children,
}: {
  readonly summary: string;
  readonly children: ReactNode;
}) {
  return (
    <details className={styles.details}>
      <summary>{summary}</summary>
      <div className={styles.detailsBody}>{children}</div>
    </details>
  );
}
