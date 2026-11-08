import * as Dialog from "@radix-ui/react-dialog";
import { type ReactElement, type ReactNode, useId } from "react";

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
}: DrawerProps) {
  const descriptionId = useId();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger && <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>}
      <Dialog.Portal>
        <Dialog.Overlay className="drawer-overlay" />
        <Dialog.Content
          className={`drawer-content${className ? ` ${className}` : ""}`}
          aria-describedby={
            description === undefined ? undefined : descriptionId
          }
        >
          <header className="drawer-header">
            <Dialog.Title className="drawer-title">{title}</Dialog.Title>
            {actions && <div className="drawer-actions">{actions}</div>}
            {actions && <span className="drawer-divider" aria-hidden="true" />}
            <Dialog.Close asChild>
              <button
                type="button"
                className="quiet drawer-close"
                aria-label="关闭抽屉"
                title="关闭"
              >
                ×
              </button>
            </Dialog.Close>
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
