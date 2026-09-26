import { X } from "lucide-react";
import type { FileAttachment } from "./shared";
import { Tooltip } from "../../ui/tooltip";
import { FileIcon } from "@/components/ui/file-icon";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function AttachmentStrip({
  attachments,
  onRemove,
}: {
  attachments: FileAttachment[];
  onRemove: (index: number) => void;
}) {
  if (attachments.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 px-3 pt-3">
      {attachments.map((entry, index) => {
        const removeButton = (
          <Tooltip content="Remove">
            <button
              type="button"
              aria-label={`Remove ${entry.file.name}`}
              onClick={() => onRemove(index)}
              // Touch: the visible circle stays small; an invisible ::after grows
              // the hit area to ~40px instead.
              className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-error text-white opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 after:absolute after:-inset-2 after:content-[''] [@media(pointer:coarse)]:h-6 [@media(pointer:coarse)]:w-6 [@media(pointer:coarse)]:opacity-100"
            >
              <X size={12} strokeWidth={3} />
            </button>
          </Tooltip>
        );

        if (entry.kind === "video" && entry.preview) {
          return (
            <div key={index} className="group relative max-w-[16rem]">
              <video
                src={entry.preview}
                aria-label={entry.file.name}
                controls
                playsInline
                preload="metadata"
                className="h-32 w-56 rounded-lg border border-border bg-black object-contain"
              />
              <div className="truncate text-[0.6875rem] text-muted">
                {entry.file.name} · {formatBytes(entry.file.size)}
              </div>
              {removeButton}
            </div>
          );
        }

        if (entry.kind === "image" && entry.preview) {
          return (
            <div key={index} className="group relative">
              <img
                src={entry.preview}
                alt={entry.file.name}
                className="h-16 w-16 rounded-lg border border-border object-cover"
              />
              {removeButton}
            </div>
          );
        }

        return (
          <div key={index} className="group relative">
            <div className="flex h-16 max-w-[14rem] items-center gap-2 rounded-lg border border-border bg-surface-hover/40 px-2.5">
              <FileIcon path={entry.file.name} size={20} className="h-5 w-5" />
              <div className="min-w-0 flex flex-col">
                <span className="truncate text-[0.8125rem] leading-tight text-text">
                  {entry.file.name}
                </span>
                <span className="text-[0.6875rem] text-muted">{formatBytes(entry.file.size)}</span>
              </div>
            </div>
            {removeButton}
          </div>
        );
      })}
    </div>
  );
}
