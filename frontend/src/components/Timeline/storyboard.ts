/**
 * 📋 絵コンテ(ストーリーボード) — シーン単位の「作りたいものの原文」。
 *
 * ユーザーが日本語で書き、Claude が読んで H3 のプロンプトへ起こす。原文は消さずに
 * 残すので、解釈がずれていれば元を見て直せる。
 *
 * 本文はトークン入りの自由文:
 *   「[ピン1]の時点で[アセット1]を参考にダークオーブが回転しながら…」
 * [ピンN] は scene.board.pins[N-1]、[アセットN] は scene.board.assets[N-1] を指す。
 *
 * 保存先は既存のシーン情報の中(scene.board)。所属ピン全てに複製されるため
 * バックエンド変更は不要で、カット編集にも自動追従する。
 */

/** 参照アセットの役割 — H3 の <Picture N>/<Video N>/<Audio N> と保持指定に対応 */
export type BoardAssetRole =
  | 'design'      // キャラ/物のデザイン参照
  | 'anchor'      // 構図アンカー(この絵の画面構成に寄せる)
  | 'plate'       // 環境プレート(背景・空間)
  | 'edit_src'    // 編集元動画(Ref2VA の <Video N>)
  | 'audio'       // 音声参照

/** retention_analysis の関係マーカー(公式の固定値) */
export type BoardRetention =
  | 'fully_preserved' | 'partially_preserved' | 'attribute_transfer' | 'weak_reference'

export interface BoardAsset {
  assetId: number
  role: BoardAssetRole
  retention: BoardRetention
  note?: string          // 「顔だけ参照」等の但し書き
}

/** ピン = 演出の時刻。カット割りピンとは別立て(用途が違うため) */
export interface BoardPin {
  id: string
  frame: number          // タイムライン絶対フレーム
  label?: string         // 「触れる」「消滅」など
  isCut: boolean         // true = ここでショットを切る([Shot N] At MM:SS.mmm になる)
}

/** 音声同調の希望: どの音声を参照としてH3へ渡すか(none=渡さない) */
export type BoardAudioSync = 'none' | 'inst' | 'full' | 'vocal'
export const AUDIO_SYNC_LABEL: Record<BoardAudioSync, string> = {
  none: '同調なし', inst: '伴奏のみ', full: '元音源', vocal: 'ボーカルのみ',
}

export interface Storyboard {
  mode: 'ref2va' | 'fl2va'   // 6セクション / 3セクション
  text: string               // 本文(日本語・トークン入り)
  assets: BoardAsset[]
  pins: BoardPin[]
  soundscape: string         // overall_soundscape の素
  music: string              // non_diegetic_music の素
  promptDraft?: string       // Claude が起こした英語プロンプト
  promptUpdated?: string     // その更新時刻(ISO)
  lyrics?: string            // このシーンに乗る歌詞(手入力)。口パク意図とは独立
  audioSync?: BoardAudioSync // 音声同調の希望(カット区間を切り出して <Audio 1> として渡す)
}

export const EMPTY_BOARD: Storyboard = {
  mode: 'ref2va', text: '', assets: [], pins: [], soundscape: '', music: '', lyrics: '', audioSync: 'none' }

export const ROLE_LABEL: Record<BoardAssetRole, string> = {
  design: 'デザイン参照', anchor: '構図アンカー', plate: '環境プレート',
  edit_src: '編集元動画', audio: '音声参照',
}
export const RETENTION_LABEL: Record<BoardRetention, string> = {
  fully_preserved: '完全保持', partially_preserved: '部分保持',
  attribute_transfer: '属性転写', weak_reference: '弱参照',
}

/** H3 の入力上限。超過はプロンプト作成時に弾かれるので、書く段階で警告する */
export function boardLimits(b: Storyboard, assetKind: (id: number) => 'image' | 'video' | 'audio') {
  const n = { image: 0, video: 0, audio: 0 }
  for (const a of b.assets) n[assetKind(a.assetId)]++
  const errs: string[] = []
  if (b.mode === 'fl2va') {
    if (n.image > 2) errs.push(`FL2VAの画像は2枚まで(現在${n.image}枚)`)
    if (n.video || n.audio) errs.push('FL2VAは動画/音声参照を受け付けません')
  } else {
    if (n.image > 9) errs.push(`画像は9枚まで(現在${n.image}枚)`)
    if (n.video > 3) errs.push(`動画は3本まで(現在${n.video}本)`)
    if (n.audio > 3) errs.push(`音声は3本まで(現在${n.audio}本)`)
    if (n.audio && !n.image && !n.video) errs.push('音声参照だけでは生成できません(画像か動画が必要)')
  }
  return { counts: n, errors: errs }
}

/** 17n+5 グリッド(24fps)。カットピンの位置決めの目安に使う */
export const snapH3 = (frames: number) => {
  let n = Math.max(5, Math.round(frames))
  while (n % 17 !== 5) n++
  return n
}

export const fmtTC = (frame: number, fps: number) => {
  const s = frame / fps
  return `00:${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(3).padStart(6, '0')}`
    .replace('00:00:', '00:')
}

/**
 * 本文中の [ピンN] / [アセットN] を新しい番号へ振り直す。
 * Ref2VA では参照の並び順そのものが意味を持つ(タグ番号と接続順が一致していないと別物になる)ので、
 * 配列を並べ替え・削除したら本文も同時に直さないとプロンプトが静かに壊れる。
 * @param oldToNew 旧番号(1始まり) → 新番号 / null は参照先が消えたもの
 */
export function renumberTokens(
  text: string, kind: 'ピン' | 'アセット', oldToNew: Map<number, number | null>,
): string {
  return text.replace(new RegExp(`\\[${kind}(\\d+)\\]`, 'g'), (m, d) => {
    const n = oldToNew.get(Number(d))
    if (n === undefined) return m               // 知らない番号は触らない
    if (n === null) return `[${kind}削除]`      // 消えた参照は目印を残す(黙って別物を指させない)
    return `[${kind}${n}]`
  })
}

/** 並べ替え前後の配列から renumberTokens 用の対応表を作る */
export function indexMap<T>(prev: T[], next: T[], key: (t: T) => string | number): Map<number, number | null> {
  const m = new Map<number, number | null>()
  prev.forEach((x, i) => {
    const j = next.findIndex(y => key(y) === key(x))
    m.set(i + 1, j < 0 ? null : j + 1)
  })
  return m
}
