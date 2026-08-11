/**
 * タイムライン再生エンジン。
 * enabled なクリップを連結して 1 本の動画として再生し、canvas へ字幕込みで描画する。
 * プレビューと書き出しの双方がこのクラスを使う（destination を差し替えるだけ）。
 */

import { layoutClips, projectCuesToTimeline, timelineDuration, timelineToSource } from '../core/autoedit.js';
import { buildAudioPlan, evaluateAutomation, fadeGainAt } from '../core/audio.js';
import { cueAt } from '../core/subtitles.js';
import { clamp, dbToGain } from '../core/util.js';
import { drawSubtitle, drawVideoFrame } from './render.js';

const EPS = 0.02;

export class TimelinePlayer {
  /**
   * @param {{video:HTMLVideoElement, canvas:HTMLCanvasElement, audioContext:AudioContext,
   *          destination?:AudioNode, getProject:()=>object,
   *          onTime?:(t:number, total:number)=>void, onEnded?:()=>void, onError?:(e:Error)=>void}} opt
   */
  constructor(opt) {
    this.video = opt.video;
    this.canvas = opt.canvas;
    this.ctx = this.canvas.getContext('2d');
    this.audioContext = opt.audioContext;
    this.getProject = opt.getProject;
    this.onTime = opt.onTime;
    this.onEnded = opt.onEnded;
    this.onError = opt.onError;

    this.playing = false;
    this.timelineTime = 0;
    this.clipIndex = 0;
    this.seeking = false;
    this.rafId = null;
    this.bgmBuffer = null;
    this.bgmSource = null;
    this.plan = null;

    const ctx = this.audioContext;
    this.destination = opt.destination || ctx.destination;
    this.voiceGain = ctx.createGain();
    this.bgmGain = ctx.createGain();
    this.masterGain = ctx.createGain();
    this.voiceGain.connect(this.masterGain);
    this.bgmGain.connect(this.masterGain);
    this.masterGain.connect(this.destination);

    try {
      this.mediaSource = ctx.createMediaElementSource(this.video);
      this.mediaSource.connect(this.voiceGain);
    } catch {
      // 既に接続済みの要素は再利用できない。呼び出し側で 1 インスタンスに保つこと。
      this.onError?.(new Error('この動画要素は既に音声グラフへ接続されています。'));
    }
  }

  /** 総尺（タイムライン秒） */
  get duration() {
    return timelineDuration(this.getProject().clips);
  }

  setBgmBuffer(buffer) {
    this.bgmBuffer = buffer || null;
    if (this.playing) {
      this.stopBgm();
      this.startBgm(this.timelineTime);
    }
  }

  /** 音声プランを再計算する（クリップ・音声設定の変更時に呼ぶ） */
  refreshPlan() {
    const project = this.getProject();
    const total = timelineDuration(project.clips);
    const speechTimeline = projectCuesToTimeline(
      project.analysis.speech.map((s, i) => ({ id: `sp${i}`, ...s })),
      project.clips,
    );
    this.plan = buildAudioPlan(project.audio, project.analysis.loudness, speechTimeline, total);
    return this.plan;
  }

  async play() {
    if (this.playing) return;
    const total = this.duration;
    if (total <= 0) return;
    if (this.timelineTime >= total - EPS) this.timelineTime = 0;
    this.refreshPlan();
    if (this.audioContext.state === 'suspended') await this.audioContext.resume();
    await this.seek(this.timelineTime, { keepPlaying: true });
    this.playing = true;
    try {
      await this.video.play();
    } catch {
      this.playing = false;
      this.onError?.(new Error('再生を開始できませんでした。もう一度操作してください。'));
      return;
    }
    this.startBgm(this.timelineTime);
    this.loop();
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.video.pause();
    this.stopBgm();
    this.stopLoop();
    this.renderFrame();
  }

  stop() {
    this.pause();
    this.timelineTime = 0;
    this.clipIndex = 0;
  }

  /** タイムライン時刻へシーク */
  async seek(timelineTime, { keepPlaying = false } = {}) {
    const project = this.getProject();
    const total = timelineDuration(project.clips);
    const t = clamp(timelineTime, 0, Math.max(0, total));
    this.timelineTime = t;
    const mapped = timelineToSource(project.clips, t);
    if (!mapped) {
      this.renderFrame();
      return;
    }
    this.clipIndex = mapped.clipIndex;
    this.video.playbackRate = clamp(mapped.clip.speed || 1, 0.25, 8);
    this.seeking = true;
    await this.setVideoTime(mapped.sourceTime);
    this.seeking = false;
    if (this.playing && this.bgmBuffer && !keepPlaying) {
      this.stopBgm();
      this.startBgm(t);
    }
    this.renderFrame();
    this.onTime?.(this.timelineTime, total);
  }

