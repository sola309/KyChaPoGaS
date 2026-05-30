import { Sidebar } from './components/Sidebar'
import { ProjectView } from './pages/ProjectView'

function App() {
  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100">
      <Sidebar />
      <ProjectView />
    </div>
  )
}

export default App
