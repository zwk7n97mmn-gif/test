/**
 * 依存ライブラリなしの基数2 反復FFT。
 * 解析パイプラインのホットパスなので、テーブルは生成時に一度だけ作って使い回す。
 */
export class FFT {
  readonly size: number;
  private readonly cosTable: Float32Array;
  private readonly sinTable: Float32Array;
  private readonly reverseTable: Uint32Array;

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) {
      throw new Error(`FFT size must be a power of two >= 2 (received ${size})`);
    }
    this.size = size;
    this.cosTable = new Float32Array(size / 2);
    this.sinTable = new Float32Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cosTable[i] = Math.cos((-2 * Math.PI * i) / size);
      this.sinTable[i] = Math.sin((-2 * Math.PI * i) / size);
    }
    this.reverseTable = new Uint32Array(size);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i++) {
      let rev = 0;
      for (let b = 0; b < bits; b++) {
        rev = (rev << 1) | ((i >>> b) & 1);
      }
      this.reverseTable[i] = rev;
    }
  }

  /** real/imag をその場で変換する。 */
  transform(real: Float32Array, imag: Float32Array): void {
    const n = this.size;
    if (real.length !== n || imag.length !== n) {
      throw new Error('FFT input length mismatch');
    }
    for (let i = 0; i < n; i++) {
      const j = this.reverseTable[i];
      if (j > i) {
        let tmp = real[i];
        real[i] = real[j];
        real[j] = tmp;
        tmp = imag[i];
        imag[i] = imag[j];
        imag[j] = tmp;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0, idx = 0; k < half; k++, idx += step) {
          const cos = this.cosTable[idx];
          const sin = this.sinTable[idx];
          const a = i + k;
          const b = a + half;
          const tre = real[b] * cos - imag[b] * sin;
          const tim = real[b] * sin + imag[b] * cos;
          real[b] = real[a] - tre;
          imag[b] = imag[a] - tim;
          real[a] += tre;
          imag[a] += tim;
        }
      }
    }
  }

  /** 実数入力の振幅スペクトル（0..size/2）を out に書き込む。 */
  magnitude(input: Float32Array, out: Float32Array, scratchRe: Float32Array, scratchIm: Float32Array): void {
    scratchRe.set(input);
    scratchIm.fill(0);
    this.transform(scratchRe, scratchIm);
    const bins = this.size / 2;
    for (let i = 0; i <= bins; i++) {
      out[i] = Math.hypot(scratchRe[i], scratchIm[i]);
    }
  }
}

/** 周期的Hann窓（STFT解析用）。 */
export function hannWindow(size: number): Float32Array {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  }
  return w;
}
