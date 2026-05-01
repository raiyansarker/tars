import type { RatingSnapshot, TrackedProfile } from "../domain/bot-state"

export const normalizeHandle = (handle: string): string => handle.trim().toLowerCase()

/** Escape markdown special chars in user-provided strings (handles, titles). */
export const escMd = (text: string): string => text.replace(/[_*~`|]/g, "\\$&")

export const isProfileUnchanged = (
  previous: RatingSnapshot | null,
  profile: TrackedProfile
): boolean => {
  if (!previous) {
    return false
  }

  return (
    previous.rating === profile.rating &&
    previous.rankLabel === profile.rankLabel &&
    previous.maxRating === profile.maxRating
  )
}

export const isProfileImproved = (
  previous: RatingSnapshot | null,
  profile: TrackedProfile
): boolean => {
  if (!previous) {
    return false
  }

  if (previous.rating !== null && profile.rating !== null) {
    return profile.rating > previous.rating
  }

  if (previous.maxRating !== null && profile.maxRating !== null) {
    return profile.maxRating > previous.maxRating
  }

  return false
}

export const formatTrackedProfileSummary = (profile: TrackedProfile): string => {
  const ratingText = profile.rating === null ? "Unrated" : String(profile.rating)
  const rankText = profile.rankLabel ? ` (${profile.rankLabel})` : ""
  const maxText =
    profile.maxRating === null ? "" : ` | max ${profile.maxRating}`

  return `${profile.handle}: ${ratingText}${rankText}${maxText}`
}
