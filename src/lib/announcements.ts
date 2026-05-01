import type { SchedulerTrackedHandle } from "../domain/bot-state"

export const buildTrackingAnnouncement = (
  trackedHandle: SchedulerTrackedHandle,
  nextRating: number,
  nextRank: string | null,
  previousRating?: number | null
): string => {
  const platform = trackedHandle.platform === "codeforces" ? "codeforces" : "atcoder"
  const profileUrl = trackedHandle.platform === "codeforces"
    ? `https://codeforces.com/profile/${encodeURIComponent(trackedHandle.handle)}`
    : `https://atcoder.jp/users/${encodeURIComponent(trackedHandle.handle)}`
  const delta = previousRating != null ? nextRating - previousRating : null
  const rank = nextRank ? `  —  ${nextRank}` : ""
  const deltaLine = delta != null
    ? `> up **${delta}** points  ·  now at **${nextRating}**${rank}`
    : `> now at **${nextRating}**${rank}`
  return [
    `<@${trackedHandle.handleCreatedByUserId}>`,
    `## [${trackedHandle.handle}](<${profileUrl}>) just improved on ${platform}`,
    deltaLine
  ].join("\n")
}
