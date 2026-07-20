import { platform } from './platformClient'

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i
const DRAWER_DOC_EXT = /\.(md|pdf)$/i
const ANY_EXT = /\.[a-z0-9]{1,12}$/i

/** True when the attachment filename looks like an image. */
export function isImageAttachmentName(name: string): boolean {
  return IMAGE_EXT.test(name)
}

/** Markdown / PDF — chat chip click opens the right-side preview drawer. */
export function isDrawerPreviewableName(name: string): boolean {
  return DRAWER_DOC_EXT.test(name)
}

/**
 * Files list / workspace library: images + md/pdf open in the preview drawer.
 * Office formats (docx/xlsx/…) stay non-previewable in-browser.
 */
export function isWorkspaceFilePreviewable(name: string): boolean {
  return isImageAttachmentName(name) || isDrawerPreviewableName(name)
}

/** Resolve drawer body kind for a workspace file name. */
export function workspacePreviewKind(
  name: string,
): 'image' | 'pdf' | 'md' | null {
  if (isImageAttachmentName(name)) return 'image'
  const lower = name.toLowerCase()
  if (lower.endsWith('.pdf')) return 'pdf'
  if (lower.endsWith('.md')) return 'md'
  return null
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

/**
 * Extensionless / opaque storage records may still be images. Probe only
 * ambiguous records so known documents are not downloaded unnecessarily.
 */
export function shouldFetchWorkspaceImagePreview(
  name: string,
  opts?: { mimeType?: string | null; path?: string | null },
): boolean {
  if (isImageAttachment(name, opts)) return true
  if (isDrawerPreviewableName(name)) return false

  const mime = opts?.mimeType?.toLowerCase() ?? ''
  if (mime && mime !== 'application/octet-stream') return false

  const pathBase = opts?.path?.split('/').pop() ?? ''
  return !ANY_EXT.test(name) && (!pathBase || !ANY_EXT.test(pathBase))
}

function readBlobBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'))
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.readAsArrayBuffer(blob.slice(0, 512))
  })
}

async function blobContainsImage(blob: Blob): Promise<boolean> {
  if (blob.type.toLowerCase().startsWith('image/')) return true

  // Some legacy records have application/octet-stream and UUID filenames.
  const bytes = await readBlobBytes(blob)
  const starts = (...signature: number[]) =>
    signature.every((value, index) => bytes[index] === value)

  if (starts(0x89, 0x50, 0x4e, 0x47)) return true // PNG
  if (starts(0xff, 0xd8, 0xff)) return true // JPEG
  if (starts(0x47, 0x49, 0x46, 0x38)) return true // GIF
  if (starts(0x42, 0x4d)) return true // BMP
  if (
    starts(0x52, 0x49, 0x46, 0x46) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return true // WebP
  }

  const text = new TextDecoder().decode(bytes).trimStart().toLowerCase()
  return (
    text.startsWith('<svg') ||
    (text.startsWith('<?xml') && text.includes('<svg'))
  )
}

/** Fetch workspace file bytes and return a blob URL for <img> preview. */
export async function fetchWorkspaceImagePreviewUrl(
  workspaceId: string,
  fileId: string,
): Promise<string> {
  const res = await platform.getFileContent(workspaceId, fileId)
  const blob = await res.blob()
  if (!(await blobContainsImage(blob))) {
    throw new Error('Workspace file is not an image')
  }
  return URL.createObjectURL(blob)
}
