import { Paperclip } from "lucide-react";
import { useRef } from "react";
import { Button } from "./button.js";

/**
 * C-615: a button that opens the file chooser. The native input stays hidden
 * and is cleared after every choice, so choosing the same file again works.
 */
export function FilePicker({
  label,
  accept,
  multiple = true,
  disabled = false,
  onFiles,
}: {
  label: string;
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  onFiles: (files: File[]) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        className="ui-file-picker"
        disabled={disabled}
        onClick={() => input.current?.click()}
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
          if (files.length) onFiles(files);
        }}
      />
    </>
  );
}
