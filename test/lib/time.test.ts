import { describe, expect, test } from "bun:test"

import {
  computeDelayUntilNextRun,
  formatDateKeyInTimeZone,
  isDigestDue,
  parseAtCoderDate,
  parseDeliveryTime
} from "../../src/lib/time"

describe("time helpers", () => {
  test("formats date keys in Asia/Dhaka", () => {
    expect(
      formatDateKeyInTimeZone(new Date("2026-04-30T18:30:00.000Z"), "Asia/Dhaka")
    ).toBe("2026-05-01")
  })

  test("computes the same-day delay before the target time", () => {
    const now = new Date("2026-04-30T14:00:00.000Z")
    const delayMs = computeDelayUntilNextRun(now, "Asia/Dhaka", 21, 0)

    expect(delayMs).toBe(60 * 60 * 1000)
  })

  test("rolls to the next day after the target time", () => {
    const now = new Date("2026-04-30T16:00:00.000Z")
    const delayMs = computeDelayUntilNextRun(now, "Asia/Dhaka", 21, 0)

    expect(delayMs).toBe(23 * 60 * 60 * 1000)
  })

  test("parses AtCoder timestamps with numeric offsets", () => {
    expect(parseAtCoderDate("2026-05-02 21:00:00+0900").toISOString()).toBe(
      "2026-05-02T12:00:00.000Z"
    )
  })

  test("parses delivery time strings", () => {
    expect(parseDeliveryTime("21:05")).toEqual({ hour: 21, minute: 5 })
    expect(parseDeliveryTime("25:00")).toBeNull()
  })

  test("marks a digest due once the local scheduled time has passed", () => {
    expect(
      isDigestDue(new Date("2026-04-30T15:31:00.000Z"), "Asia/Dhaka", 21, 0)
    ).toBe(true)
    expect(
      isDigestDue(new Date("2026-04-30T14:59:00.000Z"), "Asia/Dhaka", 21, 0)
    ).toBe(false)
  })
})
