import { type ComponentProps, forwardRef } from "react";
import { cn } from "../../lib/utils.js";
export function AppShell({ className, ...props }: ComponentProps<"div">) {
  return <div {...props} className={cn("app ui-app-shell", className)} />;
}
export function AppSidebar(props: ComponentProps<"aside">) {
  return <aside {...props} />;
}
export const AppContent = forwardRef<HTMLElement, ComponentProps<"main">>(
  ({ className, ...props }, ref) => (
    <main {...props} className={cn("ui-app-content", className)} ref={ref} />
  ),
);
AppContent.displayName = "AppContent";
