type Props = {
  tool: string
  preview: string
  duration?: number
  error?: boolean
}

export function ToolEvent({ tool, preview, duration, error }: Props) {
  const status =
    duration == null ? 'running' : error ? 'failed' : `${duration.toFixed(2)}s`
  return (
    <div className={`tool-event ${error ? 'tool-error' : ''}`}>
      <span className="tool-name">{tool}</span>
      {preview && <span className="tool-preview">{preview}</span>}
      <span className="tool-status">{status}</span>
    </div>
  )
}
