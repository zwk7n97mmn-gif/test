/**
 * タイムライン再生エンジン。
 *
 * enabled なクリップを順に連結して 1 本の動画として再生し、canvas へ字幕込みで描画する。
 * クリップは素材（動画・画像）をまたぐため、素材ごとの要素を切り替えながら進む。
 * プレビューと書き出しは同じ描画・音声プラン生成コードを共有する。
 */

import { layoutClips, projectCuesToTimeline, timelineDuration, timelineToSource } from '../core/autoedit.js';
import { buildAudioPlan, evaluateAutomation, fadeGainAt } from '../core/audio.js';
import { findAsset } from '../core/assets.js';
import { resolveOutputSize } from '../core/layout.js';
import { assetAnalysis } from '../core/project.js';
import { cueAt } from '../core/subtitles.js';
import { clamp, dbToGain } from '../core/util.js';
import { drawSubtitle, drawVideoFrame } from './render.js';

const EPS = 0.02;

export class TimelinePlayer {
  /**
   * @param {{canvas:HTMLCanvasElement, audioContext:AudioContext, runtime:object,
   *          destination?:AudioNode, getProject:()=>object,
   *          onTime?:(t:number, total:number)=>void, onEnded?:()=>void, onError?:(e:Error)=>void}} opt
   */
  constructor(opt) {
    this.canvas = opt.canvas;
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    this.audioContext = opt.audioContext;
    this.runtime = opt.runtime;
    this.getProject = opt.getProject;
    this.onTime = opt.onTime;
    this.onEnded = opt.onEnded;
    this.onError = opt.onError;

    this.playing = false;
    this.timelineTime = 0;
    this.clipIndex = 0;
    this.seeking = false;
    this.rafId = null;
    this.lastTick = 0;
    this.bgmBuffer = null;
    this.bgmSource = null;
    this.plan = null;
    /** 要素 → MediaElementAudioSourceNode（要素ごとに 1 つしか作れない） */
    this.mediaSources = new Map();

    const ctx = this.audioContext;
    this.destination = opt.destination || ctx.destination;
    this.voiceGain = ctx.createGain();
    this.bgmGain = ctx.createGain();
    this.masterGain = ctx.createGain();
    this.voiceGain.connect(this.masterGain);
    this.bgmGain.connect(this.masterGain);
    this.masterGain.connect(this.destination);
  }

  get duration() {
    return timelineDuration(this.getProject().clips);
  }

  /** 出力サイズ（縦動画などの指定を反映） */
  outputSize() {
    const project = this.getProject();
    return resolveOutputSize(project.output, project.media || { width: 1280, height: 720 });
  }

  /** canvas を出力サイズへ合わせる */
  syncCanvasSize() {
    const { width, height } = this.outputSize();
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    return { width, height };
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
    // 発話区間を素材ごとに集め、タイムライン時刻へ写像する
    const speechCues = [];
    for (const asset of project.assets || []) {
      const speech = assetAnalysis(project, asset.id).speech || [];
      speech.forEach((seg, i) => speechCues.push({ id: `sp_${asset.id}_${i}`, assetId: asset.id, ...seg }));
    }
    const speechTimeline = projectCuesToTimeline(speechCues, project.clips);
    const loudness = this.primaryLoudness(project);
    this.plan = buildAudioPlan(project.audio, loudness, speechTimeline, total);
    return this.plan;
  }

  /** 代表的なラウドネス（音声を持つ素材の平均） */
  primaryLoudness(project) {
    const values = [];
    for (const asset of project.assets || []) {
      if (asset.kind !== 'video' || !asset.hasAudio) continue;
      const analysis = assetAnalysis(project, asset.id);
      if (analysis.loudness && analysis.loudness.integratedDb > -60) values.push(analysis.loudness);
    }
    if (!values.length) return { integratedDb: -70, peakDb: -100, noiseFloorDb: -100 };
    return {
      integratedDb: values.reduce((s, v) => s + v.integratedDb, 0) / values.length,
      peakDb: Math.max(...values.map((v) => v.peakDb)),
      noiseFloorDb: Math.min(...values.map((v) => v.noiseFloorDb)),
    };
  }

  /** 現在のクリップが指す素材と要素 */
  currentSource() {
    const project = this.getProject();
    const laid = layoutClips(project.clips);
    const clip = laid[Math.min(this.clipIndex, Math.max(0, laid.length - 1))];
    if (!clip) return { clip: null, asset: null, element: null };
    const asset = findAsset(project.assets, clip.assetId);
    return { clip, asset, element: this.runtime?.element(clip.assetId) || null };
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
    this.lastTick = performance.now();
    const { asset, element } = this.currentSource();
    if (asset?.kind === 'video' && element) {
      const ok = await this.startVideo(element);
      if (!ok) {
        this.playing = false;
        return;
      }
    }
    this.startBgm(this.timelineTime);
    this.loop();
  }

  /** 動画要素を再生し、音声グラフへ接続する */
  async startVideo(element) {
    this.connectAudio(element);
    try {
      await element.play();
      return true;
    } catch {
      this.onError?.(new Error('再生を開始できませんでした。もう一度操作してください。'));
      return false;
    }
  }

