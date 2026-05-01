import { describe, expect, test } from "bun:test"

import type { Contest } from "../../src/domain/contest"
import { buildDigestMessage } from "../../src/services/contest-digest"

const contests: ReadonlyArray<Contest> = [
  {
    id: "cf-1",
    platform: "Codeforces",
    title: "Codeforces Round",
    url: "https://codeforces.com/contests/1",
    startAt: new Date("2026-05-01T12:00:00.000Z"),
    durationMinutes: 120,
    contestType: "CF"
  },
  {
    id: "at-1",
    platform: "AtCoder",
    title: "AtCoder Beginner Contest",
    url: "https://atcoder.jp/contests/abc456",
    startAt: new Date("2026-05-01T15:00:00.000Z"),
    durationMinutes: 100,
    ratedRange: "- 1999"
  }
]

describe("contest digest rendering", () => {
  test("selects next-day contests in Asia/Dhaka", () => {
    const digest = buildDigestMessage(
      contests,
      ["2026-05-01"],
      "Tomorrow's Contests",
      "Asia/Dhaka"
    )

    expect(digest.targetDateKey).toBe("2026-05-01")
    expect(digest.contests).toHaveLength(2)
    expect(digest.message).toContain("Tomorrow's Contests")
    expect(digest.message).toContain("Codeforces Round")
    expect(digest.message).toContain("AtCoder Beginner Contest")
  })

  test("renders an empty digest when no contests match", () => {
    const digest = buildDigestMessage([], ["2026-04-30"], "Today's Contests", "Asia/Dhaka")

    expect(digest.contests).toHaveLength(0)
    expect(digest.message).toContain("No contests found in this range.")
  })
})
