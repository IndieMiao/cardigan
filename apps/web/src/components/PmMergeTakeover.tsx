import { type RefObject, useRef, useState } from "react";
import { Button } from "./ui/button.js";
import * as Dialog from "./ui/dialog.js";

/** Opening the existing controls does not change the decision's owner. */
export function PmMergeTakeover({
  title,
  waitingForCheck,
  accepted,
  onAccept,
  controls,
  regular = false,
}: {
  title: string;
  waitingForCheck: boolean;
  accepted: boolean;
  onAccept: () => void;
  controls: RefObject<HTMLElement | null>;
  /**
   * C-697: the “下一步” panel's main action until taken over: a 32px
   * emphasis button (C-687 §3.2).
   */
  regular?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      {regular ? (
        // A shown button keeps its own display; leave it out once accepted.
        !accepted && (
          <Dialog.Trigger asChild>
            <Button size="regular" variant="emphasis">
              接手处理
            </Button>
          </Dialog.Trigger>
        )
      ) : (
        <Dialog.Trigger asChild>
          <button
            type="button"
            className="quiet pm-merge-takeover"
            hidden={accepted}
          >
            接手处理
          </button>
        </Dialog.Trigger>
      )}
      <Dialog.Portal>
        <Dialog.Overlay className="pre-merge-overlay" />
        <Dialog.Content
          className="pre-merge-dialog pm-merge-takeover-dialog"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            cancel.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            if (accepted) {
              event.preventDefault();
              controls.current?.focus();
            }
          }}
        >
          <div className="pm-merge-takeover-heading">
            <Dialog.Title>接手 PM 合并确认</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="quiet" aria-label="关闭接手确认">
                ×
              </button>
            </Dialog.Close>
          </div>
          <p className="pm-merge-takeover-title">{title}</p>
          <Dialog.Description>
            这条由 PM 处理即可，确定要接手吗
          </Dialog.Description>
          <p>确认接手后可选择合并、暂缓或退回，不会立即合并。</p>
          {waitingForCheck && (
            <p role="status">合并检查尚未结束，请等待检查结果。</p>
          )}
          <div className="action-row">
            <Dialog.Close asChild>
              <button type="button" className="quiet" ref={cancel}>
                取消
              </button>
            </Dialog.Close>
            <button
              type="button"
              onClick={() => {
                onAccept();
                setOpen(false);
              }}
            >
              确认接手
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
