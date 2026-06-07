import { useCollabStore, type CollabUser } from '../store/collabStore'

function Avatar({ user, me, onClick }: { user: CollabUser; me?: boolean; onClick?: () => void }) {
  const initial = (user.name || '?').trim().charAt(0).toUpperCase() || '?'
  return (
    <button
      onClick={onClick}
      title={me ? `${user.name || '名前未設定'}（あなた・クリックで変更）` : user.name}
      className={`w-5 h-5 rounded-full text-[10px] font-bold text-black flex items-center justify-center flex-shrink-0
        ${me ? 'ring-2 ring-white/70' : ''}`}
      style={{ background: user.color }}
    >{initial}</button>
  )
}

export function CollabBar() {
  const { me, others, connected, setName } = useCollabStore()
  const otherUsers = Object.values(others).map(o => o.user)

  const editName = () => {
    const n = window.prompt('表示名（共同編集で表示されます）', me.name || '')
    if (n && n.trim()) setName(n.trim())
  }

  if (!me.name) {
    return (
      <button
        onClick={editName}
        className="text-[11px] px-2 py-0.5 rounded bg-purple-800 hover:bg-purple-700 text-purple-100"
        title="共同編集に表示する名前を設定"
      >👤 名前を設定して参加</button>
    )
  }

  return (
    <div className="flex items-center gap-1.5">
      <span
        className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-emerald-400' : 'bg-zinc-600'}`}
        title={connected ? '同期中' : 'オフライン'}
      />
      <span className="text-[10px] text-zinc-500">{1 + otherUsers.length}人</span>
      <div className="flex items-center -space-x-1">
        <Avatar user={me} me onClick={editName} />
        {otherUsers.map(u => <Avatar key={u.id} user={u} />)}
      </div>
    </div>
  )
}
