import { type ComponentProps, forwardRef } from "react";
import { cn } from "../../lib/utils.js";
import { DetailProse } from "../ui/prose.js";
import styles from "./CardDetailLayout.module.css";

export const cardDetailDrawerClassName = styles.drawer;
export const CardDetailLayout = forwardRef<
  HTMLElement,
  ComponentProps<"article">
>(({ className, children, ...props }, ref) => (
  <DetailProse value={true}>
    <article {...props} ref={ref} className={cn(styles.page, className)}>
      {children}
    </article>
  </DetailProse>
));
CardDetailLayout.displayName = "CardDetailLayout";
export function CardDetailHeading(props: ComponentProps<"div">) {
  return <div {...props} className={styles.heading} />;
}
export function CardDetailTabs(props: ComponentProps<"div">) {
  return <div {...props} className={cn(styles.tabs, "card-section-nav")} />;
}
