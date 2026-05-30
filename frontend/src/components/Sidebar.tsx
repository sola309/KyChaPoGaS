import { useEffect, useState } from 'react'
import { useProjectStore } from '../store/projectStore'

export function Sidebar() {
  const { projects, activeProject, fetchProjects, createProject, setActiveProject } = useProjectStore()
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')

  useEffect(() => { fetchProjects() }, [fetchProjects])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newName.trim()) return
    const project = await createProject({ name: newName.trim() })
    setActiveProject(project)
    setNewName('')
    setCreating(false)
  }

  return (
    <aside className="w-64 bg-zinc-900 border-r border-zinc-800 flex flex-col h-screen">
      <div className="p-4 border-b border-zinc-800">
        <span className="text-sm font-bold tracking-widest text-purple-400">KyChaPoGaS</span>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        <div className="flex items-center justify-between px-2 py-1 mb-1">
          <span className="text-xs text-zinc-500 uppercase tracking-wider">Projects</span>
          <button
            onClick={() => setCreating(v => !v)}
            className="text-zinc-400 hover:text-white text-lg leading-none"
            title="New project"
          >+</button>
        </div>

        {creating && (
          <form onSubmit={handleCreate} className="mb-2 px-2">
            <input
              autoFocus
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder="Project name"
              className="w-full bg-zinc-800 text-sm text-white rounded px-2 py-1 outline-none border border-zinc-600 focus:border-purple-500"
            />
          </form>
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
    </aside>
  )
}
