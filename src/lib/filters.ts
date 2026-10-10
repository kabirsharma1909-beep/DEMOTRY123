/**
 * Signal filters for cursor smoothing.
 * OneEuroFilter: low-lag adaptive filter by Géry Casiez et al.
 */

interface OneEuroConfig {
  minCutoff?: number;
  beta?: number;
  dCutoff?: number;
}

class LowPassFilter {
  private alpha = 1;
  private xPrev = 0;
  private initialized = false;

  filter(x: number, alpha: number): number {
    this.alpha = alpha;
    if (!this.initialized) { this.xPrev = x; this.initialized = true; }
    const result = alpha * x + (1 - alpha) * this.xPrev;
    this.xPrev = result;
    return result;
  }

  reset() { this.initialized = false; }
}

export class OneEuroFilter {
  private minCutoff: number;
  private beta: number;
  private dCutoff: number;
  private xFilter = new LowPassFilter();
  private dxFilter = new LowPassFilter();
  private lastTime = -1;
  private lastX = 0;

  constructor({ minCutoff = 1.0, beta = 0.007, dCutoff = 1.0 }: OneEuroConfig = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }

  filter(x: number, timestamp: number): number {
    const dt = this.lastTime < 0 ? 1 / 60 : Math.max((timestamp - this.lastTime) / 1000, 1e-5);
    this.lastTime = timestamp;

    const dxRaw = this.lastX === undefined ? 0 : (x - this.lastX) / dt;
    this.lastX = x;

    const alphaDx = this.alpha(this.dCutoff, dt);
    const dxEst = this.dxFilter.filter(dxRaw, alphaDx);

    const cutoff = this.minCutoff + this.beta * Math.abs(dxEst);
    const alphaX = this.alpha(cutoff, dt);
    return this.xFilter.filter(x, alphaX);
  }

  private alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  reset() {
    this.xFilter.reset();
    this.dxFilter.reset();
    this.lastTime = -1;
  }
}

/** Pair of OneEuroFilters for (x, y) coordinates. */
export class OneEuroFilter2D {
  private fx: OneEuroFilter;
  private fy: OneEuroFilter;

  constructor(config?: OneEuroConfig) {
    this.fx = new OneEuroFilter(config);
    this.fy = new OneEuroFilter(config);
  }

  filter(x: number, y: number, timestamp: number): [number, number] {
    return [this.fx.filter(x, timestamp), this.fy.filter(y, timestamp)];
  }

  reset() { this.fx.reset(); this.fy.reset(); }
}