  setVideoTime(time) {
    return new Promise((resolve) => {
      if (Math.abs(this.video.currentTime - time) < 0.001) {
        resolve();
        return;
      }
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.video.removeEventListener('seeked', done);
        resolve();
      };
      const timer = setTimeout(done, 3000);
      this.video.addEventListener('seeked', done, { once: true });
      try {
        this.video.currentTime = time;
      } catch {
        done();
      }
    });
  }

  loop() {
    this.stopLoop();
    const tick = () => {
      if (!this.playing) return;
      this.step();
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  stopLoop() {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  step() {
    const project = this.getProject();
    const laid = layoutClips(project.clips);
    if (!laid.length) {
      this.pause();
      return;
    }
    const clip = laid[Math.min(this.clipIndex, laid.length - 1)];
    if (!this.seeking) {
      const source = this.video.currentTime;
      if (source >= clip.end - EPS) {
        const next = laid[this.clipIndex + 1];
        if (!next) {
          this.timelineTime = clip.timelineEnd;
          this.finish();
          return;
        }
        this.clipIndex += 1;
        this.timelineTime = next.timelineStart;
        this.seeking = true;
        this.video.playbackRate = clamp(next.speed || 1, 0.25, 8);
        this.setVideoTime(next.start).then(() => {
          this.seeking = false;
        });
      } else {
        this.timelineTime = clip.timelineStart + Math.max(0, source - clip.start) / (clip.speed || 1);
      }
    }
    this.applyGains();
    this.renderFrame();
    this.onTime?.(this.timelineTime, timelineDuration(project.clips));
  }

  finish() {
    this.playing = false;
    this.video.pause();
    this.stopBgm();
    this.stopLoop();
    this.renderFrame();
    this.onEnded?.();
  }

  applyGains() {
    const project = this.getProject();
    const plan = this.plan || this.refreshPlan();
    const total = timelineDuration(project.clips);
    const fade = fadeGainAt(this.timelineTime, total, plan.fadeIn, plan.fadeOut);
    const now = this.audioContext.currentTime;
    this.voiceGain.gain.setTargetAtTime(dbToGain(plan.normalizeGainDb), now, 0.01);
    this.masterGain.gain.setTargetAtTime(fade, now, 0.01);
    const duck = plan.duck ? evaluateAutomation(plan.duckAutomation, this.timelineTime) : 1;
    this.bgmGain.gain.setTargetAtTime(dbToGain(plan.bgmGainDb) * duck * fade, now, 0.02);
  }

  startBgm(fromTimelineTime) {
    if (!this.bgmBuffer) return;
    this.stopBgm();
    const source = this.audioContext.createBufferSource();
    source.buffer = this.bgmBuffer;
    source.loop = true;
    source.connect(this.bgmGain);
    const offset = this.bgmBuffer.duration > 0 ? fromTimelineTime % this.bgmBuffer.duration : 0;
    source.start(this.audioContext.currentTime, offset);
    this.bgmSource = source;
  }

  stopBgm() {
    if (!this.bgmSource) return;
    try {
      this.bgmSource.stop();
    } catch {
      /* 既に停止済み */
    }
    this.bgmSource.disconnect();
    this.bgmSource = null;
  }

  /** 現在時刻のフレームを canvas へ描画する */
  renderFrame() {
    const project = this.getProject();
    const { width, height } = this.canvas;
    drawVideoFrame(this.ctx, this.video, width, height);
    const cues = projectCuesToTimeline(project.subtitles, project.clips);
    const cue = cueAt(cues, this.timelineTime);
    if (cue && !cue.needsText) drawSubtitle(this.ctx, cue, project.subtitleStyle, width, height);
  }

  dispose() {
    this.pause();
    this.stopLoop();
    try {
      this.mediaSource?.disconnect();
      this.voiceGain.disconnect();
      this.bgmGain.disconnect();
      this.masterGain.disconnect();
    } catch {
      /* 破棄時の例外は無視 */
    }
  }
}
