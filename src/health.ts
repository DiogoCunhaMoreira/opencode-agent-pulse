/**
 * Computes a 0-100 health score for a session based on heuristic signals.
 *
 * Weights:
 *   No errors           → +30  (partial if 1 error)
 *   No reverts          → +25
 *   Low retry count     → +15  (degrades per retry)
 *   Tool success rate   → +15
 *   Reasonable steps    → +15  (sweet spot 2-15)
 */

export interface SessionSignals {
  hasError: boolean
  errorCount: number
  wasReverted: boolean
  retries: number
  toolCalls: number
  toolErrors: number
  stepCount: number
}

export function computeHealthScore(s: SessionSignals): number {
  let score = 0

  if (!s.hasError) score += 30
  else if (s.errorCount === 1) score += 10

  if (!s.wasReverted) score += 25

  score += Math.max(0, 15 - s.retries * 5)

  if (s.toolCalls === 0) {
    score += 15
  } else {
    const successRate = (s.toolCalls - s.toolErrors) / s.toolCalls
    score += Math.round(successRate * 15)
  }

  if (s.stepCount >= 2 && s.stepCount <= 15) {
    score += 15
  } else if (s.stepCount === 1) {
    score += 10
  } else if (s.stepCount > 15 && s.stepCount <= 30) {
    score += 8
  }

  return Math.min(100, Math.max(0, score))
}
