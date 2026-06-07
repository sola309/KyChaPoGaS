import { useEffect, useRef } from 'react'
import { useCollabStore } from '../store/collabStore'
import { useTimelineStore } from '../store/timelineStore'

/**
 * Connects to the project's collaboration room and streams this user's presence
 * (playhead frame + selected clip) to others, throttled.
 */
export function useCollab(projectId: number | undefined) {
  const connect = useCollabStore(s => s.connect)
  const disconnect = useCollabStore(s => s.disconnect)
  const sendPresence = useCollabStore(s => s.sendPresence)
  const lastRemoteEdit = useCollabStore(s => s.lastRemoteEdit)
  const currentFrame = useTimelineStore(s => s.currentFrame)
  const selectedClipId = useTimelineStore(s => s.selectedClipId)
  const editingClipId = useTimelineStore(s => s.editingClipId)
  const syncFromServer = useTimelineStore(s => s.syncFromServer)
  const lastSent = useRef(0)

  useEffect(() => {
    if (projectId == null) return
    connect(projectId)
    return () => disconnect()
  }, [projectId, connect, disconnect])

  // Stream presence (playhead + selection + active edit), throttled
  useEffect(() => {
    const now = performance.now()
    if (now - lastSent.current < 90) return   // throttle ~11/s
    lastSent.current = now
    sendPresence({ frame: currentFrame, selected_clip_id: selectedClipId, editing_clip_id: editingClipId })
  }, [currentFrame, selectedClipId, editingClipId, sendPresence])

  // Another user committed an edit → re-sync from server (debounced/coalesced)
  useEffect(() => {
    if (projectId == null || lastRemoteEdit === 0) return
    const t = setTimeout(() => { void syncFromServer(projectId) }, 120)
    return () => clearTimeout(t)
  }, [lastRemoteEdit, projectId, syncFromServer])
}
