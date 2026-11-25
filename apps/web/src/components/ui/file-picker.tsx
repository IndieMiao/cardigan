import { Paperclip } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "./button.js";

/**
 * C-615: a button that opens the file chooser. The native input stays hidden
 * and is cleared after every choice, so choosing the same file again works.
 *
 * C-717: the chooser takes focus from the page while it is open. A form that
 * hides the picker on blur would drop the input, and with it the choice, so
 * `onChoosing` reports when the chooser opens and closes (by a choice or by
 * the browser's `cancel`) for the form to keep the picker in place. Pressing
 * the button keeps focus where it was: Safari does not focus a clicked button
 * and would otherwise blur the field the form expands for.
 */
export function FilePicker({
  label,
  accept,
  multiple = true,
  disabled = false,
  onFiles,
  onChoosing,
}: {
  label: string;
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  onFiles: (files: File[]) => void;
  onChoosing?: (choosing: boolean) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const choosing = useRef(onChoosing);
  choosing.current = onChoosing;
  useEffect(() => {
    const element = input.current;
    if (!element) return;
    const cancel = () => choosing.current?.(false);
    element.addEventListener("cancel", cancel);
    return () => element.removeEventListener("cancel", cancel);
  }, []);
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        className="ui-file-picker"
        disabled={disabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          onChoosing?.(true);
          input.current?.click();
        }}
      >
        <Paperclip aria-hidden="true" />
        {label}
      </Button>
      <input
        ref={input}
        type="file"
        hidden
        tabIndex={-1}
        aria-label={label}
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          onChoosing?.(false);
          if (files.length) onFiles(files);
        }}
      />
    </>
  );
}
