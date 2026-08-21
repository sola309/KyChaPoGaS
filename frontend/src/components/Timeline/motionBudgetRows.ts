/** 移動量バジェットの行定義。
 *  レーン本体(canvas)と左のラベル列で同じ高さを使うため、コンポーネントから分離してある。
 *  ここがズレると、ラベルが別の行を指しているように見える。 */
export const MB_ROWS = {
  // 主 = allin1の境界 + 自作の盛り上げ判定を統合したもの
  sect:  { h: 13, label: '構造' },
  // 副 = 自作(信号統計)。主とズレる所が「手法の限界が出ている所」
  sect2: { h: 9,  label: '副(自作)' },
  // 端をつかんで伸縮するので、細すぎると操作できない(8pxでは掴めなかった)
  build: { h: 15, label: '盛上げ' },
  move:  { h: 40, label: '移動量' },
  voice: { h: 14, label: '歌唱' },
  grain: { h: 12, label: '粒度' },
  kick:   { h: 10, label: 'キック' },
  snare:  { h: 11, label: 'スネア' },
  cymbal: { h: 10, label: 'シンバル' },
  punch:  { h: 11, label: '打撃(旧)' },
  grade: { h: 13, label: '等級' },
} as const

export type MBRow = keyof typeof MB_ROWS

/** 要点のみ(狭い画面や、細かく見る必要がないとき) */
export const MB_COMPACT: MBRow[] = ['sect', 'sect2', 'build', 'move', 'grade']
/** 全系列。最終結果だけだと「なぜその値か」が分からないので既定はこちら */
export const MB_ALL: MBRow[] = ['sect', 'sect2', 'build', 'move', 'voice', 'grain',
                                'kick', 'snare', 'cymbal', 'grade']

/** 盛り上げの種別。上昇/下降は対、抜きは無音側の溜め、平坦は印だけ置く用 */
export const BUILDUP_KINDS = ['上昇', '下降', '抜き', '平坦'] as const
export type BuildupKind = typeof BUILDUP_KINDS[number]
export const BUILDUP_COLOR: Record<string, string> = {
  '上昇': '#e6c878',   // 盛り上がり
  '下降': '#7ba7d4',   // 盛り下がり
  '抜き': '#e07878',   // 直前の抜き(ここで画を止める)
  '平坦': '#5a5a62',
}

/** ドラム行の色。役割(キック=押し / スネア=カット / シンバル=フラッシュ)で分ける */
export const DRUM_COLOR: Record<string, string> = {
  kick:   'rgba(120,170,255,0.9)',
  snare:  'rgba(240,110,110,0.95)',
  cymbal: 'rgba(230,200,110,0.9)',
}

export const mbHeight = (rows: readonly MBRow[]) => rows.reduce((a, r) => a + MB_ROWS[r].h, 0)
