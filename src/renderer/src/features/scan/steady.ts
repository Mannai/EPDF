import type { Quad } from '@shared/features/scan/geometry'

/**
 * Decides when a page held in front of a camera is "steady" enough to capture automatically: the detected corners
 * must stay within `tolerance` (fraction of the frame) for `frames` consecutive detections. After a capture the
 * tracker disarms until the page leaves the view or moves clearly, so one page is never captured twice.
 */

export interface SteadyOptions {
  frames?: number
  tolerance?: number
  /** Movement (fraction of the frame) after a capture that counts as "a different page". */
  moveAway?: number
  /** Minimum time between captures. */
  cooldownMs?: number
}

const maxCornerDelta = (a: Quad, b: Quad): number => {
  let m = 0
  for (let i = 0; i < 4; i++) m = Math.max(m, Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y))
  return m
}

export class SteadyTracker {
  private readonly frames: number
  private readonly tolerance: number
  private readonly moveAway: number
  private readonly cooldownMs: number
  private anchor: Quad | null = null
  private count = 0
  private armed = true
  private firedQuad: Quad | null = null
  private firedAt = -Infinity
  private missing = 0

  constructor(o: SteadyOptions = {}) {
    this.frames = o.frames ?? 5
    this.tolerance = o.tolerance ?? 0.015
    this.moveAway = o.moveAway ?? 0.06
    this.cooldownMs = o.cooldownMs ?? 2000
  }

  /** Feed one detection (null = no page found). `fire` is true exactly when a capture should happen now. */
  update(quad: Quad | null, nowMs: number): { steady: boolean; fire: boolean } {
    if (!quad) {
      this.anchor = null
      this.count = 0
      if (++this.missing >= 2) this.armed = true
      return { steady: false, fire: false }
    }
    this.missing = 0
    if (!this.armed && this.firedQuad && maxCornerDelta(quad, this.firedQuad) > this.moveAway && nowMs - this.firedAt >= this.cooldownMs) this.armed = true
    if (this.anchor && maxCornerDelta(quad, this.anchor) <= this.tolerance) this.count++
    else {
      this.anchor = quad
      this.count = 1
    }
    const steady = this.count >= this.frames
    if (steady && this.armed && nowMs - this.firedAt >= this.cooldownMs) {
      this.armed = false
      this.firedQuad = quad
      this.firedAt = nowMs
      this.count = 0
      this.anchor = null
      return { steady: true, fire: true }
    }
    return { steady, fire: false }
  }

  reset(): void {
    this.anchor = null
    this.count = 0
    this.armed = true
    this.firedQuad = null
    this.missing = 0
  }
}
