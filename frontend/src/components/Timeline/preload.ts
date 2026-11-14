// 📱 スマホの確認用タイムラインでは、編集用のタイムライン(Timeline.tsx)を出さない。そのあいだは ProjectView がタイムラインを読む。
// あとで「編集する」を押して Timeline.tsx が初めて出るとき、同じものをもう一度読み直さない(元に戻すの履歴が消えるため)ための目印。
// PC ではここは空のままなので、Timeline.tsx はいつもどおり自分で読む。
export const timelinePreload: { key: string | null } = { key: null }
export const preloadKey = (projectId: number, fps: number) => `${projectId}:${fps}`
