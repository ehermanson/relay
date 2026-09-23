import { useEffect, useRef, useState } from "react";
import { uploadAttachment } from "../../../lib/api";
import { classifyAttachment, type FileAttachment } from "./shared";
import { deleteAttachments, loadAttachments, saveAttachments } from "./draft-attachment-store";

export interface UploadedAttachments {
  images: string[];
  attachments: string[];
}

export function useAttachmentState(draftKey?: string) {
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const attachmentsRef = useRef<FileAttachment[]>([]);
  const hydratedRef = useRef(false);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  // Hydrate from IDB whenever the draft key changes (chat switch).
  useEffect(() => {
    let cancelled = false;
    hydratedRef.current = false;

    // Drop previews from the prior draft before swapping in new state.
    attachmentsRef.current.forEach((entry) => {
      if (entry.preview) URL.revokeObjectURL(entry.preview);
    });
    setAttachments([]);

    if (!draftKey) {
      hydratedRef.current = true;
      return;
    }

    loadAttachments(draftKey).then((stored) => {
      if (cancelled) return;
      const restored: FileAttachment[] = stored.map((entry) => {
        const file = new File([entry.blob], entry.name, { type: entry.type });
        const kind = classifyAttachment(file) ?? "file";
        return {
          file,
          kind,
          preview: kind === "image" || kind === "video" ? URL.createObjectURL(file) : undefined,
        };
      });
      setAttachments(restored);
      hydratedRef.current = true;
    });

    return () => {
      cancelled = true;
    };
  }, [draftKey]);

  // Persist after every mutation, but only once hydration is finished —
  // otherwise the initial setAttachments([]) during chat-switch would clobber
  // the newly-selected draft's stored attachments.
  useEffect(() => {
    if (!draftKey || !hydratedRef.current) return;
    const items = attachments.map((entry) => ({
      name: entry.file.name,
      type: entry.file.type,
      blob: entry.file,
    }));
    void saveAttachments(draftKey, items)
      .then(() => setPersistenceError(null))
      .catch(() =>
        setPersistenceError(
          "Attachment could not be saved on this device. Keep Relay open or remove it.",
        ),
      );
  }, [draftKey, attachments]);

  // Final cleanup of preview URLs on unmount.
  useEffect(() => {
    return () => {
      attachmentsRef.current.forEach((entry) => {
        if (entry.preview) URL.revokeObjectURL(entry.preview);
      });
    };
  }, []);

  const addFiles = (files: File[]) => {
    const entries: FileAttachment[] = [];
    for (const file of files) {
      const kind = classifyAttachment(file);
      if (!kind) continue;
      entries.push({
        file,
        kind,
        preview: kind === "image" || kind === "video" ? URL.createObjectURL(file) : undefined,
      });
    }
    if (entries.length === 0) return;
    setAttachments((prev) => [...prev, ...entries]);
  };

  const removeAttachment = (index: number) => {
    setAttachments((prev) => {
      const removed = prev[index];
      if (removed?.preview) URL.revokeObjectURL(removed.preview);
      return prev.filter((_, currentIndex) => currentIndex !== index);
    });
  };

  const clearAttachments = () => {
    setAttachments((prev) => {
      prev.forEach((entry) => {
        if (entry.preview) URL.revokeObjectURL(entry.preview);
      });
      return [];
    });
    if (draftKey) {
      // Don't wait for the persistence effect — wipe the stored draft now so
      // a quick chat-switch right after send can't reload the just-sent files.
      void deleteAttachments(draftKey).catch(() => {});
    }
  };

  /**
   * Upload all staged attachments and split the resulting paths by kind.
   * Images go on the `images` field of the outbound WS message (rendered
   * inline as `<img>` in the transcript); other files go on `attachments`
   * (rendered as a clickable chip).
   */
  const uploadAttachedFiles = async (): Promise<UploadedAttachments | undefined> => {
    if (attachments.length === 0) return undefined;

    setUploading(true);
    try {
      const paths = await Promise.all(
        attachments.map(async (entry) => ({
          kind: entry.kind,
          path: await uploadAttachment(entry.file),
        })),
      );
      return {
        images: paths.filter((p) => p.kind === "image").map((p) => p.path),
        attachments: paths.filter((p) => p.kind !== "image").map((p) => p.path),
      };
    } finally {
      setUploading(false);
    }
  };

  return {
    attachments,
    uploading,
    persistenceError,
    addFiles,
    removeAttachment,
    clearAttachments,
    uploadAttachedFiles,
  };
}
