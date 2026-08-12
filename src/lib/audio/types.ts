export interface Onset {
  /** 秒 */
  time: number;
  /** 0..1 に正規化した立ち上がりの強さ */
  strength: number;
}

export interface Beat {
  time: number;
  /** 小節内の位置（0 = 拍頭/ダウンビート推定）。拍子は4/4を仮定。 */
  indexInBar: number;
  strength: number;
}

export type SectionKind = 'intro' | 'verse' | 'build' | 'hook' | 'break' | 'outro';

export interface Section {
  id: string;
  kind: SectionKind;
  start: number;
  end: number;
  /** 0..1。区間平均エネルギー。 */
  energy: number;
  /** hook 判定に使ったスコア（0..1）。 */
  score: number;
}

export interface AudioAnalysis {
  duration: number;
  sampleRate: number;
  /** 推定BPM。0 は「推定不能」を意味する。 */
  bpm: number;
  /** BPM推定の信頼度 0..1 */
  bpmConfidence: number;
  /** 解析フレームの時間刻み（秒） */
  hopTime: number;
  /** フレーム毎のオンセット強度 0..1 */
  onsetEnvelope: Float32Array;
  /** フレーム毎のRMSラウドネス 0..1 */
  energyEnvelope: Float32Array;
  /** 低/中/高の帯域エネルギー 0..1（演出のトリガに使う） */
  bands: { low: Float32Array; mid: Float32Array; high: Float32Array };
  onsets: Onset[];
  beats: Beat[];
  sections: Section[];
  /** 最も「サビ」らしい区間。無音などで決められない場合は null。 */
  hook: Section | null;
  /** 波形サムネイル（描画用の間引き済みピーク列） */
  waveform: Float32Array;
  /** 解析中に検出した注意事項（UIに表示する） */
  warnings: string[];
}

export interface AnalyzeOptions {
  fftSize?: number;
  hopSize?: number;
  minBpm?: number;
  maxBpm?: number;
  /** 波形サムネイルの解像度（サンプル数） */
  waveformResolution?: number;
}
