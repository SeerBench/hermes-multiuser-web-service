import { platform } from './platformClient'

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i
const DRAWER_DOC_EXT = /\.(md|pdf)$/i

/** True when the attachment filename looks like an image. */
export function isImageAttachmentName(name: string): boolean {
  return IMAGE_EXT.test(name)
}

/** Markdown / PDF — click opens the right-side preview drawer. */
export function isDrawerPreviewableName(name: string): boolean {
  return DRAWER_DOC_EXT.test(name)
}

/** Detect images by mime type, display name, or storage path extension. */
export function isImageAttachment(
  name: string,
  opts?: { mimeType?: string | null; path?: string | null },
): boolean {
  const mime = opts?.mimeType?.toLowerCase() ?? ''
  if (mime.startsWith('image/')) return true
  if (isImageAttachmentName(name)) return true
  const pathBase = opts?.path?.split('/').pop() ?? ''
  if (pathBase && isImageAttachmentName(pathBase)) return true
  return false
}

/** Fetch workspace file bytes and return a blob URL for <img> preview. */
export async function fetchWorkspaceImagePreviewUrl(
  workspaceId: string,
  fileId: string,
): Promise<string> {
  const res = await platform.getFileContent(workspaceId, fileId)
  const blob = await res.blob()
  return URL.createObjectURL(blob)
}
