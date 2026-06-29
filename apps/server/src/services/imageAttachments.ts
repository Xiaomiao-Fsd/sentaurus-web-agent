import path from "node:path";
import type { VmAgentAttachmentRef, VmAgentMessageAttachment } from "@sentaurus-agent/shared";

export const chatImageExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
export const chatImageContentTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export function isChatImageName(name: string): boolean {
  return chatImageExtensions.has(path.extname(name).toLowerCase());
}

export function isChatImageContentType(contentType?: string): boolean {
  if (!contentType) return false;
  return chatImageContentTypes.has(contentType.split(";")[0].trim().toLowerCase());
}

export function chatImageContentTypeForName(name: string): string | undefined {
  switch (path.extname(name).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    default: return undefined;
  }
}

export function messageAttachmentFromVmRef(ref: VmAgentAttachmentRef): VmAgentMessageAttachment {
  const contentType = ref.contentType || chatImageContentTypeForName(ref.name || ref.path);
  const kind = isChatImageName(ref.name || ref.path) || isChatImageContentType(contentType) ? "image" : "file";
  return {
    id: ref.id,
    kind,
    name: ref.name,
    size: ref.size,
    contentType,
    source: ref.source,
    path: ref.path,
    runId: ref.runId,
    category: ref.category
  };
}
