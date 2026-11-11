/**
 * 🎥 制作風景キャプチャ用モード(URL に ?capture=1 を付けて開く)。
 *
 * outputs/kijun-ef/making/capture.mjs(Playwright)が UI を1フレームずつ撮って
 * 「ソフトの画面ごと再生している動画」を作るときに使う。普段の編集では無効。
 *  - 撮影中に画面が変わらないよう、自動リロード・共同編集への参加・通知トーストを止める
 *  - タイムラインは全レーン・全尺を一画面に出す(空トラックは省き、拡大率は全尺に合わせる)
 *  - プレビューは動画を読み込まず、撮影スクリプトが差し込むフレーム画像を表示する
 *    (ヘッドレスの Chromium は H.264 を再生できないため。差し込む絵は書き出し済みの映像)
 */
export const CAPTURE = typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).has('capture')

/** 撮影スクリプトから切り替える状態。autoFit=false にすると全尺合わせをやめ、拡大率を自由に変えられる */
export const captureState = { autoFit: true }
