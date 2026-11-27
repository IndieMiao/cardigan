import { ImageOff } from "lucide-react";

export {
  ChevronDown as ChevronDownIcon,
  ChevronRight as ChevronRightIcon,
  Copy as CopyIcon,
  Download as DownloadIcon,
  Ellipsis as MoreHorizontalIcon,
  Scan as FitIcon,
  TriangleAlert as AlertIcon,
  X as CloseIcon,
  ZoomIn as ZoomInIcon,
  ZoomOut as ZoomOutIcon,
} from "lucide-react";

export function ListIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M3 4h10M3 8h10M3 12h10"
        stroke="currentColor"
        strokeWidth="1.6"
      />
    </svg>
  );
}
export function BoardIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M3 3h3v10H3zM9 3h4v6H9z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
    </svg>
  );
}

/** Stands in for an image thumbnail that could not be loaded or decoded. */
export function ImageUnavailableIcon() {
  return <ImageOff size={16} aria-hidden="true" />;
}
