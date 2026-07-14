/** XMLHttpRequest upload with progress events (0–100). */

export type UploadProgressEvent = {
  loaded: number
  total: number
  percent: number
}

export function uploadWithProgress(
  url: string,
  files: File[],
  options: {
    fieldName?: string
    credentials?: RequestCredentials
    onProgress?: (ev: UploadProgressEvent) => void
  } = {},
): Promise<unknown> {
  const fieldName = options.fieldName ?? 'files'
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)
    xhr.withCredentials = options.credentials !== 'omit'

    xhr.upload.onprogress = (ev) => {
      if (!ev.lengthComputable || !options.onProgress) return
      const percent = ev.total > 0 ? Math.round((ev.loaded / ev.total) * 100) : 0
      options.onProgress({ loaded: ev.loaded, total: ev.total, percent })
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText))
        } catch {
          resolve(xhr.responseText)
        }
        return
      }
      let detail = xhr.statusText
      try {
        const body = JSON.parse(xhr.responseText)
        detail = body.detail ?? body.error ?? detail
      } catch {
        // ignore
      }
      reject(new Error(String(detail)))
    }

    xhr.onerror = () => reject(new Error('network error'))

    const fd = new FormData()
    for (const f of files) fd.append(fieldName, f, f.name)
    xhr.send(fd)
  })
}
