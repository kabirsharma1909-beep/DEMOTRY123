/**
 * Gesture classification engine.
 *
 * Combines MediaPipe GestureRecognizer output with a hand-coded fallback
 * classifier and a temporal state machine to suppress flickering.
 *
 * Root-cause fix: the original classifyGesture() never returned 'Closed fist'
 * from landmarks alone. Added explicit finger-curl detection.
 */

export type GestureName =
  | 'No hand'
  | 'Open palm'
  | 'Closed fist'
  | 'Thumbs up'
  | 'Two-finger point'
  | 'Index point';

interface Landmark { x: number; y: number; z: number }

function dist(a: Landmark, b: Landmark) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Checks whether a finger tip is "curled" relative to its base knuckle.
 * Works in normalized image coordinates — y increases downward.
 * For a right-handed palm facing the camera, curled = tip.y > pip.y (below the knuckle).
 * We add a small margin to make it robust to slight pitch.
 */
function isCurled(tip: Landmark, pip: Landmark, margin = 0.02): boolean {
  return tip.y > pip.y - margin;
}

/**
 * Landmark-based gesture classifier (fallback when MediaPipe confidence is low).
 */
export function classifyFromLandmarks(lm: Landmark[]): GestureName {
  if (lm.length < 21) return 'No hand';

  const wrist = lm[0];
  const thumbTip = lm[4], thumbIp = lm[3];
  const indexTip = lm[8], indexPip = lm[6];
  const middleTip = lm[12], middlePip = lm[10];
  const ringTip = lm[16], ringPip = lm[14];
  const pinkyTip = lm[20], pinkyPip = lm[18];

  const handScale = Math.max(dist(wrist, middleTip), 0.01);

  // Curled check per finger
  const indexCurled = isCurled(indexTip, indexPip);
  const middleCurled = isCurled(middleTip, middlePip);
  const ringCurled = isCurled(ringTip, ringPip);
  const pinkyCurled = isCurled(pinkyTip, pinkyPip);
  const thumbCurled = isCurled(thumbTip, thumbIp, 0.0);

  const curledCount = [indexCurled, middleCurled, ringCurled, pinkyCurled].filter(Boolean).length;

  // Closed fist: all four fingers curled
  if (curledCount >= 4) return 'Closed fist';

  // Open palm: all four fingers extended
  if (curledCount === 0) return 'Open palm';

  // Two-finger point (Victory): index + middle extended, ring + pinky curled
  if (!indexCurled && !middleCurled && ringCurled && pinkyCurled) return 'Two-finger point';

  // Index point: only index extended
  if (!indexCurled && middleCurled && ringCurled && pinkyCurled) return 'Index point';

  // Thumbs up: thumb extended upward, fingers curled
  if (curledCount >= 3 && !thumbCurled && thumbTip.y < wrist.y - handScale * 0.4) return 'Thumbs up';

  return 'No hand';
}

const MP_MAP: Record<string, GestureName> = {
  Closed_Fist: 'Closed fist',
  Open_Palm: 'Open palm',
  Thumb_Up: 'Thumbs up',
  Victory: 'Two-finger point',
  Pointing_Up: 'Index point',
};

/**
 * Merges MediaPipe category with landmark fallback.
 * Uses MediaPipe when confidence >= minConfidence, otherwise landmark fallback.
 */
export function resolveGesture(
  mpCategory: string | undefined,
  mpScore: number | undefined,
  landmarks: Landmark[],
  minConfidence = 0.6,
): GestureName {
  if (mpCategory && (mpScore ?? 0) >= minConfidence) {
    return MP_MAP[mpCategory] ?? classifyFromLandmarks(landmarks);
  }
  return classifyFromLandmarks(landmarks);
}

/**
 * Gesture state machine with temporal hysteresis.
 * Prevents flickering and requires a stable hold before confirming a gesture.
 */
export class GestureStateMachine {
  private candidate: GestureName = 'No hand';
  private candidateStartMs = 0;
  private confirmed: GestureName = 'No hand';
  private confirmedAt = 0;

  /** Minimum ms a candidate must hold before becoming confirmed */
  readonly CONFIRM_MS = 80;

