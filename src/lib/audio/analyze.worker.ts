/// <reference lib="webworker" />
import { analyzeAudio } from './analyze';
import type { AnalyzeOptions, AudioAnalysis } from './types';

export interface AnalyzeRequest {
  type: 'analyze';
  samples: Float32Array;
  sampleRate: number;
  options?: AnalyzeOptions;
}

export type AnalyzeResponse =
  | { type: 'progress'; phase: string; ratio: number }
  | { type: 'result'; analysis: AudioAnalysis }
  | { type: 'error'; message: string };

self.onmessage = (event: MessageEvent<AnalyzeRequest>) => {
  const data = event.data;
  if (data?.type !== 'analyze') return;
  try {
    const analysis = analyzeAudio(data.samples, data.sampleRate, data.options, (phase, ratio) => {
      const message: AnalyzeResponse = { type: 'progress', phase, ratio };
      self.postMessage(message);
    });
    const message: AnalyzeResponse = { type: 'result', analysis };
    self.postMessage(message);
  } catch (err) {
    const message: AnalyzeResponse = {
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(message);
  }
};