  /** 要素ごとに 1 度だけ MediaElementSource を作る */
  connectAudio(element) {
    if (!(element instanceof HTMLVideoElement) || this.mediaSources.has(element)) return;
    try {
      const node = this.audioContext.createMediaElementSource(element);
      node.connect(this.voiceGain);
      this.mediaSources.set(element, node);
    } catch {
      // 既に接続済みの要素（別インスタンスが掴んでいる）は音が出ないだけで再生は続ける
      this.mediaSources.set(element, null);
    }
  }

  /** 現在のクリップ以外の動画を止める */
  pauseOthers(exceptElement) {
    for (const id of this.runtime?.ids() || []) {
      const element = this.runtime.element(id);
      if (element instanceof HTMLVideoElement && element !== exceptElement && !element.paused) {
        element.pause();
      }
    }
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    const { element } = this.currentSource();
    if (element instanceof HTMLVideoElement) element.pause();
    this.pauseOthers(null);
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
    const asset = findAsset(project.assets, mapped.assetId);
    const element = this.runtime?.element(mapped.assetId);

    this.seeking = true;
    if (asset?.kind === 'video' && element) {
      element.playbackRate = clamp(mapped.clip.speed || 1, 0.25, 8);
      this.pauseOthers(element);
      await this.setVideoTime(element, mapped.sourceTime);
      if (this.playing) await this.startVideo(element);
    } else {
      this.pauseOthers(null);
    }
    this.seeking = false;
    this.lastTick = performance.now();

    if (this.playing && this.bgmBuffer && !keepPlaying) {
      this.stopBgm();
      this.startBgm(t);
    }
    this.renderFrame();
    this.onTime?.(this.timelineTime, total);
  }

  setVideoTime(element, time) {
    return new Promise((resolve) => {
      if (Math.abs(element.currentTime - time) < 0.001) {
        resolve();
        return;
      }
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        element.removeEventListener('seeked', done);
        resolve();
      };
      const timer = setTimeout(done, 3000);
      element.addEventListener('seeked', done, { once: true });
      try {
        element.currentTime = time;
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
    const now = performance.now();
    const dt = Math.min(0.25, Math.max(0, (now - this.lastTick) / 1000));
    this.lastTick = now;

    const clip = laid[Math.min(this.clipIndex, laid.length - 1)];
    const asset = findAsset(project.assets, clip.assetId);
    const element = this.runtime?.element(clip.assetId);

    if (!this.seeking) {
      if (asset?.kind === 'video' && element) {
        // 動画は要素の時刻を正とする（音とのずれが出ないため）
        const source = element.currentTime;
        if (source >= clip.end - EPS) {
          this.advanceClip(laid, clip);
          return;
        }
        this.timelineTime = clip.timelineStart + Math.max(0, source - clip.start) / (clip.speed || 1);
      } else {
        // 画像には時計が無いので実時間で進める
        this.timelineTime += dt;
        if (this.timelineTime >= clip.timelineEnd - EPS) {
          this.advanceClip(laid, clip);
          return;
        }
      }
    }
    this.applyGains();
    this.renderFrame();
    this.onTime?.(this.timelineTime, timelineDuration(project.clips));
  }

  /** 次のクリップへ進む（無ければ終了） */
  advanceClip(laid, clip) {
    const next = laid[this.clipIndex + 1];
    if (!next) {
      this.timelineTime = clip.timelineEnd;
      this.finish();
      return;
    }
    this.clipIndex += 1;
    this.timelineTime = next.timelineStart;
    this.seeking = true;
    const project = this.getProject();
    const asset = findAsset(project.assets, next.assetId);
    const element = this.runtime?.element(next.assetId);
    if (asset?.kind === 'video' && element) {
      element.playbackRate = clamp(next.speed || 1, 0.25, 8);
      this.pauseOthers(element);
      this.setVideoTime(element, next.start).then(async () => {
        if (this.playing) await this.startVideo(element);
        this.seeking = false;
        this.lastTick = performance.now();
      });
    } else {
      this.pauseOthers(null);
      this.seeking = false;
      this.lastTick = performance.now();
    }
  }

  finish() {
    this.playing = false;
    const { element } = this.currentSource();
    if (element instanceof HTMLVideoElement) element.pause();
    this.pauseOthers(null);
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
    const { width, height } = this.syncCanvasSize();
    const { element } = this.currentSource();

    drawVideoFrame(this.ctx, element, width, height, {
      fit: project.output?.fit,
      background: project.output?.background,
    });

    const cues = projectCuesToTimeline(project.subtitles, project.clips);
    const cue = cueAt(cues, this.timelineTime);
    if (cue && !cue.needsText) drawSubtitle(this.ctx, cue, project.subtitleStyle, width, height);
  }

  dispose() {
    this.pause();
    this.stopLoop();
    try {
      for (const node of this.mediaSources.values()) node?.disconnect();
      this.mediaSources.clear();
      this.voiceGain.disconnect();
      this.bgmGain.disconnect();
      this.masterGain.disconnect();
    } catch {
      /* 破棄時の例外は無視 */
    }
  }
}
