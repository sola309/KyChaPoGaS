import { create } from 'zustand'
import type { Project, ProjectCreate } from '../api/client'
import { projectsApi } from '../api/client'

interface ProjectState {
  projects: Project[]
  activeProject: Project | null
  loading: boolean
  error: string | null
  fetchProjects: () => Promise<void>
  createProject: (data: ProjectCreate) => Promise<Project>
  setActiveProject: (project: Project | null) => void
  deleteProject: (id: number) => Promise<void>
}

export const useProjectStore = create<ProjectState>((set) => ({
  projects: [],
  activeProject: null,
  loading: false,
  error: null,

  fetchProjects: async () => {
    set({ loading: true, error: null })
    try {
      const projects = await projectsApi.list()
      set({ projects, loading: false })
    } catch {
      set({ error: 'Failed to fetch projects', loading: false })
    }
  },

  createProject: async (data) => {
    const project = await projectsApi.create(data)
    set(state => ({ projects: [...state.projects, project] }))
    return project
  },

  setActiveProject: (project) => set({ activeProject: project }),

  deleteProject: async (id) => {
    await projectsApi.delete(id)
    set(state => ({
      projects: state.projects.filter(p => p.id !== id),
      activeProject: state.activeProject?.id === id ? null : state.activeProject,
    }))
  },
}))
