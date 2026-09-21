/** Shared by the composer, upload client, and file routes. */
export const VIDEO_MIME_BY_EXT: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".m4v": "video/x-m4v",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
  ".ogv": "video/ogg",
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpeg",
  ".3gp": "video/3gpp",
  ".3g2": "video/3gpp2",
};

export const MAX_VIDEO_UPLOAD = 100 * 1024 * 1024;

export function videoContentType(name: string, type = ""): string | undefined {
  const mime = type.split(";")[0]!.trim().toLowerCase();
  if (Object.values(VIDEO_MIME_BY_EXT).includes(mime)) return mime;
  return VIDEO_MIME_BY_EXT[name.slice(name.lastIndexOf(".")).toLowerCase()];
}
