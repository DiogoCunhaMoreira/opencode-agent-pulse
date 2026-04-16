import { describe, it, expect } from "vitest"
import { computeHealthScore } from "../src/health"

describe("computeHealthScore", () => {
  it("returns 100 for a clean session", () => {
    expect(computeHealthScore({
      hasError: false, errorCount: 0, wasReverted: false,
      retries: 0, toolCalls: 10, toolErrors: 0, stepCount: 5,
    })).toBe(100)
  })

  it("penalises errors heavily", () => {
    const score = computeHealthScore({
      hasError: true, errorCount: 2, wasReverted: false,
      retries: 0, toolCalls: 10, toolErrors: 0, stepCount: 5,
    })
    expect(score).toBe(70)
  })

  it("gives partial credit for a single error", () => {
    const score = computeHealthScore({
      hasError: true, errorCount: 1, wasReverted: false,
      retries: 0, toolCalls: 10, toolErrors: 0, stepCount: 5,
    })
    expect(score).toBe(80)
  })

  it("penalises reverts", () => {
    const score = computeHealthScore({
      hasError: false, errorCount: 0, wasReverted: true,
      retries: 0, toolCalls: 10, toolErrors: 0, stepCount: 5,
    })
    expect(score).toBe(75)
  })

  it("degrades with retries", () => {
    const score = computeHealthScore({
      hasError: false, errorCount: 0, wasReverted: false,
      retries: 2, toolCalls: 10, toolErrors: 0, stepCount: 5,
    })
    expect(score).toBe(90)
  })

  it("penalises tool errors proportionally", () => {
    const score = computeHealthScore({
      hasError: false, errorCount: 0, wasReverted: false,
      retries: 0, toolCalls: 10, toolErrors: 5, stepCount: 5,
    })
    expect(score).toBe(93)
  })

  it("handles zero tool calls gracefully", () => {
    const score = computeHealthScore({
      hasError: false, errorCount: 0, wasReverted: false,
      retries: 0, toolCalls: 0, toolErrors: 0, stepCount: 5,
    })
    expect(score).toBe(100)
  })

  it("penalises too many steps", () => {
    const score = computeHealthScore({
      hasError: false, errorCount: 0, wasReverted: false,
      retries: 0, toolCalls: 10, toolErrors: 0, stepCount: 50,
    })
    expect(score).toBe(85)
  })

  it("gives partial credit for single step", () => {
    const score = computeHealthScore({
      hasError: false, errorCount: 0, wasReverted: false,
      retries: 0, toolCalls: 10, toolErrors: 0, stepCount: 1,
    })
    expect(score).toBe(95)
  })

  it("never goes below 0", () => {
    const score = computeHealthScore({
      hasError: true, errorCount: 10, wasReverted: true,
      retries: 10, toolCalls: 10, toolErrors: 10, stepCount: 100,
    })
    expect(score).toBe(0)
  })
})
