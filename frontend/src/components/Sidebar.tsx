import { useEffect, useState } from 'react'
import { useProjectStore } from '../store/projectStore'

interface Props {
  onOpenTerminal: () => void
  termOpen: boolean
}

export function Sidebar({ onOpenTerminal, termOpen }: Props) {
  const { projects, activeProject, fetchProjects, createProject, setActiveProject } = useProjectStore()
  const [creating,   setCreating]   = useState(false)
  const [newName,    setNewName]    = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error,      setError]      = useState<string | null>(null)

  useEffect(() => { fetchProjects() }, [fetchProjects])

  const handleCreate = async () => {
    if (!newName.trim() || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const project = await createProject({ name: newName.trim() })
      setActiveProject(project)
      setNewName('')
      setCreating(false)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
    } finally {
      setSubmitting(false)
    }
  }

  const cancelCreate = () => { setCreating(false); setNewName(''); setError(null) }

  return (
    <aside className="w-64 bg-zinc-900 border-r border-zinc-800 flex flex-col h-full">
      {/* Logo */}
      <div className="p-4 border-b border-zinc-800 flex-shrink-0">
        <span className="text-sm font-bold tracking-widest text-purple-400">KyChaPoGaS</span>
      </div>

      {/* Project list */}
      <div className="flex-1 overflow-y-auto p-2">
        <div className="flex items-center justify-between px-2 py-1 mb-1">
          <span className="text-xs text-zinc-500 uppercase tracking-wider">Projects</span>
          <button
            onClick={() => { setCreating(v => !v); setError(null) }}
            className="text-zinc-400 hover:text-white text-lg leading-none"
            title="新規プロジェクト"
          >+</button>
        </div>

        {creating && (
          <div className="mb-2 px-2">
            <div className="flex gap-1">
              <input
                autoFocus
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter')  handleCreate()
                  if (e.key === 'Escape') cancelCreate()
                }}
                placeholder="Project name"
                className="flex-1 bg-zinc-800 text-sm text-white rounded px-2 py-1 outline-none border border-zinc-600 focus:border-purple-500"
              />
              <button
                type="button"
                onClick={handleCreate}
                disabled={!newName.trim() || submitting}
                className="text-xs px-2 py-1 rounded bg-purple-700 hover:bg-purple-600 text-white disabled:opacity-40 disabled:cursor-not-allowed"
              >{submitting ? '…' : '✓'}</button>
            </div>
            {error && <p className="text-[10px] text-red-400 mt-1">{error}</p>}
          </div>
        )}

        {projects.map(p => (
          <button
            key={p.id}
            onClick={() => setActiveProject(p)}
            className={`w-full text-left px-3 py-2 rounded text-sm truncate transition-colors ${
              activeProject?.id === p.id
                ? 'bg-purple-900/50 text-purple-200'
                : 'text-zinc-300 hover:bg-zinc-800'
            }`}
          >
            {p.name}
          </button>
        ))}
      </div>

      {/* Terminal toggle button (bottom of sidebar) */}
      <div className="flex-shrink-0 border-t border-zinc-800 p-2">
        <button
          onClick={onOpenTerminal}
          title="ターミナルを開閉 (Ctrl+`)"
          className={`w-full flex items-center gap-2 px-3 py-2 rounded text-sm transition-colors
            ${termOpen
              ? 'bg-purple-900/50 text-purple-300'
              : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
            }`}
        >
          <span className="font-mono text-base leading-none">{'>'}_</span>
          <span>Terminal</span>
          <span className="ml-auto text-[10px] text-zinc-600">Ctrl+`</span>
        </button>
      </div>
    </aside>
  )
}
