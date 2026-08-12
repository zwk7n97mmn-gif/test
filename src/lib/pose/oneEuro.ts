/**
 * 1€ Filter (Casiez et al. 2012)。
 * 姿勢推定のジッタを、速い動きの追従性を犠牲にせずに落とすために使う。
 */
export class OneEuroFilter {
  private prevValue: number | null = null;
  private prevDerivative = 0;
  private prevTime: number | null = null;

  constructor(
    private readonly minCutoff = 1.0,
    private readonly beta = 0.007,
    private readonly dCutoff = 1.0,
  ) {}

  filter(value: number, timestamp: number): number {
    if (!Number.isFinite(value)) return this.prevValue ?? 0;

    if (this.prevValue === null || this.prevTime === null) {
      this.prevValue = value;
      this.prevTime = timestamp;
      return value;
    }
    const dt = timestamp - this.prevTime;
    if (dt <= 0) return this.prevValue;
    const rate = 1 / dt;

    const derivative = (value - this.prevValue) * rate;
    const alphaD = smoothingFactor(rate, this.dCutoff);
    const smoothedDerivative = alphaD * derivative + (1 - alphaD) * this.prevDerivative;

    const cutoff = this.minCutoff + this.beta * Math.abs(smoothedDerivative);
    const alpha = smoothingFactor(rate, cutoff);
    const smoothed = alpha * value + (1 - alpha) * this.prevValue;

    this.prevValue = smoothed;
    this.prevDerivative = smoothedDerivative;
    this.prevTime = timestamp;
    return smoothed;
  }

  reset(): void {
    this.prevValue = null;
    this.prevDerivative = 0;
    this.prevTime = null;
  }
}

function smoothingFactor(rate: number, cutoff: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  const dt = 1 / rate;
  return 1 / (1 + tau / dt);
}

/** 多次元ベクトル列をまとめて平滑化するヘルパ。 */
export class VectorOneEuro {
  private readonly filters: OneEuroFilter[];

  constructor(dimension: number, minCutoff = 1.0, beta = 0.007, dCutoff = 1.0) {
    this.filters = Array.from({ length: dimension }, () => new OneEuroFilter(minCutoff, beta, dCutoff));
  }

  filter(values: Float32Array, timestamp: number, out?: Float32Array): Float32Array {
    const result = out ?? new Float32Array(values.length);
    for (let i = 0; i < values.length; i++) {
      result[i] = this.filters[i].filter(values[i], timestamp);
    }
    return result;
  }

  reset(): void {
    for (const f of this.filters) f.reset();
  }
}