  /**
   * Feed a raw frame classification. Returns the confirmed gesture.
   */
  update(raw: GestureName, nowMs: number): GestureName {
    if (raw !== this.candidate) {
      this.candidate = raw;
      this.candidateStartMs = nowMs;
    }

    const heldMs = nowMs - this.candidateStartMs;
    if (heldMs >= this.CONFIRM_MS && this.candidate !== this.confirmed) {
      this.confirmed = this.candidate;
      this.confirmedAt = nowMs;
    }
    return this.confirmed;
  }

  getConfirmedAt() { return this.confirmedAt; }
  reset() {
    this.candidate = 'No hand';
    this.confirmed = 'No hand';
    this.candidateStartMs = 0;
    this.confirmedAt = 0;
  }
}

/**
 * Click state machine.
 * Ensures: one click per fist hold, release required before next, cooldown.
 */
export class ClickStateMachine {
  private phase: 'idle' | 'charging' | 'fired' | 'cooldown' = 'idle';
  private phaseStart = 0;
  private chargeStart = 0;

  constructor(
    public chargeMs = 350,
    public cooldownMs = 500,
  ) {}

  /** Returns 'fire' when the click should be executed, null otherwise. */
  update(gesture: GestureName, nowMs: number): 'fire' | null {
    if (this.phase === 'cooldown') {
      if (nowMs - this.phaseStart >= this.cooldownMs) this.phase = 'idle';
      else return null;
    }

    if (gesture !== 'Closed fist') {
      // Reset charge when gesture releases
      if (this.phase === 'charging' || this.phase === 'idle') {
        this.phase = 'idle';
      }
      if (this.phase === 'fired') {
        // Hand opened after click — ready for next
        this.phase = 'idle';
      }
      return null;
    }

    // Gesture is 'Closed fist'
    if (this.phase === 'idle') {
      this.phase = 'charging';
      this.chargeStart = nowMs;
      this.phaseStart = nowMs;
    }

    if (this.phase === 'charging') {
      if (nowMs - this.chargeStart >= this.chargeMs) {
        this.phase = 'fired';
        this.phaseStart = nowMs;
        return 'fire';
      }
    }

    return null;
  }

  /** 0–1 charge progress, only meaningful in 'charging' phase */
  getCharge(nowMs: number): number {
    if (this.phase !== 'charging') return 0;
    return Math.min(1, (nowMs - this.chargeStart) / this.chargeMs);
  }

  getPhase() { return this.phase; }

  reset(chargeMs?: number, cooldownMs?: number) {
    this.phase = 'idle';
    if (chargeMs !== undefined) this.chargeMs = chargeMs;
    if (cooldownMs !== undefined) this.cooldownMs = cooldownMs;
  }
}

/**
 * Scroll state machine with continuous scrolling while gesture held.
 * Emits the first scroll as soon as the gesture is confirmed, then
 * repeats at intervalMs intervals.
 */
export class ScrollStateMachine {
  private active = false;
  private lastScrollMs = -Infinity;
  private confirmStart = 0;
  private confirmStarted = false;

  constructor(
    public confirmMs = 300,
    public intervalMs = 650,
  ) {}

  /** Returns 'up' | 'down' | null */
  update(gesture: GestureName, nowMs: number): 'up' | 'down' | null {
    const isScroll = gesture === 'Open palm' || gesture === 'Two-finger point';

    if (!isScroll) {
      this.active = false;
      this.confirmStarted = false;
      this.lastScrollMs = -Infinity;
      return null;
    }

    if (!this.active) {
      if (!this.confirmStarted) {
        this.confirmStart = nowMs;
        this.confirmStarted = true;
      }
      if (nowMs - this.confirmStart < this.confirmMs) return null;
      // Gesture confirmed — emit first scroll immediately
      this.active = true;
      this.lastScrollMs = nowMs;
      return gesture === 'Open palm' ? 'down' : 'up';
    }

    if (nowMs - this.lastScrollMs >= this.intervalMs) {
      this.lastScrollMs = nowMs;
      return gesture === 'Open palm' ? 'down' : 'up';
    }
    return null;
  }

  reset() {
    this.active = false;
    this.confirmStarted = false;
    this.lastScrollMs = -Infinity;
  }
}
