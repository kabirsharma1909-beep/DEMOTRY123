/**
 * Dwell-to-click engine.
 *
 * Tracks whether the cursor has remained sufficiently stable over a target
 * element for the configured dwell duration, then fires one click.
 * Resets on movement, target change, or explicit cancel.
 */

export interface DwellState {
  phase: 'idle' | 'dwelling' | 'cooldown';
  progress: number; // 0–1
  targetKey: string | null;
}

export class DwellEngine {
  private phase: 'idle' | 'dwelling' | 'cooldown' = 'idle';
  private dwellStart = 0;
  private cooldownStart = 0;
  private anchorX = 0;
  private anchorY = 0;
  private currentTarget: string | null = null;

  constructor(
    public dwellMs = 2000,
    public cooldownMs = 1000,
    /** Max movement in normalized [0,1] units before reset */
    public stabilityRadius = 0.06,
  ) {}

  /**
   * Feed the current cursor position and element key each frame.
   * @param x Normalized cursor x [0, 1]
   * @param y Normalized cursor y [0, 1]
   * @param targetKey Identifier for the element under cursor (e.g. `tagName+textContent`)
   * @param nowMs Current timestamp
   * @returns true when click should fire
   */
  update(x: number, y: number, targetKey: string | null, nowMs: number): boolean {
    if (this.phase === 'cooldown') {
      if (nowMs - this.cooldownStart >= this.cooldownMs) {
        this.phase = 'idle';
        this.currentTarget = null;
      } else {
        return false;
      }
    }

    const moved = Math.hypot(x - this.anchorX, y - this.anchorY) > this.stabilityRadius;
    const targetChanged = targetKey !== this.currentTarget;

    if (moved || targetChanged || !targetKey) {
      this.phase = 'idle';
      this.anchorX = x;
      this.anchorY = y;
      this.currentTarget = targetKey;
      this.dwellStart = nowMs;
      return false;
    }

    if (this.phase === 'idle') {
      this.dwellStart = nowMs;
      this.phase = 'dwelling';
    }

    if (this.phase === 'dwelling') {
      if (nowMs - this.dwellStart >= this.dwellMs) {
        this.phase = 'cooldown';
        this.cooldownStart = nowMs;
        return true;
      }
    }

    return false;
  }

  getState(nowMs: number): DwellState {
    return {
      phase: this.phase,
      progress: this.phase === 'dwelling'
        ? Math.min(1, (nowMs - this.dwellStart) / this.dwellMs)
        : 0,
      targetKey: this.currentTarget,
    };
  }

  cancel() {
    this.phase = 'idle';
    this.currentTarget = null;
    this.dwellStart = 0;
  }

  configure(dwellMs: number, cooldownMs: number, stabilityRadius: number) {
    this.dwellMs = dwellMs;
    this.cooldownMs = cooldownMs;
    this.stabilityRadius = stabilityRadius;
  }
}
