import * as Dialog from "@radix-ui/react-dialog";
import { type ReactElement, type ReactNode, useId, useRef } from "react";
import { Tooltip } from "./Tooltip.js";

export interface DrawerProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly trigger?: ReactElement;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  /** Extra header buttons rendered before the close button. */
  readonly actions?: ReactNode;
  readonly className?: string;
  readonly initialFocus?: "title" | "close";
  /**
   * C-75: `false` keeps the page behind the drawer usable (no focus trap, no
   * pointer blocking). The dimming overlay then lets clicks through, and a
   * click or focus outside the drawer closes it unless `onInteractOutside`
   * prevents that.
   */
  readonly modal?: boolean;
  readonly onInteractOutside?: (event: Event) => void;
}

/** Right-side modal drawer built on Radix Dialog. */
export function Drawer({
  open,
  onOpenChange,
  title,
  description,
  trigger,
  children,
  footer,
  actions,
  className,
  initialFocus = "title",
  modal = true,
  onInteractOutside,
}: DrawerProps) {
  const descriptionId = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange} modal={modal}>
      {trigger && <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>}
      <Dialog.Portal>
        {modal ? (
          <Dialog.Overlay className="drawer-overlay" />
        ) : (
          <div
            className="drawer-overlay drawer-overlay-passthrough"
            aria-hidden="true"
          />
        )}
        <Dialog.Content
          className={`drawer-content${className ? ` ${className}` : ""}`}
          onInteractOutside={onInteractOutside}
          onEscapeKeyDown={(event) => {
            // Radix handles Escape in capture; let an inner form dismiss itself
            // before considering the containing drawer.
            if (
              event.target instanceof Element &&
              event.target.closest("[data-escape-handled]")
            )
              event.preventDefault();
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            (initialFocus === "close" ? closeRef : titleRef).current?.focus();
          }}
          aria-describedby={
            description === undefined ? undefined : descriptionId
          }
        >
          <header className="drawer-header">
            <Dialog.Title ref={titleRef} tabIndex={-1} className="drawer-title">
              {title}
            </Dialog.Title>
            {actions && <div className="drawer-actions">{actions}</div>}
            {actions && <span className="drawer-divider" aria-hidden="true" />}
            <Tooltip content={initialFocus === "close" ? undefined : "关闭"}>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="quiet drawer-close"
                  ref={closeRef}
                  aria-label="关闭抽屉"
                >
                  ×
                </button>
              </Dialog.Close>
            </Tooltip>
          </header>
          {description !== undefined && (
            <Dialog.Description id={descriptionId} className="visually-hidden">
              {description}
            </Dialog.Description>
          )}
          <div className="drawer-body">{children}</div>
          {footer && <footer className="drawer-footer">{footer}</footer>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
