import { describe, expect, it } from 'vitest';
import { FFT, hannWindow } from '../src/lib/dsp/fft';
import { analyzeAudio, estimateTempo, trackBeats } from '../src/lib/audio/analyze';

const SAMPLE_RATE = 44100;

/** 指定BPMのクリック音源を合成する（減衰する正弦波 + 低域のキック）。 */
function makeClickTrack(bpm: number, seconds: number, sampleRate = SAMPLE_RATE): Float32Array {
  const samples = new Float32Array(Math.floor(seconds * sampleRate));
  const interval = (60 / bpm) * sampleRate;
  for (let beat = 0; beat * interval < samples.length; beat++) {
    const start = Math.floor(beat * interval);
    const isDownbeat = beat % 4 === 0;
    const length = Math.floor(sampleRate * 0.09);
    for (let i = 0; i < length && start + i < samples.length; i++) {
      const decay = Math.exp(-i / (sampleRate * 0.02));
      const kick = Math.sin((2 * Math.PI * 70 * i) / sampleRate) * (isDownbeat ? 0.9 : 0.55);
      const snap = Math.sin((2 * Math.PI * 2400 * i) / sampleRate) * 0.25;
      samples[start + i] += (kick + snap) * decay;
    }
  }
  return samples;
}

describe('FFT', () => {
  it('サイズが2のべき乗でないと例外を投げる', () => {
    expect(() => new FFT(1000)).toThrow(/power of two/);
  });

  it('単一正弦波のピークが正しいビンに立つ', () => {
    const size = 1024;
    const fft = new FFT(size);
    const binIndex = 64;
    const input = new Float32Array(size);
    const window = hannWindow(size);
    for (let i = 0; i < size; i++) {
      input[i] = Math.sin((2 * Math.PI * binIndex * i) / size) * window[i];
    }
    const magnitude = new Float32Array(size / 2 + 1);
    fft.magnitude(input, magnitude, new Float32Array(size), new Float32Array(size));

    let peak = 0;
    let peakIndex = -1;
    for (let i = 0; i <= size / 2; i++) {
      if (magnitude[i] > peak) {
        peak = magnitude[i];
        peakIndex = i;
      }
    }
    expect(peakIndex).toBe(binIndex);
  });
});

describe('テンポ推定', () => {
  it.each([90, 120, 128, 140])('%i BPM のクリック音源から同じBPMを推定する', (bpm) => {
    const analysis = analyzeAudio(makeClickTrack(bpm, 20), SAMPLE_RATE);
    expect(analysis.bpm).toBeGreaterThan(bpm - 2);
    expect(analysis.bpm).toBeLessThan(bpm + 2);
    expect(analysis.bpmConfidence).toBeGreaterThan(0.3);
  });

  it('データが短すぎる場合は 0 を返す', () => {
    expect(estimateTempo(new Float32Array(4), 0.0116, 60, 200)).toEqual({ bpm: 0, confidence: 0 });
  });
});

describe('ビートトラッキング', () => {
  it('検出したビート間隔が拍長とほぼ一致する', () => {
    const analysis = analyzeAudio(makeClickTrack(120, 16), SAMPLE_RATE);
    expect(analysis.beats.length).toBeGreaterThan(20);

    const intervals: number[] = [];
    for (let i = 1; i < analysis.beats.length; i++) {
      intervals.push(analysis.beats[i].time - analysis.beats[i - 1].time);
    }
    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    expect(mean).toBeCloseTo(0.5, 1);
  });

  it('4/4 の小節位置が 0..3 の循環になる', () => {
    const analysis = analyzeAudio(makeClickTrack(120, 16), SAMPLE_RATE);
    const indices = analysis.beats.slice(0, 8).map((b) => b.indexInBar);
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).toBe((indices[i - 1] + 1) % 4);
    }
  });

  it('周期が短すぎる場合は空配列を返す', () => {
    expect(trackBeats(new Float32Array(10), 0.0116, 120)).toEqual([]);
  });
});

describe('境界値', () => {
  it('無音の音源ではビート推定を行わず、警告を返す', () => {
    const analysis = analyzeAudio(new Float32Array(SAMPLE_RATE * 3), SAMPLE_RATE);
    expect(analysis.bpm).toBe(0);
    expect(analysis.beats).toEqual([]);
    expect(analysis.warnings.join()).toContain('無音');
  });

  it('極端に短い音源でもクラッシュしない', () => {
    const analysis = analyzeAudio(new Float32Array(64).fill(0.5), SAMPLE_RATE);
    expect(analysis.bpm).toBe(0);
    expect(analysis.warnings.length).toBeGreaterThan(0);
  });

  it('長さ0の音源でも例外を投げない', () => {
    const analysis = analyzeAudio(new Float32Array(0), SAMPLE_RATE);
    expect(analysis.duration).toBe(0);
    expect(analysis.sections).toEqual([]);
  });

  it('サンプリングレートが不正なら例外を投げる', () => {
    expect(() => analyzeAudio(new Float32Array(1024), 0)).toThrow(/sampleRate/);
  });

  it('波形サムネイルは常に指定解像度で返る', () => {
    const analysis = analyzeAudio(makeClickTrack(120, 4), SAMPLE_RATE, { waveformResolution: 300 });
    expect(analysis.waveform.length).toBe(300);
  });
});

describe('楽曲構造', () => {
  it('静かな区間と激しい区間を分割し、サビを高エネルギー側に置く', () => {
    // 前半: 低エネルギー / 後半: 高エネルギー＋高域を足した構成
    const quiet = makeClickTrack(120, 12);
    for (let i = 0; i < quiet.length; i++) quiet[i] *= 0.25;
    const loud = makeClickTrack(120, 12);
    for (let i = 0; i < loud.length; i++) {
      loud[i] += Math.sin((2 * Math.PI * 5000 * i) / SAMPLE_RATE) * 0.3;
    }
    const combined = new Float32Array(quiet.length + loud.length);
    combined.set(quiet, 0);
    combined.set(loud, quiet.length);

    const analysis = analyzeAudio(combined, SAMPLE_RATE);
    expect(analysis.sections.length).toBeGreaterThan(1);
    expect(analysis.hook).not.toBeNull();
    // サビは後半（高エネルギー側）に来るはず
    expect(analysis.hook!.start).toBeGreaterThan(6);
  });
});
