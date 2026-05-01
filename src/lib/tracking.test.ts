import { expect, test, describe } from "bun:test"
import { isProfileImproved, isProfileUnchanged, normalizeHandle } from "./tracking"
import type { RatingSnapshot, TrackedProfile } from "../domain/bot-state"

describe("tracking logic", () => {
  const mockDate = new Date()

  test("normalizes handles by trimming and lowercasing", () => {
    expect(normalizeHandle("  SomeHandle ")).toBe("somehandle")
  })

  test("detects unchanged profile correctly", () => {
    const previous: RatingSnapshot = {
      id: "snapshot-1",
      trackedHandleId: "track-1",
      rating: 1500,
      maxRating: 1500,
      rankLabel: "Expert",
      isImprovement: false,
      capturedAt: mockDate,
      rawPayloadJson: {}
    }

    const profile: TrackedProfile = {
      platform: "codeforces",
      handle: "SomeHandle",
      handleNormalized: "somehandle",
      profileUrl: "http://example.com",
      rating: 1500,
      maxRating: 1500,
      rankLabel: "Expert",
      rawPayload: {}
    }

    expect(isProfileUnchanged(previous, profile)).toBe(true)

    // Should return false if rating changes
    expect(isProfileUnchanged(previous, { ...profile, rating: 1501 })).toBe(false)
  })

  test("detects profile improvement correctly", () => {
    const previous: RatingSnapshot = {
      id: "snapshot-1",
      trackedHandleId: "track-1",
      rating: 1500,
      maxRating: 1500,
      rankLabel: "Expert",
      isImprovement: false,
      capturedAt: mockDate,
      rawPayloadJson: {}
    }

    const profile: TrackedProfile = {
      platform: "codeforces",
      handle: "SomeHandle",
      handleNormalized: "somehandle",
      profileUrl: "http://example.com",
      rating: 1600,
      maxRating: 1600,
      rankLabel: "Candidate Master",
      rawPayload: {}
    }

    // Improvement detected (1600 > 1500)
    expect(isProfileImproved(previous, profile)).toBe(true)

    // No improvement if new rating is lower or equal
    expect(isProfileImproved(previous, { ...profile, rating: 1500 })).toBe(false)
    expect(isProfileImproved(previous, { ...profile, rating: 1400 })).toBe(false)

    // Improvement by max rating if current rating didn't go up but max did?
    // Wait, the logic says: if rating is present, it returns profile.rating > previous.rating.
    // Let's test that logic.
    expect(isProfileImproved(
      { ...previous, rating: null, maxRating: 1500 },
      { ...profile, rating: null, maxRating: 1600 }
    )).toBe(true)
  })
})
