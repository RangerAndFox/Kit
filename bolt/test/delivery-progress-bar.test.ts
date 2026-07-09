import { describe, it, expect } from 'vitest'

import { progressBar } from '../../src/lib/delivery/progress-bar'

describe('progressBar', () => {
  it('renders an empty bar at 0%', () => {
    expect(progressBar(0, 10)).toBe('░░░░░░░░░░ 0%')
  })

  it('renders a full bar at 100%', () => {
    expect(progressBar(100, 10)).toBe('▓▓▓▓▓▓▓▓▓▓ 100%')
  })

  it('fills proportionally and labels the percent', () => {
    expect(progressBar(50, 10)).toBe('▓▓▓▓▓░░░░░ 50%')
  })

  it('clamps out-of-range and non-finite input', () => {
    expect(progressBar(150, 10)).toBe('▓▓▓▓▓▓▓▓▓▓ 100%')
    expect(progressBar(-5, 10)).toBe('░░░░░░░░░░ 0%')
    expect(progressBar(NaN, 10)).toBe('░░░░░░░░░░ 0%')
  })
})
