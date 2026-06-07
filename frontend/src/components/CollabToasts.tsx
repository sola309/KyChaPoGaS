import { useEffect } from 'react'
import { useUIStore, type ToastKind } from '../store/uiStore'

function ToastItem({ id, text, color, kind }: { id: number; text: string; color?: string; kind: ToastKind }) {
  const dismiss = useUIStore(s => s.dismissToast)
  useEffect(() => {
    const t = setTimeout(() => dismiss(id), kind === 'error' ? 6000 : 3500)
    return () => clearTimeout(t)
  }, [id, dismiss, kind])
  return (
    <div className="flex items-center gap-2 bg-zinc-900 border border-zinc-700 rounded px-3 py-1.5 shadow-lg text-xs text-zinc-200 max-w-xs">
      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: color }} />
      <span className="truncate">{text}</span>
    </div>
  )
}

/** Global transient notifications (collab join/leave, errors, etc.) — bottom-right. */
export function CollabToasts() {
  const toasts = useUIStore(s => s.toasts)
  if (toasts.length === 0) return null
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-1.5 pointer-events-none">
      {toasts.slice(-5).map(t => <ToastItem key={t.id} {...t} />)}
    </div>
  )
}
