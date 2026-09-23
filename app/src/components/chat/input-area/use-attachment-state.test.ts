import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAttachmentState } from "./use-attachment-state";
import { classifyAttachment } from "./shared";
import { uploadAttachment } from "@/lib/api";
import { loadAttachments } from "./draft-attachment-store";

vi.mock("@/lib/api", () => ({
  uploadAttachment: vi.fn(async (file: File) => `/uploads/${file.name}`),
}));
vi.mock("./draft-attachment-store", () => ({
  loadAttachments: vi.fn(async () => []),
  saveAttachments: vi.fn(async () => {}),
  deleteAttachments: vi.fn(async () => {}),
}));

beforeEach(() => {
  vi.clearAllMocks();
  URL.createObjectURL = vi.fn(() => "blob:preview");
  URL.revokeObjectURL = vi.fn();
});

describe("video attachments", () => {
  it("accepts video MIME types and extension fallbacks", () => {
    for (const [name, type] of [
      ["clip", "video/mp4"],
      ["clip.MOV", ""],
      ["clip.webm", "application/octet-stream"],
    ]) {
      expect(classifyAttachment(new File(["clip"], name, { type }))).toBe("video");
    }
    expect(classifyAttachment(new File(["x"], "app.exe"))).toBeNull();
  });

  it("sends videos as files alongside images and releases previews", async () => {
    const { result } = renderHook(() => useAttachmentState());
    act(() =>
      result.current.addFiles([
        new File(["clip"], "clip.mp4", { type: "video/mp4" }),
        new File(["photo"], "photo.png", { type: "image/png" }),
      ]),
    );
    expect(result.current.attachments[0].preview).toBe("blob:preview");
    await act(async () => {
      expect(await result.current.uploadAttachedFiles()).toEqual({
        images: ["/uploads/photo.png"],
        attachments: ["/uploads/clip.mp4"],
      });
    });
    expect(uploadAttachment).toHaveBeenCalledTimes(2);
    act(() => result.current.clearAttachments());
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it("restores a video preview from a saved draft", async () => {
    vi.mocked(loadAttachments).mockResolvedValueOnce([
      { name: "clip.mov", type: "video/quicktime", blob: new Blob(["clip"]) },
    ]);
    const { result, unmount } = renderHook(() => useAttachmentState("chat"));
    await waitFor(() => expect(result.current.attachments).toHaveLength(1));
    expect(result.current.attachments[0]).toMatchObject({ kind: "video", preview: "blob:preview" });
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview");
  });
});
