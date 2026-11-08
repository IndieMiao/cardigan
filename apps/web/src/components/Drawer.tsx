import * as Dialog from "@radix-ui/react-dialog";
import type { ReactElement, ReactNode } from "react";

export interface DrawerProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly trigger?: ReactElement;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
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
  className,
}: DrawerProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger && <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>}
      <Dialog.Portal>
        <Dialog.Overlay
          className="drawer-overlay"
          onClick={() => onOpenChange(false)}
        />
        <Dialog.Content
          className={`drawer-content${className ? ` ${className}` : ""}`}
          aria-describedby={
            description === undefined ? undefined : "drawer-description"
          }
        >
          <header className="drawer-header">
            <Dialog.Title className="drawer-title">{title}</Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                className="quiet drawer-close"
                aria-label="关闭抽屉"
              >
                关闭
              </button>
            </Dialog.Close>
          </header>
          {description !== undefined && (
            <Dialog.Description
              id="drawer-description"
              className="visually-hidden"
            >
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
